// Core decision D-13 (accepted 2026-11-19 18:54): every decision of the dl-manager holds for every download program
// the adapter drives, today and in future, with the same result for the user. Where a program behaves differently, the
// adapter adapts only its handling of this program until the result is the same; what cannot be reached there that way,
// it does not offer at this program. A decision, exception or question of its own for a single program does not exist;
// what the user is to choose himself becomes a setting in the admin that offers every program the same choice.
// krobi 2026-11-19 17:38: "you are showing me this now? I am confused, the same decisions hold for every downloader,
// why should I make a decision of its own for one downloader only? what is the general decision for all downloaders" ·
// 2026-10-22 22:24, on K8 (a new link in a paused program): "k8 is a specific answer, … if at all, such a decision is
// better placed in the admin, where the user can set this behaviour".
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parsePrograms } from "../lib/core/config";
import { ITEM_DATAPOINTS, PROGRAM_DATAPOINTS } from "../lib/core/datapoints";
import { RefusedError } from "../lib/core/errors";
import { ProgramManager, type ManagerAdapter } from "../lib/core/manager";
import type { DownloadItem, ProgramDriver, ProgramEntry } from "../lib/core/model";
import {
  dialogType,
  emptyForm,
  formFromData,
  formToRow,
  programForm,
  storedType,
  type DialogType,
  type FormContext,
} from "../lib/dm-forms";
import { CATALOG, type ProgramInfo } from "../lib/programs/catalog";
import { findProgram } from "../lib/programs/registry";

/**
 * A precondition of this guard — it throws when the guard cannot run, it asserts nothing of the rule.
 *
 * @param ok what has to hold for the guard to run
 * @param what what is missing otherwise
 */
function need(ok: unknown, what: string): asserts ok {
  if (!ok) {
    throw new Error(`the guard cannot run: ${what}`);
  }
}

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));
// no program is reached: whatever a driver sends fails at once instead of waiting for an address nobody answers (fetch
// and WebSocket below, node:http(s) where the HTTP client keeps the header names or the certificate)
const offline = vi.hoisted(() => (): never => {
  throw new TypeError("offline");
});
vi.mock("node:http", async importOriginal => ({ ...(await importOriginal<object>()), request: offline }));
vi.mock("node:https", async importOriginal => ({ ...(await importOriginal<object>()), request: offline }));

const KEY = "42";
/** One download, still loading — what every program lists. */
const ITEM: DownloadItem = {
  key: KEY,
  name: "download",
  status: "downloading",
  sizeBytes: 100,
  doneBytes: 50,
  speedBps: 0,
  etaSeconds: null,
  error: "",
};

