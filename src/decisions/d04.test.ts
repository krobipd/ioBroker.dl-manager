// Core decision D-04 (accepted 2026-11-19, page version 13): every download has a datapoint of its own to remove it.
// Removing takes the download out of the program's list. Whether its files are deleted too, a switch in the admin
// decides, "Also delete the files when removing". The question exists in general or for each program on its own: while
// it is on in general, no program can choose; while it is off in general, each program chooses. Deleted is everything
// the program loaded to disk for this download: of a finished download the finished files, of an aborted or failed one
// what was loaded until then. The datapoints are not part of it, the other switch settles them. After the update and on
// a new installation the switch is off, in general and at every program. This holds for every download.
// krobi 2026-09-28 21:52: "just build in a datapoint for deleting, like in the parcel adapter — it only deletes the
// datapoint, at most the api can delete the download from the list through it" · 2026-11-19 18:44: "on removing
// downloads, every downloader gets an option in the admin whether downloads are deleted directly from the program — and
// there is a general setting that overrules the individual ones — done, holds for ALL downloads" · 18:51: "we already
// have a switch that deletes or keeps the datapoints. I meant the topic of deleting the files, that is what it was
// about" · 18:57: "important for d04, there are no 2 switches, there is one general switch — when deleting downloads
// also delete the real data (or similar), that is switched on or off. this question exists for every downloader on its
// own or in general. if general is on, one cannot choose individually. general off first, then one can choose
// individually." · 19:35: "Yes right" (on: deleted is everything the program loaded for the download) · 19:47: "Off"
// (on: how the switch stands after the update and on a new installation).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { forCapabilities, ITEM_DATAPOINTS } from "../lib/core/datapoints";
import { RefusedError } from "../lib/core/errors";
import { ProgramManager, type ManagerAdapter } from "../lib/core/manager";
import {
  STATUSES,
  type DownloadItem,
  type DriverDeps,
  type ProgramConfig,
  type ProgramDriver,
  type ProgramEntry,
} from "../lib/core/model";
import {
  dialogType,
  emptyForm,
  formFromData,
  formToRow,
  programForm,
  rowToForm,
  storedType,
  type DialogType,
  type FormContext,
} from "../lib/dm-forms";
import { CATALOG, type ProgramInfo, type ProgramType } from "../lib/programs/catalog";
import { findProgram } from "../lib/programs/registry";

/** Every request a program client was asked to send: program, method or endpoint, parameters. */
const sent = vi.hoisted(() => [] as { program: string; method: string; params: unknown }[]);
/** JDownloader's method list, the adapter's own — loaded with its client, judging both stand-in transports. */
const jd = vi.hoisted(() => ({ check: undefined as ((path: string, params: readonly unknown[]) => void) | undefined }));

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

