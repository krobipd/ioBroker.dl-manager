import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { FakeAdapter } from "../test/helpers/fake-adapter";

/** One data folder per adapter under test — removed after the run. */
const dataDirs: string[] = [];

// Stub the adapter-core base: the adapter's object and state calls land in an in-memory FakeAdapter, so the tests
// read the result instead of counting mock calls.
vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public namespace = "dl-manager.0";
    public adapterDir = "/tmp";
    public dataDir = ((): string => {
      const dir = mkdtempSync(join(tmpdir(), "dlm-main-test-"));
      dataDirs.push(dir);
      return dir;
    })();
    public config: Record<string, unknown> = {};
    public store = new FakeAdapter("dl-manager.0");
    public log = this.store.log;
    public handlers = new Map<string, (...args: unknown[]) => unknown>();
    public sent: unknown[] = [];
    public notifications: string[] = [];
    public instanceObject: Record<string, unknown> | null = { common: {}, native: {} };
    public instanceWrites: unknown[] = [];
    public on(event: string, fn: (...args: unknown[]) => unknown): void {
      this.handlers.set(event, fn);
    }
    public extendObject = (id: string, obj: ioBroker.PartialObject): Promise<void> => this.store.extendObject(id, obj);
    public setForeignObject = (id: string, obj: ioBroker.SettableObject): Promise<void> =>
      this.store.setForeignObject(id, obj);
    public delObjectAsync = (id: string, o?: { recursive?: boolean }): Promise<void> => this.store.delObject(id, o);
    public delForeignObjectAsync = (id: string): Promise<void> => this.store.delObject(id);
    public getObjectAsync = (id: string): Promise<ioBroker.Object | null> => this.store.getObject(id);
    public getObjectListAsync = (p: { startkey: string; endkey: string }): Promise<unknown> =>
      this.store.getObjectList(p);
    public getForeignObjectsAsync = (p: string, t: ioBroker.ObjectType): Promise<Record<string, ioBroker.Object>> =>
      this.store.getForeignObjects(p, t);
    public host = "iobhost";
    public getForeignObjectAsync = (id: string): Promise<unknown> =>
      id.startsWith("system.adapter.")
        ? Promise.resolve(structuredClone(this.instanceObject))
        : this.store.getForeignObjectAsync(id);
    public extendForeignObjectAsync = (id: string, obj: ioBroker.PartialObject): Promise<void> => {
      if (!id.startsWith("system.adapter.")) {
        return this.store.extendObject(id, obj);
      }
      this.instanceWrites.push({ id, obj });
      return Promise.resolve();
    };
    public getForeignStatesAsync = (p: string): Promise<Record<string, ioBroker.State>> => this.store.getStates(p);
    public getStateAsync = (id: string): Promise<ioBroker.State | null> => this.store.getState(id);
    public setState = (id: string, st: ioBroker.SettableState): Promise<void> => this.store.setState(id, st);
    public setStateChangedAsync = (id: string, st: ioBroker.SettableState): Promise<void> =>
      this.store.setStateChanged(id, st);
    public getStatesAsync = (p: string): Promise<Record<string, ioBroker.State>> => this.store.getStates(p);
    public subscribeStatesAsync = (): Promise<void> => Promise.resolve();
    public setTimeout = (): undefined => undefined;
    public clearTimeout = (): void => undefined;
    public encrypt = (v: string): string => `enc:${v}`;
    public decrypt = (v: string): string => {
      if (!v.startsWith("enc:")) {
        throw new Error("not ours");
      }
      return v.slice(4);
    };
    public registerNotification = (_scope: string, _cat: string, msg: string): Promise<void> => {
      this.notifications.push(msg);
      return Promise.resolve();
    };
    public sendTo = (...args: unknown[]): void => void this.sent.push(args);
    public constructor(_opts: unknown) {}
  }
  return {
    Adapter,
    getAbsoluteInstanceDataDir: (a: { dataDir: string }) => a.dataDir,
    I18n: {
      init: vi.fn(() => Promise.resolve()),
      getTranslatedObject: (k: string) => ({ en: k }),
      translate: (k: string) => k,
    },
  };
});