/** The object and state store of an instance, in memory — this guard's own copy (a guard imports no test code). */
class Memory implements ManagerAdapter {
  readonly namespace = "dl-manager.0";
  readonly objects = new Map<string, ioBroker.Object>();
  readonly states = new Map<string, ioBroker.StateValue>();
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

/**
 * Puts the download where the driver looks for it — its record of the program's last answer, as a loading download.
 *
 * @param driver a fresh driver
 */
function place(driver: ProgramDriver): void {
  const own = driver as unknown as Record<string, unknown>;
  if (own.inQueue instanceof Set) {
    own.inQueue.add(KEY);
  }
  if (own.tasks instanceof Map) {
    own.tasks.set(KEY, { id: KEY, status: "downloading", row: {} });
  }
}

/**
 * @param info a program of the catalog
 * @returns its dialog, and the dialog's answer that stores a row of exactly this program
 */
function dialogOf(info: ProgramInfo): { dialog: DialogType; mode: "local" | "cloud" } {
  const dialog = dialogType({ type: info.type });
  need(dialog, `${info.type} has no dialog`);
  const mode = (["local", "cloud"] as const).find(m => storedType(dialog, { mode: m }) === info.type);
  need(mode, `no dialog answer stores ${info.type}`);
  return { dialog, mode };
}

/**
 * @param info a program of the catalog
 * @param answer what the user answers in its dialog, beside a host and the program's name
 * @returns the program row the card stores
 */
function rowOf(info: ProgramInfo, answer: Record<string, unknown>): Record<string, unknown> {
  const { dialog, mode } = dialogOf(info);
  const data = { mode, host: "nas", name: info.label, ...answer };
  return formToRow(dialog, formFromData(data, emptyForm(dialog)), `${info.type}-nas`);
}

/**
 * @param info a program of the catalog
 * @param key a field's key in the dialog's answer
 * @param field the field
 * @returns an answer to the field other than the one the dialog opens with
 */
function otherAnswer(info: ProgramInfo, key: string, field: unknown): unknown {
  const { dialog, mode } = dialogOf(info);
  const now =
    ({ mode, host: "nas", name: info.label } as Record<string, unknown>)[key] ??
    (emptyForm(dialog) as unknown as Record<string, unknown>)[key];
  const options = (field as { options?: unknown }).options;
  const values = Array.isArray(options)
    ? options.map(o => (o as { value?: unknown }).value)
    : options && typeof options === "object"
      ? Object.keys(options)
      : [];
  return values.find(v => v !== now) ?? (typeof now === "boolean" ? !now : typeof now === "string" ? `1${now}` : true);
}

/**
 * A field is the user's choice when another answer changes the stored program, but not how the program is reached.
 *
 * @param info a program of the catalog
 * @param key the field's key in the dialog's answer
 * @param field the field
 * @returns whether the field is a choice
 */
function isChoice(info: ProgramInfo, key: string, field: unknown): boolean {
  const read = (row: Record<string, unknown>): Record<string, unknown> => {
    const [program] = parsePrograms([row], findProgram);
    need(program, `${info.type}: the stored row is not read`);
    return program as unknown as Record<string, unknown>;
  };
  // the program is reached with what the row hands its driver
  const { cfg: reachedBefore, ...before } = read(rowOf(info, {}));
  const { cfg: reachedAfter, ...after } = read(rowOf(info, { [key]: otherAnswer(info, key, field) }));
  return isDeepStrictEqual(reachedBefore, reachedAfter) && !isDeepStrictEqual(before, after);
}

/**
 * @param info a program of the catalog
 * @param ctx the instance's settings
 * @returns the choices of its dialog, by key
 */
function choicesOf(info: ProgramInfo, ctx: FormContext = { takenKeys: [] }): Record<string, unknown> {
  const items = (programForm(dialogOf(info).dialog, ctx) as unknown as { items: Record<string, unknown> }).items;
  return Object.fromEntries(Object.entries(items).filter(([k, f]) => isChoice(info, k, f)));
}

/** What the user gets of one program. */
interface Outcome {
  /** what its driver can do */
  can: string[];
  /** every datapoint's form (its common without name and description), by its id below the program's device */
  forms: Map<string, Record<string, unknown>>;
  /** every command the program was handed when its switches and buttons were pressed, and whether its driver refused it */
  handed: string[];
}

/**
 * Starts the adapter's manager with one program — its own driver, whose program lists {@link ITEM} — and presses every
 * switch and button of its device.
 *
 * @param info a program of the catalog
 * @param row the stored program row
 * @returns what the user gets of it
 */
async function run(info: ProgramInfo, row: Record<string, unknown>): Promise<Outcome> {
  const a = new Memory();
  const handed: string[] = [];
  let can: string[] = [];
  let pressing = "";
  // the adapter's own lookup and driver; only the program's list is a stand-in, so nothing is asked to list it
  const find = (type: string): ProgramEntry | undefined => {
    const entry = findProgram(type);
    return (
      entry && {
        ...entry,
        needs: [],
        create: (cfg, deps): ProgramDriver => {
          const real = entry.create(cfg, deps);
          place(real);
          can = [...real.capabilities].sort();
          return {
            type,
            capabilities: real.capabilities,
            extras: real.extras,
            poll: () =>
              Promise.resolve({
                status: { version: "1", paused: false, downloadBps: 0 },
                items: [ITEM],
                complete: true,
              }),
            command: async cmd => {
              const said = `${pressing} ${JSON.stringify(cmd)}`;
              try {
                await real.command(cmd);
              } catch (err: unknown) {
                handed.push(err instanceof RefusedError ? `${said} refused` : said);
                throw err;
              }
              handed.push(said);
            },
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
    { intervalMs: 10_000, scope: "all", limit: 100 },
  );
  await manager.start([row]);
  await flush();
  const root = `${a.namespace}.${String(row.id)}.`;
  const states = [...a.objects].filter(([id, o]) => id.startsWith(root) && o.type === "state");
  for (const [id, o] of states) {
    const common = o.common as ioBroker.StateCommon;
    if (common.write && common.type === "boolean") {
      pressing = id.slice(root.length);
      await manager.onUserWrite(id.slice(`${a.namespace}.`.length), true);
      await flush();
    }
  }
  const forms = new Map(
    states.map(([id, o]) => {
      const form = { ...(o.common as unknown as Record<string, unknown>) };
      delete form.name;
      delete form.desc;
      return [id.slice(root.length), form];
    }),
  );
  return { can, forms, handed };
}

/**
 * @param outcome what the user gets of a program
 * @returns the commands its driver refused
 */
const refused = (outcome: Outcome): string[] => outcome.handed.filter(h => h.endsWith(" refused"));

describe("D-13 every decision holds for every program, with the same result for the user", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          offline();
        }
      },
    );
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("holds every decision for every program with the same result, a program's own handling reaching it", async () => {
    const seen = new Map<string, { type: string; form: Record<string, unknown> }>();
    for (const info of CATALOG) {
      for (const [id, form] of (await run(info, rowOf(info, {}))).forms) {
        const first = seen.get(id);
        if (first) {
          expect(form, `${info.type} ${id}, as at ${first.type}`).toEqual(first.form);
        } else {
          seen.set(id, { type: info.type, form });
        }
      }
    }
  });

  it("offers at a program nothing the program cannot reach there", async () => {
    for (const info of CATALOG) {
      const outcome = await run(info, rowOf(info, {}));
      const ids = [...outcome.forms.keys()];
      const cannot = (d: { capability?: string }): boolean =>
        d.capability !== undefined && !outcome.can.includes(d.capability);
      // no datapoint of something its driver cannot do
      for (const d of PROGRAM_DATAPOINTS.filter(cannot)) {
        expect(ids, `${info.type} ${d.id}`).not.toContain(d.id);
      }
      const ofDownloads = ids.map(id => /^downloads\.[^.]+\.(.+)$/.exec(id)?.[1]).filter(id => id !== undefined);
      for (const d of ITEM_DATAPOINTS.filter(cannot)) {
        expect(ofDownloads, `${info.type} downloads.*.${d.id}`).not.toContain(d.id);
      }
      // no choice on its card its driver cannot carry out
      for (const [key, field] of Object.entries(choicesOf(info))) {
        const answered = await run(info, rowOf(info, { [key]: otherAnswer(info, key, field) }));
        expect(refused(answered), `${info.type} ${key}`).toEqual([]);
      }
    }
  });

  it("asks no question of its own at a single program — every program gets the same choice, where it can carry it out", async () => {
    // every choice is the same at every program that offers it
    const offered = new Map<string, { info: ProgramInfo; field: unknown }>();
    for (const deleteFilesAll of [false, true]) {
      offered.clear();
      for (const info of CATALOG) {
        for (const [key, field] of Object.entries(choicesOf(info, { takenKeys: [], deleteFilesAll }))) {
          const first = offered.get(key);
          if (first) {
            expect(field, `${info.type} ${key}, as at ${first.info.type}`).toEqual(first.field);
          } else {
            offered.set(key, { info, field });
          }
        }
      }
    }
    // a program that does not offer a choice cannot carry it out: its answer is refused or changes nothing there
    for (const info of CATALOG) {
      const own = choicesOf(info);
      const base = rowOf(info, {});
      for (const [key, { info: at, field }] of offered) {
        if (key in own) {
          continue;
        }
        const before = rowOf(at, {});
        const after = rowOf(at, { [key]: otherAnswer(at, key, field) });
        const answer = Object.fromEntries(Object.entries(after).filter(([k, v]) => !isDeepStrictEqual(before[k], v)));
        const answered = await run(info, { ...base, ...answer });
        const plain = await run(info, base);
        expect(refused(answered).length > 0 || isDeepStrictEqual(answered, plain), `${info.type} ${key}`).toBe(true);
      }
    }
  });
});