// Each program's client is replaced by a recorder — this guard checks what the driver asks the program, not the wire.
vi.mock("../lib/programs/qbittorrent/client", () => ({
  QbClient: class {
    post(method: string, params: unknown): Promise<string> {
      sent.push({ program: "qbittorrent", method, params });
      return Promise.resolve("");
    }
  },
}));
vi.mock("../lib/programs/transmission/client", () => ({
  TrClient: class {
    call(method: string, params: unknown): Promise<Record<string, unknown>> {
      sent.push({ program: "transmission", method, params });
      return Promise.resolve({});
    }
  },
}));
vi.mock("../lib/programs/deluge/client", () => ({
  DlClient: class {
    call(method: string, params: unknown): Promise<unknown> {
      sent.push({ program: "deluge", method, params });
      return Promise.resolve(true);
    }
  },
}));
vi.mock("../lib/programs/sabnzbd/client", () => ({
  SabClient: class {
    call(params: Record<string, unknown>): Promise<Record<string, unknown>> {
      sent.push({ program: "sabnzbd", method: `${String(params.mode)}.${String(params.name)}`, params });
      return Promise.resolve({ status: true });
    }
  },
}));
vi.mock("../lib/programs/nzbget/client", () => ({
  NzbClient: class {
    call(method: string, params: unknown): Promise<unknown> {
      sent.push({ program: "nzbget", method, params });
      return Promise.resolve(true);
    }
  },
}));
vi.mock("../lib/programs/aria2/client", () => ({
  nodeSocket: () => ({ addEventListener: () => undefined, close: () => undefined }),
  AriaClient: class {
    call(method: string, params: unknown): Promise<unknown> {
      sent.push({ program: "aria2", method, params });
      return Promise.resolve("OK");
    }
  },
}));
vi.mock("../lib/programs/pyload/client", () => ({
  PyClient: class {
    post(method: string, params: unknown): Promise<unknown> {
      sent.push({ program: "pyload", method, params });
      return Promise.resolve(true);
    }
  },
}));
vi.mock("../lib/programs/rqbit/client", () => ({
  RqClient: class {
    post(path: string, body?: unknown): Promise<unknown> {
      sent.push({ program: "rqbit", method: `POST ${path}`, params: body });
      return Promise.resolve({});
    }
  },
}));
vi.mock("../lib/programs/rtorrent/client", () => ({
  RtClient: class {
    call(method: string, ...params: unknown[]): Promise<unknown> {
      sent.push({ program: "rtorrent", method, params });
      return Promise.resolve(0);
    }
  },
}));
vi.mock("../lib/programs/tribler/client", () => ({
  TblClient: class {
    send(method: string, path: string, json?: unknown): Promise<unknown> {
      sent.push({ program: "tribler", method: `${method} ${path}`, params: json });
      return Promise.resolve({});
    }
  },
}));
vi.mock("../lib/programs/flood/client", () => ({
  FloodClient: class {
    send(method: string, path: string, json?: unknown): Promise<unknown> {
      sent.push({ program: "flood", method: `${method} ${path}`, params: json });
      return Promise.resolve({});
    }
  },
}));
vi.mock("../lib/programs/utorrent/client", () => ({
  UtClient: class {
    call(query: string): Promise<Record<string, unknown>> {
      sent.push({ program: "utorrent", method: query, params: undefined });
      return Promise.resolve({});
    }
  },
}));
vi.mock("../lib/programs/hadouken/client", () => ({
  HkClient: class {
    call(method: string, params: unknown): Promise<unknown> {
      sent.push({ program: "hadouken", method, params });
      return Promise.resolve(null);
    }
  },
}));
vi.mock("../lib/programs/downloadstation/client", async importOriginal => ({
  ...(await importOriginal<object>()),
  DsClient: class {
    call(api: string, method: string, params: Record<string, string>): Promise<unknown> {
      sent.push({ program: "downloadstation", method: `${api} ${method}`, params });
      return Promise.resolve(params.id.split(",").map(id => ({ id, error: 0 })));
    }
  },
}));
vi.mock("../lib/programs/nzbvortex/client", () => ({
  NvClient: class {
    get(resource: string, params?: unknown): Promise<Record<string, unknown>> {
      sent.push({ program: "nzbvortex", method: resource, params });
      return Promise.resolve({ result: "ok" });
    }
  },
}));
vi.mock("../lib/programs/freebox/client", () => ({
  FbxClient: class {
    call(method: string, resource: string, body?: unknown): Promise<unknown> {
      sent.push({ program: "freebox", method: `${method} ${resource}`, params: body });
      return Promise.resolve(null);
    }
  },
}));
// JDownloader's two transports: the adapter's own method list (checkJdCall) still judges every call
vi.mock("../lib/programs/jdownloader/client", async importOriginal => {
  const real = await importOriginal<{ checkJdCall: (path: string, params: readonly unknown[]) => void }>();
  jd.check = real.checkJdCall;
  return {
    ...real,
    JdLocalTransport: class {
      call(path: string, params: unknown[] = []): Promise<unknown> {
        real.checkJdCall(path, params);
        sent.push({ program: "jdownloader", method: path, params });
        return Promise.resolve(null);
      }
      close(): undefined {
        return undefined;
      }
    },
  };
});
vi.mock("../lib/programs/jdownloader/cloud", async importOriginal => ({
  ...(await importOriginal<object>()),
  JdCloudTransport: class {
    call(path: string, params: unknown[] = []): Promise<unknown> {
      if (!jd.check) {
        throw new Error("JDownloader's method list is not loaded");
      }
      jd.check(path, params);
      sent.push({ program: "jdownloader-cloud", method: path, params });
      return Promise.resolve(null);
    }
    close(): undefined {
      return undefined;
    }
  },
}));

