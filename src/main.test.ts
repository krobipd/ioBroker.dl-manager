import { vi } from "vitest";
import { FakeAdapter } from "../test/helpers/fake-adapter";

// Stub the adapter-core base: the adapter's object and state calls land in an in-memory FakeAdapter, so the tests
// read the result instead of counting mock calls.
vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public namespace = "dl-manager.0";
    public adapterDir = "/tmp";
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
    public getObjectAsync = (id: string): Promise<ioBroker.Object | null> => this.store.getObject(id);
    public getObjectListAsync = (p: { startkey: string; endkey: string }): Promise<unknown> =>
      this.store.getObjectList(p);
    public getForeignObjectsAsync = (p: string, t: ioBroker.ObjectType): Promise<Record<string, ioBroker.Object>> =>
      this.store.getForeignObjects(p, t);
    public getForeignObjectAsync = (id: string): Promise<unknown> =>
      Promise.resolve(id.startsWith("system.adapter.") ? structuredClone(this.instanceObject) : null);
    public extendForeignObjectAsync = (id: string, obj: unknown): Promise<void> => {
      this.instanceWrites.push({ id, obj });
      return Promise.resolve();
    };
    public getStateAsync = (id: string): Promise<ioBroker.State | null> => this.store.getState(id);
    public setState = (id: string, st: ioBroker.SettableState): Promise<void> => this.store.setState(id, st);
    public setStateChangedAsync = (id: string, st: ioBroker.SettableState): Promise<void> =>
      this.store.setStateChanged(id, st);
    public getStatesAsync = (p: string): Promise<Record<string, ioBroker.State>> => this.store.getStates(p);
    public subscribeStatesAsync = (): Promise<void> => Promise.resolve();
    public setTimeout = (): undefined => undefined;
    public clearTimeout = (): void => undefined;
    public decrypt = (v: string): string => v;
    public registerNotification = (_scope: string, _cat: string, msg: string): Promise<void> => {
      this.notifications.push(msg);
      return Promise.resolve();
    };
    public sendTo = (...args: unknown[]): void => void this.sent.push(args);
    public constructor(_opts: unknown) {}
  }
  return {
    Adapter,
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
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
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
  h.config.programs = [{ enabled: true, type: "qbittorrent", key: "nas", name: "NAS", host: "h1" }];
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
    [...h.store.objects.values()].filter(o => o.type === "channel").map(o => o.native.key);

  it("removes only a leftover stopInstance entry — deviceManager stays — and stops for the restart", async () => {
    for (const leftover of [true, false]) {
      const { h, polls } = make();
      h.instanceObject = { common: { supportedMessages: { deviceManager: true, stopInstance: leftover } }, native: {} };
      await h.handlers.get("ready")?.();
      expect(h.instanceWrites).toEqual([
        { id: "system.adapter.dl-manager.0", obj: { common: { supportedMessages: { stopInstance: null } } } },
      ]);
      expect(polls()).toBe(0);
      expect(h.store.objectWrites).toBe(0);
    }
  });

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
    h.store.objectWrites = 0;
    await h.handlers.get("ready")?.();
    await flush();
    expect(h.store.objectWrites).toBe(0);
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

  it("hands the stored secrets to the program as they are — the table does not encrypt them", async () => {
    const { h, configs } = make();
    (h as unknown as { decrypt: (v: string) => string }).decrypt = () => "garbled";
    h.config.programs = [{ enabled: true, type: "qbittorrent", key: "nas", host: "h1", password: "p", apiKey: "k" }];
    await h.handlers.get("ready")?.();
    expect(configs.map(c => [c.password, c.apiKey])).toEqual([["p", "k"]]);
  });

  it("starts normally with the device manager entry and no stopInstance, or a stopInstance already nulled", async () => {
    for (const supported of [{ deviceManager: true }, { deviceManager: true, stopInstance: null }, null]) {
      const { h, polls } = make();
      h.instanceObject = { common: { supportedMessages: supported }, native: {} };
      await h.handlers.get("ready")?.();
      expect(h.instanceWrites).toEqual([]);
      expect(polls()).toBe(1);
    }
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
  });
});

describe("DownloadManagerAdapter — device manager", () => {
  interface Host {
    readRows(): Promise<Record<string, unknown>[]>;
    writeRows(rows: Record<string, unknown>[]): Promise<void>;
    hasObject(relId: string): Promise<boolean>;
    readState(relId: string): Promise<ioBroker.StateValue | undefined>;
    writeState(relId: string, val: ioBroker.StateValue): Promise<void>;
    test(row: Record<string, unknown>): Promise<unknown>;
  }
  const hostOf = (h: Harness): Host => (h as unknown as { deviceManagement: { host: Host } }).deviceManagement.host;

  it("takes the dm messages through the device manager — the adapter itself answers none", () => {
    const { h } = make();
    expect(h.handlers.has("message")).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it("reads the rows fresh from the instance object, skipping what is no row", async () => {
    const { h } = make();
    h.instanceObject = { common: {}, native: { programs: [{ type: "deluge" }, null, "x", [1], { type: "aria2" }] } };
    expect(await hostOf(h).readRows()).toEqual([{ type: "deluge" }, { type: "aria2" }]);
    h.instanceObject = { common: {}, native: {} };
    expect(await hostOf(h).readRows()).toEqual([]);
  });

  it("stores the rows in the instance object", async () => {
    const { h } = make();
    await hostOf(h).writeRows([{ type: "deluge" }]);
    expect(h.instanceWrites).toEqual([
      { id: "system.adapter.dl-manager.0", obj: { native: { programs: [{ type: "deluge" }] } } },
    ]);
  });

  it("writes a card's switch the way a user does, and knows the own objects", async () => {
    const { h } = make();
    await h.handlers.get("ready")?.();
    await hostOf(h).writeState("qbittorrent-nas.paused", true);
    expect(h.store.states.get("dl-manager.0.qbittorrent-nas.paused")).toMatchObject({ val: true, ack: false });
    expect(await hostOf(h).hasObject("qbittorrent-nas.online")).toBe(true);
    expect(await hostOf(h).hasObject("qbittorrent-nas.nothing")).toBe(false);
    expect(await hostOf(h).readState("qbittorrent-nas.paused")).toBe(true);
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