import type { ProgramConfig, ProgramEntry, ProgramDriver, ProgramSnapshot } from "./lib/core/model";
import { DownloadManagerAdapter } from "./main";

interface Harness {
  store: FakeAdapter;
  config: Record<string, unknown>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  sent: unknown[][];
  instanceObject: Record<string, unknown> | null;
  instanceWrites: unknown[];
  dataDir: string;
  getObjectListAsync(p: { startkey: string; endkey: string }): Promise<unknown>;
  getStatesAsync(p: string): Promise<Record<string, ioBroker.State>>;
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
/** The store object of 0.3.0/0.3.1 — the start moves it into the data folder. */
const STORE = "dl-manager.0.programs";
const storeFile = (h: Harness): string => join(h.dataDir, "programs.json");
const hasStoreFile = (h: Harness): boolean => {
  try {
    readFileSync(storeFile(h));
    return true;
  } catch {
    return false;
  }
};
const rowsOf = (h: Harness): Record<string, unknown>[] =>
  hasStoreFile(h) ? (JSON.parse(readFileSync(storeFile(h), "utf8")) as { rows: Record<string, unknown>[] }).rows : [];
const seedRows = (h: Harness, rows: Record<string, unknown>[]): void =>
  writeFileSync(storeFile(h), JSON.stringify({ rows }));
const noStore = (h: Harness): void => rmSync(storeFile(h), { force: true });

afterAll(() => {
  for (const dir of dataDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const SNAP: ProgramSnapshot = { status: { version: "4.6", paused: false, downloadBps: 0 }, items: [], complete: true };

function make(pollResult: () => Promise<ProgramSnapshot> = () => Promise.resolve(SNAP)): {
  h: Harness;
  polls: () => number;
  closed: () => number;
  configs: ProgramConfig[];
} {
  let polls = 0;
  let closed = 0;
  const configs: ProgramConfig[] = [];
  const entry: ProgramEntry = {
    type: "qbittorrent",
    needs: ["host"],
    create: (cfg: ProgramConfig): ProgramDriver => {
      configs.push(cfg);
      return {
        type: "qbittorrent",
        capabilities: new Set(["globalPause"]),
        extras: [],
        poll: () => {
          polls++;
          return pollResult();
        },
        command: () => Promise.resolve(),
        close: () => {
          closed++;
          return Promise.resolve();
        },
      };
    },
  };
  const adapter = new DownloadManagerAdapter({}, t => (t === "qbittorrent" ? entry : undefined));
  const h = adapter as unknown as Harness;
  seedRows(h, [{ id: "qbittorrent-nas", enabled: true, type: "qbittorrent", name: "NAS", host: "h1" }]);
  h.config.pollInterval = 10;
  return { h, polls: () => polls, closed: () => closed, configs };
}

describe("DownloadManagerAdapter — start", () => {
  const treeItem = (key: string, status: "completed" | "queued"): ProgramSnapshot["items"][number] => ({
    key,
    name: key,
    status,
    sizeBytes: 1,
    doneBytes: 1,
    speedBps: null,
    etaSeconds: null,
    error: "",
  });
  const channelKeys = (h: Harness): unknown[] =>
    [...h.store.objects]
      .filter(([id, o]) => o.type === "channel" && id.includes(".downloads."))
      .map(([, o]) => o.native.key);

  it("drops the old messagebox switch and stops for the restart", async () => {
    const { h, polls } = make();
    h.instanceObject = { common: { messagebox: true, supportedMessages: { deviceManager: true } }, native: {} };
    await h.handlers.get("ready")?.();
    expect(h.instanceWrites).toEqual([{ id: "system.adapter.dl-manager.0", obj: { common: { messagebox: null } } }]);
    expect(polls()).toBe(0);
  });

  it("removes the tree setting the 0.0.1 placeholder declared and stops for the restart", async () => {
    const { h, polls } = make();
    h.instanceObject = { common: {}, native: { removeFinished: false, pollInterval: 10 } };
    await h.handlers.get("ready")?.();
    expect(h.instanceWrites).toEqual([
      { id: "system.adapter.dl-manager.0", obj: { native: { removeFinished: null } } },
    ]);
    expect(polls()).toBe(0);
  });

  it("writes no object on the second start", async () => {
    const first = make();
    await first.h.handlers.get("ready")?.();
    await flush();
    const { h } = make();
    h.store = first.h.store;
    h.store.objectLog.length = 0;
    await h.handlers.get("ready")?.();
    await flush();
    expect(h.store.objectLog).toEqual([]);
  });

  it("creates the channel again when a removed download comes back", async () => {
    const polls = [[treeItem("k1", "queued")], [], [treeItem("k1", "queued")]];
    const { h } = make(() => Promise.resolve({ ...SNAP, items: polls.shift() ?? [] }));
    await h.handlers.get("ready")?.();
    await flush();
    const runner = (
      h as unknown as { manager: { running: Map<string, { runner: { pollNow(): Promise<void> } }> } }
    ).manager.running.get("qbittorrent-nas")?.runner;
    await runner?.pollNow();
    expect(channelKeys(h)).toEqual([]);
    await runner?.pollNow();
    expect(channelKeys(h)).toEqual(["k1"]);
    expect(h.store.objects.has("dl-manager.0.qbittorrent-nas.downloads.k1.status")).toBe(true);
    expect(h.store.states.get("dl-manager.0.qbittorrent-nas.downloads.k1.status")).toMatchObject({
      val: "queued",
      ack: true,
    });
  });

  it("reads no state from the database on the second start", async () => {
    const first = make();
    await first.h.handlers.get("ready")?.();
    await flush();
    const { h } = make();
    h.store = first.h.store;
    h.store.changedLog.length = 0;
    h.store.writeLog.length = 0;
    await h.handlers.get("ready")?.();
    await flush();
    // every state is compared in memory now, writable ones too (a user write is forgotten on the spot)
    expect(h.store.changedLog).toEqual([]);
    expect(h.store.writeLog.map(w => w.id)).not.toContain("dl-manager.0.qbittorrent-nas.version");
  });

  it("writes the offline stamp after a stop only where it changes", async () => {
    const first = make();
    await first.h.handlers.get("ready")?.();
    await flush();
    await new Promise<void>(resolve => first.h.handlers.get("unload")?.(resolve));
    const { h } = make();
    h.store = first.h.store;
    h.store.writeLog.length = 0;
    await h.handlers.get("ready")?.();
    await flush();
    expect(h.store.writeLog.filter(w => w.id === "info.connection").map(w => w.val)).toEqual([true]);
  });

  it("writes a manifest object only when its name differs", async () => {
    const { h } = make();
    await h.store.extendObject("info.connection", { type: "state", common: { name: "old" } });
    await h.store.extendObject("summary.pauseAll", {
      type: "state",
      common: { name: { en: "summaryPauseAll" }, desc: { en: "descSummaryPauseAll" } },
    });
    h.store.objectLog.length = 0;
    await h.handlers.get("ready")?.();
    expect(h.store.objects.get("dl-manager.0.info.connection")?.common.name).toEqual({ en: "connection" });
    expect(h.store.objectLog).toContain("dl-manager.0.info.connection");
    expect(h.store.objectLog).not.toContain("dl-manager.0.summary.pauseAll");
  });

  it("hands the program the secrets it stored encrypted", async () => {
    const { h, configs } = make();
    seedRows(h, [
      { id: "qbittorrent-nas", type: "qbittorrent", host: "h1", password: "enc:p", apiKey: "enc:k", encrypted: true },
    ]);
    await h.handlers.get("ready")?.();
    expect(configs.map(c => [c.password, c.apiKey])).toEqual([["p", "k"]]);
  });

  it("moves the programs out of the instance settings, secrets encrypted, and stops for the one restart", async () => {
    const { h, polls } = make();
    noStore(h);
    const legacy = [{ enabled: true, type: "qbittorrent", key: "nas", name: "NAS", host: "h1", password: "p" }];
    h.config.programs = legacy;
    h.instanceObject = { common: {}, native: { programs: legacy, pollInterval: 10 } };
    await h.handlers.get("ready")?.();
    expect(rowsOf(h)).toEqual([{ ...legacy[0], password: "enc:p", apiKey: "", encrypted: true }]);
    expect(h.instanceWrites).toEqual([{ id: "system.adapter.dl-manager.0", obj: { native: { programs: null } } }]);
    expect(polls()).toBe(0);
  });

  it("never overwrites the store with an older copy the instance settings still hold", async () => {
    const { h } = make();
    h.config.programs = [{ type: "qbittorrent", key: "old", host: "h9" }];
    await h.handlers.get("ready")?.();
    expect(rowsOf(h).map(r => r.id)).toEqual(["qbittorrent-nas"]);
  });

  it("gives a row from before 0.3.0 its id and moves its device — value, recording, room and the last values", async () => {
    const { h, polls } = make();
    seedRows(h, [{ enabled: true, type: "qbittorrent", key: "nas", name: "NAS", host: "h1" }]);
    const old = "dl-manager.0.qbittorrent-nas";
    await h.store.setForeignObject(old, { type: "device", common: { name: "NAS" }, native: { type: "qbittorrent" } });
    await h.store.setForeignObject(`${old}.lastFinished`, {
      type: "state",
      common: {
        name: "last",
        type: "string",
        role: "text",
        read: true,
        write: false,
        custom: { "history.0": { enabled: true } },
      },
      native: {},
    });
    await h.store.setState(`${old}.lastFinished`, { val: "movie.mkv", ack: true });
    await h.store.setForeignObject("enum.rooms.office", {
      type: "enum",
      common: { name: "Office", members: [old, `${old}.lastFinished`] },
      native: {},
    });
    await h.handlers.get("ready")?.();
    await flush();
    const now = "dl-manager.0.qbittorrent-h1";
    expect(rowsOf(h).map(r => [r.id, r.key])).toEqual([["qbittorrent-h1", undefined]]);
    expect([...h.store.objects.keys()].filter(id => id.startsWith(`${old}`))).toEqual([]);
    expect(h.store.objects.get(now)?.native.idScheme).toBe(3);
    expect(h.store.val("qbittorrent-h1.last.finished")).toBe("movie.mkv");
    expect(h.store.objects.get(`${now}.last.finished`)?.common.custom).toEqual({
      "history.0": { enabled: true, aliasId: `${old}.lastFinished` },
    });
    expect((h.store.objects.get("enum.rooms.office")?.common as { members: string[] }).members.sort()).toEqual(
      [now, `${now}.last.finished`].sort(),
    );
    expect(polls()).toBe(1);
  });

  it("starts without touching its instance object when nothing is left over", async () => {
    const { h, polls } = make();
    h.instanceObject = { common: { supportedMessages: { deviceManager: true } }, native: {} };
    await h.handlers.get("ready")?.();
    expect(h.instanceWrites).toEqual([]);
    expect(polls()).toBe(1);
  });

  it("keeps finished downloads with the default tree settings", async () => {
    const done = {
      key: "k1",
      name: "done",
      status: "completed" as const,
      sizeBytes: 1,
      doneBytes: 1,
      speedBps: null,
      etaSeconds: null,
      error: "",
    };
    const { h } = make(() => Promise.resolve({ ...SNAP, items: [done] }));
    await h.handlers.get("ready")?.();
    await flush();
    expect(h.store.objects.has("dl-manager.0.qbittorrent-nas.downloads.k1")).toBe(true);
  });

  it("reads which downloads the tree shows from the settings", async () => {
    const { h } = make(() =>
      Promise.resolve({ ...SNAP, items: [treeItem("c1", "completed"), treeItem("q1", "queued")] }),
    );
    h.config.treeScope = "unfinished";
    h.config.maxDownloads = 0;
    await h.handlers.get("ready")?.();
    await flush();
    expect(channelKeys(h)).toEqual(["q1"]);
  });

  it("reads how many downloads the tree shows from the settings", async () => {
    const { h } = make(() => Promise.resolve({ ...SNAP, items: [treeItem("q1", "queued"), treeItem("q2", "queued")] }));
    h.config.maxDownloads = "1";
    await h.handlers.get("ready")?.();
    await flush();
    expect(channelKeys(h)).toEqual(["q1"]);
  });

  it("refreshes the manifest names, stamps offline and starts the configured program", async () => {
    const { h, polls } = make();
    await h.store.setState("info.connection", { val: true, ack: true });
    await h.handlers.get("ready")?.();
    expect(h.store.objects.get("dl-manager.0.summary.pauseAll")?.common.name).toEqual({
      en: "summaryPauseAll",
    });
    expect(polls()).toBe(1);
    await flush();
    expect(h.store.val("qbittorrent-nas.online")).toBe(true);
    expect(h.store.val("info.connection")).toBe(true);
    // nothing from before 0.3.0 here: no move of the last values
    expect(h.store.logs.filter(l => l.msg.includes("moved into"))).toEqual([]);
  });

  it("brings the names of the last channel and its values to every installation", async () => {
    const { h } = make();
    await h.handlers.get("ready")?.();
    const name = (id: string): unknown => h.store.objects.get(`dl-manager.0.summary.${id}`)?.common.name;
    expect([
      name("last"),
      name("last.finished"),
      name("last.finishedTime"),
      name("last.failed"),
      name("last.failedTime"),
    ]).toEqual([
      { en: "channelLast" },
      { en: "lastFinished" },
      { en: "lastFinishedTime" },
      { en: "lastFailed" },
      { en: "lastFailedTime" },
    ]);
  });

  it("moves the store object of 0.3.x into the data folder as stored, deletes it and runs the programs", async () => {
    const { h, polls } = make();
    noStore(h);
    const stored = {
      id: "qbittorrent-nas",
      enabled: true,
      type: "qbittorrent",
      host: "h1",
      password: "enc:p",
      encrypted: true,
    };
    await h.store.setForeignObject(STORE, {
      type: "meta",
      common: { name: "x", type: "meta.folder" },
      native: { rows: [stored] },
    });
    await h.handlers.get("ready")?.();
    // the start's id settling writes the rows once more in the store's own form — the stored cipher stays
    expect(rowsOf(h)).toMatchObject([stored]);
    expect(h.store.objects.has(STORE)).toBe(false);
    expect(h.store.logs.filter(l => l.level === "info").map(l => l.msg)).toContain(
      "1 program(s) moved from the object dl-manager.0.programs into the data folder of the instance",
    );
    expect(polls()).toBeGreaterThan(0);
  });

  it("only deletes the store object when the data folder holds the programs already (a start that stopped halfway)", async () => {
    const { h } = make();
    const inFile = rowsOf(h).map(r => r.id);
    await h.store.setForeignObject(STORE, {
      type: "meta",
      common: { name: "x", type: "meta.folder" },
      native: { rows: [{ id: "other" }] },
    });
    await h.handlers.get("ready")?.();
    expect(rowsOf(h).map(r => r.id)).toEqual(inFile);
    expect(h.store.objects.has(STORE)).toBe(false);
    expect(h.store.logs.some(l => l.msg.includes("moved from the object"))).toBe(false);
  });

  it("stops the start at a store file that holds no readable JSON — and keeps the file", async () => {
    const { h, polls } = make();
    writeFileSync(storeFile(h), "{ broken");
    await h.handlers.get("ready")?.();
    expect(
      h.store.logs
        .filter(l => l.level === "error")
        .map(l => l.msg)
        .join(),
    ).toContain("programs.json is no readable JSON");
    expect(readFileSync(storeFile(h), "utf8")).toBe("{ broken");
    expect(polls()).toBe(0);
  });

  it("starts a fresh installation without programs — no store, no error", async () => {
    const { h, polls } = make();
    noStore(h);
    await h.handlers.get("ready")?.();
    expect(h.store.logs.filter(l => l.level === "error")).toEqual([]);
    expect(hasStoreFile(h)).toBe(false);
    expect(h.store.val("info.programsTotal")).toBe(0);
    expect(polls()).toBe(0);
  });
});

describe("DownloadManagerAdapter — device manager", () => {
  interface Host {
    readRows(): Promise<Record<string, unknown>[]>;
    updateRows(change: (rows: Record<string, unknown>[]) => Record<string, unknown>[] | undefined): Promise<void>;
    hasObject(relId: string): Promise<boolean>;
    readState(relId: string): Promise<ioBroker.StateValue | undefined>;
    test(row: Record<string, unknown>): Promise<unknown>;
    iobHost(): string;
  }
  const hostOf = (h: Harness): Host => (h as unknown as { dmHost(): Host }).dmHost();

  it("takes the dm messages through the device manager — the adapter itself answers none", async () => {
    const { h } = make();
    await h.handlers.get("ready")?.();
    expect(h.handlers.has("message")).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it("listens for dm messages only once I18n, the known tree and the known values are there", async () => {
    const { h } = make();
    expect(h.handlers.has("message")).toBe(false);
    const seen: boolean[] = [];
    const objects = h.getObjectListAsync;
    const states = h.getStatesAsync;
    h.getObjectListAsync = p => (seen.push(h.handlers.has("message")), objects(p));
    h.getStatesAsync = p => (seen.push(h.handlers.has("message")), states(p));
    await h.handlers.get("ready")?.();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every(listening => !listening)).toBe(true);
    expect(h.handlers.has("message")).toBe(true);
  });

  it("builds no device manager when the start stops for a restart", async () => {
    const { h } = make();
    h.instanceObject = { common: { messagebox: true, supportedMessages: { deviceManager: true } }, native: {} };
    await h.handlers.get("ready")?.();
    expect(h.handlers.has("message")).toBe(false);
  });

  it("reads the rows from the store with readable secrets, skipping what is no row", async () => {
    const { h } = make();
    seedRows(h, [{ type: "deluge", password: "enc:pw", encrypted: true }, null, "x", [1], { type: "aria2" }] as never);
    expect(await hostOf(h).readRows()).toEqual([{ type: "deluge", password: "pw", apiKey: "" }, { type: "aria2" }]);
    noStore(h);
    expect(await hostOf(h).readRows()).toEqual([]);
    expect(hostOf(h).iobHost()).toBe("iobhost");
  });

  it("stores a change and takes it over at once — never through the instance object", async () => {
    const { h, polls, closed } = make();
    await h.handlers.get("ready")?.();
    await flush();
    const rows = await hostOf(h).readRows();
    await hostOf(h).updateRows(() => [
      ...rows,
      { id: "qbittorrent-h2", enabled: true, type: "qbittorrent", host: "h2", password: "x" },
    ]);
    await flush();
    expect(h.instanceWrites).toEqual([]);
    expect(rowsOf(h)[1]).toMatchObject({ id: "qbittorrent-h2", password: "enc:x", encrypted: true });
    expect(polls()).toBe(2);
    expect(h.store.objects.has("dl-manager.0.qbittorrent-h2")).toBe(true);
    await hostOf(h).updateRows(() => rows.map(r => ({ ...r, enabled: false })));
    expect(closed()).toBe(2);
    expect(h.store.objects.has("dl-manager.0.qbittorrent-h2")).toBe(false);
  });

  it("runs one row change after the other, each on the rows the change before stored", async () => {
    const { h } = make();
    await h.handlers.get("ready")?.();
    await flush();
    const adding =
      (id: string, host: string) =>
      (rows: Record<string, unknown>[]): Record<string, unknown>[] => [
        ...rows,
        { id, enabled: true, type: "qbittorrent", host, password: "x" },
      ];
    await Promise.all([
      hostOf(h).updateRows(adding("qbittorrent-ha", "ha")),
      hostOf(h).updateRows(adding("qbittorrent-hb", "hb")),
    ]);
    expect(rowsOf(h).map(r => r.id)).toEqual(expect.arrayContaining(["qbittorrent-ha", "qbittorrent-hb"]));
  });

  it("stores nothing when a change finds nothing to change", async () => {
    const { h } = make();
    seedRows(h, [{ id: "qbittorrent-nas", type: "qbittorrent", host: "h1", password: "p" }]);
    await h.handlers.get("ready")?.();
    const before = statSync(storeFile(h)).ino;
    await hostOf(h).updateRows(() => undefined);
    expect(statSync(storeFile(h)).ino).toBe(before);
  });

  it("writes nothing for an edit that changed nothing — a secret keeps its stored cipher", async () => {
    const { h } = make();
    seedRows(h, [
      { id: "qbittorrent-nas", type: "qbittorrent", host: "h1", password: "enc:p", apiKey: "", encrypted: true },
    ]);
    await h.handlers.get("ready")?.();
    // the store file is replaced by a rename — a write gives it a new inode
    const before = statSync(storeFile(h)).ino;
    await hostOf(h).updateRows(rows => rows);
    expect(statSync(storeFile(h)).ino).toBe(before);
  });

  it("stores the id My.JDownloader names; a waiting row of a local program gets its id at the start", async () => {
    const { h } = make();
    seedRows(h, [{ id: "qbittorrent-nas", idPending: true, enabled: true, type: "qbittorrent", host: "h1" }]);
    await h.handlers.get("ready")?.();
    await flush();
    expect(rowsOf(h)).toMatchObject([{ id: "qbittorrent-h1" }]);
    (h as unknown as { learnDeviceId(p: string, d: string): void }).learnDeviceId("qbittorrent-h1", "abc");
    // the store file is written through the file system — wait for it, not for a fixed number of ticks
    await vi.waitFor(() => expect(rowsOf(h)).toMatchObject([{ id: "qbittorrent-h1", deviceId: "abc" }]));
    expect(rowsOf(h)[0]).not.toHaveProperty("idPending");
    expect(h.store.objects.has("dl-manager.0.qbittorrent-nas")).toBe(false);
    expect(h.store.objects.has("dl-manager.0.qbittorrent-h1.online")).toBe(true);
  });

  it("knows the own objects and states", async () => {
    const { h } = make();
    await h.handlers.get("ready")?.();
    expect(await hostOf(h).hasObject("qbittorrent-nas.online")).toBe(true);
    expect(await hostOf(h).hasObject("qbittorrent-nas.nothing")).toBe(false);
    expect(await hostOf(h).readState("qbittorrent-nas.error")).toBe("Unknown");
    expect(await hostOf(h).readState("qbittorrent-nas.nothing")).toBeUndefined();
  });

  it("tests one row, before the start as well", async () => {
    const { h, closed } = make();
    expect(await hostOf(h).test({ type: "qbittorrent", key: "x", host: "h9" })).toEqual({
      ok: true,
      version: "4.6",
      downloads: 0,
    });
    expect(closed()).toBe(1);
  });
});

describe("DownloadManagerAdapter — unload", () => {
  it("calls back only after the programs are marked Unknown and the adapter disconnected", async () => {
    const { h, closed } = make();
    await h.handlers.get("ready")?.();
    await flush();
    let seen: { online: unknown; error: unknown; connection: unknown } | null = null;
    await new Promise<void>(resolve =>
      h.handlers.get("unload")?.(() => {
        seen = {
          online: h.store.val("qbittorrent-nas.online"),
          error: h.store.val("qbittorrent-nas.error"),
          connection: h.store.val("info.connection"),
        };
        resolve();
      }),
    );
    expect(closed()).toBe(1);
    expect(seen).toEqual({ online: false, error: "Unknown", connection: false });
  });

  it("forwards a user write and ignores an acknowledged one", async () => {
    const { h } = make();
    await h.handlers.get("ready")?.();
    await flush();
    await h.handlers.get("stateChange")?.("dl-manager.0.summary.pauseAll", { val: true, ack: true });
    expect(h.store.logs.some(l => l.msg.startsWith("pause all"))).toBe(false);
    await h.handlers.get("stateChange")?.("dl-manager.0.summary.pauseAll", { val: true, ack: false });
    expect(h.store.logs.some(l => l.msg === "pause all: paused 1 of 1 program(s)")).toBe(true);
  });

  it("forgets what it wrote to a state a user wrote, so the program's value goes out again", async () => {
    const { h } = make();
    await h.handlers.get("ready")?.();
    await flush();
    const states = (h as unknown as { states: { put(id: string, s: ioBroker.SettableState): Promise<void> } }).states;
    const id = "qbittorrent-nas.paused";
    await states.put(id, { val: false, ack: true });
    await h.store.setState(id, { val: true, ack: false });
    await h.handlers.get("stateChange")?.(`dl-manager.0.${id}`, { val: true, ack: false });
    await states.put(id, { val: false, ack: true });
    expect(h.store.states.get(`dl-manager.0.${id}`)).toMatchObject({ val: false, ack: true });
  });
});