const CFG: ProgramConfig = {
  type: "",
  name: "guard",
  host: "192.0.2.1",
  port: 0,
  https: false,
  path: "",
  username: "user@example.com",
  password: "pw",
  apiKey: "key",
  device: "dev",
  deviceId: "dev1",
};
const DEPS: DriverDeps = {
  setTimeout: () => undefined,
  clearTimeout: () => undefined,
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
};
const KEY = "42";

const json = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), file), "utf8")) as Record<string, unknown>;
const native = (json("io-package.json").native ?? {}) as Record<string, unknown>;
const settingsPage = (json("admin/jsonConfig.json").items ?? {}) as Record<string, Record<string, unknown>>;
const de = json("admin/i18n/de.json");

/** The switch, as the rule names it. */
const SWITCH = "Beim Entfernen auch die Dateien löschen";

/**
 * @param label a field's label: a text key of the settings page, or a translated text of a dialog
 * @returns its German text
 */
const german = (label: unknown): unknown =>
  de[typeof label === "string" ? label : String((label as { en?: unknown } | undefined)?.en)];

/** The settings page's switch: its setting and its field. */
const [GENERAL, generalField] = Object.entries(settingsPage).find(([, f]) => german(f.label) === SWITCH) ?? [];

/** Where a download stands when it is removed: still loading (removing aborts it), finished, or failed. */
type State = "loading" | "finished" | "failed";
const STATES: readonly State[] = ["loading", "finished", "failed"];

/** One request to the program. */
interface Sent {
  method: string;
  params: unknown;
}
/** What a removal asks the program, or that its driver refuses it (and sends nothing). */
type Asked = readonly Sent[] | { refused: true };
/** Per state: the removal with the switch off (`keep`) and on (`delete`). */
type Row = Record<State, { keep: Asked; delete: Asked }>;

const ask = (method: string, params?: unknown): Asked => [{ method, params }];
/**
 * The driver refuses before it sends anything, where the program cannot carry the removal out as the switch says (core
 * decision D-13): aria2, pyLoad and rTorrent delete no files; SABnzbd and NZBGet keep a finished download's files;
 * NZBGet deletes a failed one's; Download Station keeps a finished task's files and deletes what an unfinished one loaded.
 */
const REFUSED: Asked = { refused: true };
const anyState = (keep: Asked, del: Asked): Row => ({
  loading: { keep, delete: del },
  finished: { keep, delete: del },
  failed: { keep, delete: del },
});
/**
 * @param asked what a removal asks the program
 * @returns what the program is sent: nothing where its driver refuses
 */
const sentOf = (asked: Asked): readonly Sent[] => ("refused" in asked ? [] : asked);

/**
 * Every program of the catalog: what removing a download asks it, per state, with the switch off and on.
 *
 * @param key the download
 * @returns per program type
 */
