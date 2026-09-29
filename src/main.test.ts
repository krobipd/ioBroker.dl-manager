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

import type { ProgramConfig, ProgramEntry } from "./lib/programs/registry";
import type { ProgramDriver, ProgramSnapshot } from "./lib/core/model";
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
  it("stops at once after nulling a leftover supportedMessages", async () => {
    const { h, polls } = make();
    h.instanceObject = { common: { supportedMessages: { stopInstance: true } }, native: {} };
    await h.handlers.get("ready")?.();
    expect(h.instanceWrites).toEqual([
      { id: "system.adapter.dl-manager.0", obj: { common: { supportedMessages: null } } },
    ]);
    expect(polls()).toBe(0);
    expect(h.store.objectWrites).toBe(0);
  });

  it("hands the stored secrets to the program as they are — the table does not encrypt them", async () => {
    const { h, configs } = make();
    (h as unknown as { decrypt: (v: string) => string }).decrypt = () => "garbled";
    h.config.programs = [{ enabled: true, type: "qbittorrent", key: "nas", host: "h1", password: "p", apiKey: "k" }];
    await h.handlers.get("ready")?.();
    expect(configs.map(c => [c.password, c.apiKey])).toEqual([["p", "k"]]);
  });

  it("starts normally when the instance object already carries supportedMessages null", async () => {
    const { h, polls } = make();
    h.instanceObject = { common: { supportedMessages: null }, native: {} };
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

describe("DownloadManagerAdapter — messages", () => {
  it("answers the connection test with one line per program of the form", async () => {
    const { h } = make();
    await h.handlers.get("message")?.({
      command: "testConnections",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { programs: [{ enabled: true, type: "qbittorrent", key: "x", host: "h9" }] },
    });
    expect(h.sent).toEqual([
      [
        "system.adapter.admin.0",
        "testConnections",
        { result: "qbittorrent-x: OK — version 4.6, 0 download(s)" },
        { id: 1 },
      ],
    ]);
  });

  it("answers nothing to a message without callback", async () => {
    const { h } = make();
    await h.handlers.get("message")?.({ command: "bogus", from: "x", message: {} });
    expect(h.sent).toEqual([]);
  });

  it("answers an unknown command instead of letting the caller wait", async () => {
    const { h } = make();
    await h.handlers.get("message")?.({ command: "bogus", from: "x", callback: { id: 2 }, message: {} });
    expect(h.sent).toEqual([["x", "bogus", { error: "Unknown command: bogus" }, { id: 2 }]]);
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
});