function removalOf(key: string): Record<ProgramType, Row> {
  const n = Number(key);
  const cleanup = ask("/downloadsV2/cleanup", [[], [n], "DELETE_ALL", "REMOVE_LINKS_AND_DELETE_FILES", "SELECTED"]);
  const dsDelete = ask("SYNO.DownloadStation.Task delete", { id: key, force_complete: "false" });
  return {
    // cleanup with REMOVE_LINKS_AND_DELETE_FILES deletes the package's finished files and its .part files
    jdownloader: anyState(ask("/downloadsV2/removeLinks", [[], [n]]), cleanup),
    "jdownloader-cloud": anyState(ask("/downloadsV2/removeLinks", [[], [n]]), cleanup),
    qbittorrent: anyState(
      ask("torrents/delete", { hashes: key, deleteFiles: "false" }),
      ask("torrents/delete", { hashes: key, deleteFiles: "true" }),
    ),
    transmission: anyState(
      ask("torrent_remove", { ids: [key], delete_local_data: false }),
      ask("torrent_remove", { ids: [key], delete_local_data: true }),
    ),
    deluge: anyState(ask("core.remove_torrent", [key, false]), ask("core.remove_torrent", [key, true])),
    sabnzbd: {
      loading: {
        keep: ask("queue.delete", { mode: "queue", name: "delete", value: key }),
        delete: ask("queue.delete", { mode: "queue", name: "delete", value: key, del_files: "1" }),
      },
      finished: {
        keep: ask("history.delete", { mode: "history", name: "delete", value: key }),
        delete: REFUSED,
      },
      failed: {
        keep: ask("history.delete", { mode: "history", name: "delete", value: key }),
        delete: ask("history.delete", { mode: "history", name: "delete", value: key, del_files: "1" }),
      },
    },
    nzbget: {
      // GroupParkDelete keeps what is loaded, GroupDelete deletes it
      loading: {
        keep: ask("editqueue", ["GroupParkDelete", "", [n]]),
        delete: ask("editqueue", ["GroupDelete", "", [n]]),
      },
      finished: {
        keep: ask("editqueue", ["HistoryDelete", "", [n]]),
        delete: REFUSED,
      },
      failed: {
        keep: REFUSED,
        delete: ask("editqueue", ["HistoryDelete", "", [n]]),
      },
    },
    aria2: {
      loading: { keep: ask("aria2.remove", [key]), delete: REFUSED },
      finished: { keep: ask("aria2.removeDownloadResult", [key]), delete: REFUSED },
      failed: { keep: ask("aria2.removeDownloadResult", [key]), delete: REFUSED },
    },
    pyload: anyState(ask("delete_packages", { package_ids: [n] }), REFUSED),
    // forget keeps the files, delete removes them
    rqbit: anyState(ask(`POST /torrents/${key}/forget`), ask(`POST /torrents/${key}/delete`)),
    rtorrent: anyState(ask("d.erase", [key]), REFUSED),
    tribler: anyState(
      ask(`DELETE /api/downloads/${key}`, { remove_data: false }),
      ask(`DELETE /api/downloads/${key}`, { remove_data: true }),
    ),
    flood: anyState(
      ask("POST /torrents/delete", { hashes: [key], deleteData: false }),
      ask("POST /torrents/delete", { hashes: [key], deleteData: true }),
    ),
    vuze: anyState(
      ask("torrent_remove", { ids: [key], delete_local_data: false }),
      ask("torrent_remove", { ids: [key], delete_local_data: true }),
    ),
    // remove leaves the files, removedata deletes them
    utorrent: anyState(ask(`action=remove&hash=${key}`), ask(`action=removedata&hash=${key}`)),
    hadouken: anyState(ask("webui.perform", ["remove", [key]]), ask("webui.perform", ["removedata", [key]])),
    // Download Station keeps a finished task's files and discards what an unfinished one loaded, whatever it is asked
    downloadstation: {
      loading: { keep: REFUSED, delete: dsDelete },
      finished: {
        keep: dsDelete,
        delete: REFUSED,
      },
      failed: { keep: REFUSED, delete: dsDelete },
    },
    // cancel takes the NZB out of the queue and leaves its files, cancelDelete deletes them
    nzbvortex: anyState(ask(`nzb/${key}/cancel`), ask(`nzb/${key}/cancelDelete`)),
    freebox: anyState(ask(`DELETE downloads/${key}`), ask(`DELETE downloads/${key}/erase`)),
  };
}
const REMOVAL = removalOf(KEY);

/**
 * Puts the downloads where the driver looks for them — the program's last answer, as the driver keeps it.
 *
 * @param driver a fresh driver
 * @param type its program type
 * @param state where the downloads stand
 * @param keys the downloads
 */
function place(driver: ProgramDriver, type: ProgramType, state: State, keys: readonly string[]): void {
  const own = driver as unknown as Record<string, unknown>;
  const field = <T>(name: string, kind: abstract new (...args: never[]) => T): T => {
    expect(own[name], `${type}.${name}`).toBeInstanceOf(kind);
    return own[name] as T;
  };
  for (const key of keys) {
    switch (type) {
      case "aria2":
        if (state !== "loading") {
          field("stopped", Set).add(key);
        }
        break;
      case "sabnzbd":
        if (state === "loading") {
          field("inQueue", Set).add(key);
        } else {
          field("history", Array).push({ nzo_id: key, status: state === "finished" ? "Completed" : "Failed" });
        }
        break;
      case "nzbget":
        if (state === "loading") {
          field("inQueue", Set).add(key);
        } else {
          const par = state === "finished" ? "SUCCESS" : "FAILURE";
          field("history", Map).set(key, { Kind: "NZB", DeleteStatus: "NONE", ParStatus: par, UnpackStatus: "NONE" });
        }
        break;
      case "downloadstation": {
        const status = { loading: "downloading", finished: "finished", failed: "error" }[state];
        field("tasks", Map).set(key, { id: key, status, row: {} });
        break;
      }
      default:
        break;
    }
  }
}

/**
 * @param type a program type
 * @param state where the download stands
 * @param deleteFiles the switch
 * @returns what removing the download asks the program, or why its driver refuses
 */
async function removeVia(type: ProgramType, state: State, deleteFiles: boolean): Promise<Asked> {
  sent.length = 0;
  const driver = findProgram(type)!.create({ ...CFG, type }, DEPS);
  place(driver, type, state, [KEY]);
  try {
    await driver.command({ kind: "remove", key: KEY, deleteFiles });
  } catch (err: unknown) {
    if (!(err instanceof RefusedError)) {
      throw err;
    }
    // a refused removal sends nothing
    expect(sent, `${type} ${state}`).toEqual([]);
    return REFUSED;
  }
  return sent.map(({ method, params }) => ({ method, params }));
}

/**
 * The datapoints a download of this program has whose write takes the download out of the program's list.
 *
 * @param info a program of the catalog
 * @param state where the download stands
 * @returns their ids
 */
async function removersOf(info: ProgramInfo, state: State): Promise<string[]> {
  const fresh = (): ProgramDriver => {
    const driver = findProgram(info.type)!.create({ ...CFG, type: info.type }, DEPS);
    place(driver, info.type, state, [KEY]);
    return driver;
  };
  const ids: string[] = [];
  for (const def of forCapabilities(ITEM_DATAPOINTS, fresh().capabilities).filter(d => d.write)) {
    const cmd = def.command?.(true, KEY);
    if (!cmd) {
      continue;
    }
    sent.length = 0;
    await fresh()
      .command(cmd)
      .catch(() => undefined);
    if (
      isDeepStrictEqual(
        sent.map(({ method, params }) => ({ method, params })),
        REMOVAL[info.type][state].keep,
      )
    ) {
      ids.push(def.id);
    }
  }
  return ids;
}

/** The object and state store of an instance, in memory — this guard's own copy (a guard imports no test code). */
class Memory implements ManagerAdapter {
  readonly namespace = "dl-manager.0";
  readonly objects = new Map<string, ioBroker.Object>();
  readonly states = new Map<string, ioBroker.StateValue>();
  /** Every object removal asked, with all below it. */
  readonly removed: string[] = [];
  readonly log = { debug: () => undefined, info: () => undefined, warn: () => undefined };
  private full(id: string): string {
    return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
  }
  extendObject(id: string, obj: ioBroker.PartialObject): Promise<void> {
    const old = (this.objects.get(this.full(id)) ?? {}) as Record<string, unknown>;
    const patch = structuredClone(obj) as Record<string, unknown>;
    this.objects.set(this.full(id), {
      ...old,
      ...patch,
      common: { ...(old.common as object), ...(patch.common as object) },
      native: { ...(old.native as object), ...(patch.native as object) },
    } as unknown as ioBroker.Object);
    return Promise.resolve();
  }
  removeObject(id: string): Promise<void> {
    const full = this.full(id);
    this.removed.push(full);
    for (const key of [...this.objects.keys()]) {
      if (key === full || key.startsWith(`${full}.`)) {
        this.objects.delete(key);
      }
    }
    return Promise.resolve();
  }
  knownObject(id: string): unknown {
    return this.objects.get(this.full(id));
  }
  getForeignObjects(): Promise<Record<string, ioBroker.Object>> {
    return Promise.resolve({});
  }
  knownValue(id: string): ioBroker.StateValue | undefined {
    return this.states.get(this.full(id));
  }
  setState(id: string, state: ioBroker.SettableState): Promise<void> {
    this.states.set(this.full(id), state.val ?? null);
    return Promise.resolve();
  }
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<void> {
    return this.setState(id, state);
  }
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null> {
    return Promise.resolve(structuredClone(this.objects.get(id) ?? null));
  }
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
    this.objects.set(id, obj as ioBroker.Object);
    return Promise.resolve();
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

/** One download in every status of the common list. */
const ITEMS: readonly DownloadItem[] = STATUSES.map((status, i) => ({
  key: String(100 + i),
  name: `download ${status}`,
  status,
  sizeBytes: 100,
  doneBytes: status === "completed" || status === "seeding" ? 100 : 50,
  speedBps: 0,
  etaSeconds: null,
  error: "",
}));

/**
 * @param info a program of the catalog
 * @returns its dialog, and the dialog data that stores a row of exactly this type
 */
function dialogOf(info: ProgramInfo): { dialog: DialogType; mode: "local" | "cloud" } {
  const dialog = dialogType({ type: info.type });
  expect(dialog, info.type).toBeDefined();
  const mode = (["local", "cloud"] as const).find(m => storedType(dialog!, { mode: m }) === info.type);
  expect(mode, info.type).toBeDefined();
  return { dialog: dialog!, mode: mode! };
}

/**
 * @param info a program of the catalog
 * @param ctx the instance's settings as the dialog knows them
 * @returns the card's own question in the program's dialog — its key in the dialog's data and its field — if it asks
 */
function cardSwitch(
  info: ProgramInfo,
  ctx: FormContext = { takenKeys: [] },
): [string, Record<string, unknown>] | undefined {
  const items = (
    programForm(dialogOf(info).dialog, ctx) as unknown as { items: Record<string, Record<string, unknown>> }
  ).items;
  return Object.entries(items).find(([, f]) => german(f.label) === SWITCH);
}

/**
 * @param info a program of the catalog
 * @param choice the card's answer to its question (undefined: left as the dialog opened)
 * @returns the program row the card stores
 */
function storedCard(info: ProgramInfo, choice: boolean | undefined): Record<string, unknown> {
  const { dialog, mode } = dialogOf(info);
  const field = cardSwitch(info)?.[0];
  const answer = { mode, host: "nas", name: info.label, ...(field && choice !== undefined ? { [field]: choice } : {}) };
  return formToRow(dialog, formFromData(answer, emptyForm(dialog)), `${info.type}-nas`);
}

/** A program whose card asks — and whose removal does not depend on where the download stands. */
const CHOOSES = CATALOG.find(
  p => cardSwitch(p) !== undefined && STATES.every(s => isDeepStrictEqual(REMOVAL[p.type][s], REMOVAL[p.type].loading)),
)!;

/**
 * Starts the adapter's manager with one program — its real driver, which keeps listing every download of
 * {@link ITEMS} — and presses the remove datapoint of every download in the object tree.
 *
 * @param general the settings page's switch (undefined: the instance has no such setting yet)
 * @param row the stored program row
 * @returns per download what its program was sent, and the instance's objects
 */
async function removeEvery(
  general: boolean | undefined,
  row: Record<string, unknown>,
): Promise<{ asked: Record<string, readonly Sent[]>; a: Memory }> {
  const [remover] = await removersOf(CHOOSES, "loading");
  expect(remover).toBeDefined();
  const a = new Memory();
  // the adapter's own lookup and driver; only the program's list is a stand-in, so nothing is asked to list it
  const find = (type: string): ProgramEntry | undefined => {
    const entry = findProgram(type);
    return (
      entry && {
        ...entry,
        needs: [],
        create: (cfg, deps): ProgramDriver => {
          const real = entry.create(cfg, deps);
          return {
            type,
            capabilities: real.capabilities,
            extras: [],
            poll: () =>
              Promise.resolve({
                status: { version: "1", paused: false, downloadBps: 0 },
                items: [...ITEMS],
                complete: true,
              }),
            command: cmd => real.command(cmd),
            close: () => Promise.resolve(),
          };
        },
      }
    );
  };
  const manager = new ProgramManager(
    {
      adapter: a,
      timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
      find,
      problems: { report: () => undefined, forget: () => undefined },
      moveDevice: () => Promise.resolve(),
    },
    { intervalMs: 10_000, scope: "all", limit: 100, ...(general === undefined ? {} : { deleteFiles: general }) },
  );
  await manager.start([row]);
  await flush();
  const buttons = [...a.objects.keys()].filter(id => id.endsWith(`.${remover}`));
  // every download has its own
  expect(buttons).toHaveLength(ITEMS.length);
  const asked: Record<string, readonly Sent[]> = {};
  for (const id of buttons) {
    sent.length = 0;
    await manager.onUserWrite(id.slice(`${a.namespace}.`.length), true);
    await flush();
    // the download's channel names the program's key of it
    const key = String(a.objects.get(id.slice(0, id.lastIndexOf(".")))?.native?.key);
    asked[key] = sent.map(({ method, params }) => ({ method, params }));
  }
  return { asked, a };
}

/**
 * @param type a program type
 * @param files keep or delete
 * @returns per download of {@link ITEMS} what its program is to be sent
 */
const expected = (type: ProgramType, files: "keep" | "delete"): Record<string, readonly Sent[]> =>
  Object.fromEntries(ITEMS.map(i => [i.key, sentOf(removalOf(i.key)[type].loading[files])]));

/**
 * @param general the settings page's switch
 * @param row the stored program row
 * @returns per download what its program was sent
 */
const filesGo = async (general: boolean | undefined, row: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await removeEvery(general, row)).asked;

describe("D-04 removing a download, with its files where the switch says so", () => {
  it("gives every download a remove datapoint of its own, at every program", async () => {
    for (const info of CATALOG) {
      const state = STATES.find(s => !("refused" in REMOVAL[info.type][s].keep));
      expect(state, info.type).toBeDefined();
      expect(await removersOf(info, state!), info.type).toHaveLength(1);
    }
  });

  it("takes the download out of the program's list — with the switch off the program keeps its files", async () => {
    for (const info of CATALOG) {
      expect(REMOVAL[info.type], info.type).toBeDefined();
      for (const state of STATES) {
        expect(await removeVia(info.type, state, false), `${info.type} ${state}`).toEqual(
          REMOVAL[info.type][state].keep,
        );
      }
    }
  });

  it("lets a switch in the admin decide whether the files go too", async () => {
    expect(GENERAL).toBeDefined();
    expect(await filesGo(true, storedCard(CHOOSES, false))).toEqual(expected(CHOOSES.type, "delete"));
    expect(await filesGo(false, storedCard(CHOOSES, false))).toEqual(expected(CHOOSES.type, "keep"));
  });

  it("asks the question in general and on the card of every program that can delete files", async () => {
    expect(GENERAL).toBeDefined();
    for (const info of CATALOG) {
      // a program that cannot delete files does not offer it (core decision D-13)
      if (STATES.some(s => !("refused" in REMOVAL[info.type][s].delete))) {
        expect(cardSwitch(info), info.type).toBeDefined();
      }
    }
    // the card's own answer decides for its program
    expect(await filesGo(false, storedCard(CHOOSES, true))).toEqual(expected(CHOOSES.type, "delete"));
  });

  it("locks every card while the switch is on in general, and leaves the choice to each card while it is off", async () => {
    for (const info of CATALOG) {
      const on = cardSwitch(info, { takenKeys: [], deleteFilesAll: true });
      const off = cardSwitch(info, { takenKeys: [], deleteFilesAll: false });
      if (on) {
        expect(on[1].disabled, info.type).toBe(true);
      }
      if (off) {
        expect(off[1].disabled === true, info.type).toBe(false);
      }
    }
    // on in general overrules the card; off in general, the card decides
    expect(await filesGo(true, storedCard(CHOOSES, false))).toEqual(expected(CHOOSES.type, "delete"));
    expect(await filesGo(false, storedCard(CHOOSES, true))).toEqual(expected(CHOOSES.type, "delete"));
    expect(await filesGo(false, storedCard(CHOOSES, false))).toEqual(expected(CHOOSES.type, "keep"));
  });

  it("deletes what the program loaded: a finished download's files, what an aborted or failed one loaded so far", async () => {
    for (const info of CATALOG) {
      for (const state of STATES) {
        expect(await removeVia(info.type, state, true), `${info.type} ${state}`).toEqual(
          REMOVAL[info.type][state].delete,
        );
      }
    }
  });

  it("leaves the datapoints to the other switch — the files switch changes no object", async () => {
    const row = storedCard(CHOOSES, false);
    const on = await removeEvery(true, row);
    const off = await removeEvery(false, row);
    expect(on.asked).toEqual(expected(CHOOSES.type, "delete"));
    expect(off.asked).toEqual(expected(CHOOSES.type, "keep"));
    expect(on.a.removed).toEqual(off.a.removed);
    expect([...on.a.objects.keys()].sort()).toEqual([...off.a.objects.keys()].sort());
  });

  it("stands off after the update and on a new installation, in general and on every card", async () => {
    expect(native[GENERAL!]).toBe(false);
    expect(generalField?.default).toBe(false);
    for (const info of CATALOG) {
      const field = cardSwitch(info)?.[0];
      if (!field) {
        continue;
      }
      const { dialog } = dialogOf(info);
      // a new card, and the card of a program stored before the update
      const before = { id: `${info.type}-nas`, type: info.type, name: info.label, host: "nas" };
      expect((emptyForm(dialog) as unknown as Record<string, unknown>)[field], info.type).toBe(false);
      expect((rowToForm(before) as unknown as Record<string, unknown>)[field], info.type).toBe(false);
    }
    const before = { id: `${CHOOSES.type}-nas`, type: CHOOSES.type, name: CHOOSES.label, host: "nas" };
    expect(await filesGo(undefined, storedCard(CHOOSES, undefined))).toEqual(expected(CHOOSES.type, "keep"));
    expect(await filesGo(undefined, before)).toEqual(expected(CHOOSES.type, "keep"));
  });

  it("holds for every download, whatever its status", async () => {
    expect(ITEMS.map(i => i.status)).toEqual([...STATUSES]);
    expect(await filesGo(true, storedCard(CHOOSES, false))).toEqual(expected(CHOOSES.type, "delete"));
    expect(await filesGo(false, storedCard(CHOOSES, true))).toEqual(expected(CHOOSES.type, "delete"));
    expect(await filesGo(false, storedCard(CHOOSES, false))).toEqual(expected(CHOOSES.type, "keep"));
  });
});
