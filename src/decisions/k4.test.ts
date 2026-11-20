// Core decision K4 (accepted 2026-10-22, its program list dropped 2026-11-19 18:54): what a program can do decides its
// datapoints; a program without a pause of its own gets one from the adapter: it stops only the downloads that run and
// later resumes exactly these, also after a restart. krobi 2026-10-22 22:25, on K4 (datapoints by capability) and K6
// (the made pause): "k4 and k6 are the same in content" · 22:28, on the whole page: "all ok so far".
import { describe, expect, it, vi } from "vitest";
import { ITEM_DATAPOINTS, PROGRAM_DATAPOINTS } from "../lib/core/datapoints";
import { EmulatedPause, objectPauseStore } from "../lib/core/emulated-pause";
import type { DriverDeps, ProgramConfig, ProgramDriver } from "../lib/core/model";
import { ProgramTree, type TreeAdapter } from "../lib/core/tree";
import { CATALOG } from "../lib/programs/catalog";
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

/**
 * Two downloads in every program: the first runs, the second does not. Each mocked client shows them in its program's
 * own form and moves one between the two when the adapter stops or starts it; `stopped` and `started` record whom.
 */
const world = vi.hoisted(() => ({
  running: new Set<string>(),
  qbVersion: "v5.2.0",
  stopped: [] as string[],
  started: [] as string[],
  halt(keys: string[]): void {
    for (const k of keys) {
      this.stopped.push(k);
      this.running.delete(k);
    }
  },
  wake(keys: string[]): void {
    for (const k of keys) {
      this.started.push(k);
      this.running.add(k);
    }
  },
}));

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));
// Each program's client is replaced by one that answers from `world` — this guard checks what the driver asks.
vi.mock("../lib/programs/transmission/client", () => ({
  TrClient: class {
    call(method: string, params: { ids?: string[] } = {}): Promise<Record<string, unknown>> {
      switch (method) {
        case "torrent_get":
          return Promise.resolve({
            torrents: ["1", "2"].map(h => ({ hash_string: h, name: h, status: world.running.has(h) ? 4 : 0 })),
          });
        case "session_get":
          return Promise.resolve({ version: "4.0.6 (38c164933e)", az_version: "5.7.6.0", download_dir: "" });
        case "session_stats":
          return Promise.resolve({});
        case "torrent_stop":
          world.halt(params.ids ?? []);
          break;
        case "torrent_start":
          world.wake(params.ids ?? []);
          break;
      }
      return Promise.resolve({});
    }
    close(): void {}
  },
}));
vi.mock("../lib/programs/qbittorrent/client", () => ({
  QbClient: class {
    needsLogin = false;
    get(path: string): Promise<{ text: string; json: () => unknown }> {
      if (path === "app/version") {
        return Promise.resolve({ text: world.qbVersion, json: () => ({}) });
      }
      const state = (h: string): string => (world.running.has(h) ? "downloading" : "stoppedDL");
      const torrents = Object.fromEntries(["1", "2"].map(h => [h, { name: h, state: state(h) }]));
      return Promise.resolve({ text: "", json: () => ({ full_update: true, rid: 1, torrents, server_state: {} }) });
    }
    post(method: string, params: { hashes?: string } = {}): Promise<string> {
      const keys = params.hashes?.split("|") ?? [];
      if (method === "torrents/stop") {
        world.halt(keys);
      } else if (method === "torrents/start") {
        world.wake(keys);
      }
      return Promise.resolve("");
    }
    close(): void {}
  },
}));
vi.mock("../lib/programs/aria2/client", () => ({
  nodeSocket: () => ({ addEventListener: () => undefined, close: () => undefined }),
  AriaClient: class {
    multicall(): Promise<unknown[]> {
      const entry = (gid: string): Record<string, unknown> => ({
        gid,
        status: world.running.has(gid) ? "active" : "paused",
      });
      const active = ["1", "2"].filter(g => world.running.has(g)).map(entry);
      const waiting = ["1", "2"].filter(g => !world.running.has(g)).map(entry);
      return Promise.resolve([{ version: "1.37.0" }, active, waiting, [], {}, {}]);
    }
    call(method: string, params: string[]): Promise<unknown> {
      if (method === "aria2.pause") {
        world.halt(params);
      } else if (method === "aria2.unpause") {
        world.wake(params);
      }
      return Promise.resolve("OK");
    }
    close(): void {}
  },
}));
vi.mock("../lib/programs/rqbit/client", () => ({
  RqClient: class {
    get(path: string): Promise<unknown> {
      if (path === "/") {
        return Promise.resolve({ version: "9.1.0" });
      }
      if (path === "/stats") {
        return Promise.resolve({ download_speed: { mbps: 0 }, upload_speed: { mbps: 0 } });
      }
      const stats = (h: string): Record<string, unknown> => ({ state: world.running.has(h) ? "live" : "paused" });
      return Promise.resolve({ torrents: ["1", "2"].map(h => ({ info_hash: h, name: h, stats: stats(h) })) });
    }
    getIfServed(): Promise<unknown> {
      return Promise.resolve(undefined);
    }
    post(path: string): Promise<unknown> {
      const [, , key, verb] = path.split("/");
      if (verb === "pause") {
        world.halt([key]);
      } else if (verb === "start") {
        world.wake([key]);
      }
      return Promise.resolve({});
    }
    close(): void {}
  },
}));
vi.mock("../lib/programs/rtorrent/client", () => ({
  RtClient: class {
    call(method: string, ...params: unknown[]): Promise<unknown> {
      if (method === "d.stop") {
        world.halt([String(params[0])]);
      } else if (method === "d.start") {
        world.wake([String(params[0])]);
      }
      return Promise.resolve(method === "system.client_version" ? "0.9.8" : 0);
    }
    multicall(): Promise<unknown[]> {
      // hash, name, state, is_open, is_active, complete, hashing, is_hash_checking, then 11 numbers and texts, held mark
      const row = (h: string): unknown[] => {
        const on = world.running.has(h) ? 1 : 0;
        return [h, h, on, 1, on, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, "", "", 0, 0, ""];
      };
      return Promise.resolve([0, 0, 0, 0, ["1", "2"].map(row)]);
    }
    close(): void {}
  },
}));
vi.mock("../lib/programs/tribler/client", () => ({
  TblClient: class {
    send(method: string, path: string, json?: { state?: string }): Promise<unknown> {
      if (path === "/api/versioning/versions/current") {
        return Promise.resolve({ version: "8.0.7" });
      }
      if (path === "/api/settings") {
        return Promise.resolve({ settings: {} });
      }
      if (method === "GET") {
        const status = (h: string): string => (world.running.has(h) ? "DOWNLOADING" : "STOPPED");
        return Promise.resolve({ downloads: ["1", "2"].map(h => ({ infohash: h, name: h, status: status(h) })) });
      }
      const key = path.split("/").pop() ?? "";
      if (json?.state === "stop") {
        world.halt([key]);
      } else if (json?.state === "resume") {
        world.wake([key]);
      }
      return Promise.resolve({});
    }
    close(): void {}
  },
}));
vi.mock("../lib/programs/flood/client", () => ({
  FloodClient: class {
    version(): Promise<string | null> {
      return Promise.resolve("4.8.0");
    }
    send(method: string, path: string, json?: { hashes?: string[] }): Promise<unknown> {
      if (path === "/client/settings") {
        return Promise.resolve({
          throttleGlobalDownSpeed: 0,
          throttleGlobalUpSpeed: 0,
          networkMaxOpenFiles: 0,
          piecesMemoryMax: 0,
        });
      }
      if (path === "/torrents" && method === "GET") {
        const status = (h: string): string[] => [world.running.has(h) ? "downloading" : "stopped"];
        return Promise.resolve({
          torrents: Object.fromEntries(["1", "2"].map(h => [h, { hash: h, name: h, status: status(h) }])),
        });
      }
      if (path === "/torrents/stop") {
        world.halt(json?.hashes ?? []);
      } else if (path === "/torrents/start") {
        world.wake(json?.hashes ?? []);
      }
      return Promise.resolve({});
    }
    close(): void {}
  },
}));
vi.mock("../lib/programs/utorrent/client", () => ({
  UtClient: class {
    paused = new Set<string>();
    tryCall(): Promise<Record<string, unknown>> {
      return Promise.resolve({ version: { major_version: 3, minor_version: 5, tiny_version: 5 }, build: 46348 });
    }
    call(query: string): Promise<Record<string, unknown>> {
      const keys = query
        .split("&")
        .filter(p => p.startsWith("hash="))
        .map(p => p.slice(5));
      if (query.startsWith("action=pause")) {
        world.halt(keys);
      } else if (query.startsWith("action=unpause")) {
        world.wake(keys);
      }
      if (query === "list=1") {
        // started 1, paused 32, loaded 128: the running one is started, the other only loaded
        return Promise.resolve({ build: 46348, torrents: ["1", "2"].map(h => [h, world.running.has(h) ? 129 : 128]) });
      }
      return Promise.resolve({ settings: [] });
    }
    close(): void {}
  },
}));
vi.mock("../lib/programs/hadouken/client", () => ({
  HkClient: class {
    call(method: string, params?: unknown[]): Promise<unknown> {
      switch (method) {
        case "core.getSystemInfo":
          return Promise.resolve({ versions: { hadouken: "5.2.0" } });
        case "webui.list":
          return Promise.resolve({ torrents: ["1", "2"].map(h => [h, world.running.has(h) ? 1 : 0]) });
        case "webui.getSettings":
          return Promise.resolve({ settings: [] });
        case "webui.perform": {
          const [verb, keys] = params as [string, string[]];
          if (verb === "pause") {
            world.halt(keys);
          } else if (verb === "start") {
            world.wake(keys);
          }
          return Promise.resolve(null);
        }
      }
      return Promise.resolve(null);
    }
    close(): void {}
  },
}));
vi.mock("../lib/programs/downloadstation/client", async importOriginal => ({
  ...(await importOriginal<object>()),
  DsClient: class {
    call(api: string, method: string, params: Record<string, string> = {}): Promise<unknown> {
      if (api === "SYNO.DownloadStation.Info") {
        return Promise.resolve(method === "getinfo" ? { version_string: "3.9.0-4627", is_manager: true } : {});
      }
      if (method === "list") {
        const status = (id: string): string => (world.running.has(id) ? "downloading" : "paused");
        return Promise.resolve({ tasks: ["1", "2"].map(id => ({ id, title: id, status: status(id) })) });
      }
      const keys = (params.id ?? "").split(",");
      if (method === "pause") {
        world.halt(keys);
      } else if (method === "resume") {
        world.wake(keys);
      }
      return Promise.resolve(keys.map(id => ({ id, error: 0 })));
    }
    reset(): void {}
    close(): void {}
  },
}));
vi.mock("../lib/programs/nzbvortex/client", () => ({
  NvClient: class {
    get(resource: string): Promise<Record<string, unknown>> {
      if (resource === "app/appversion") {
        return Promise.resolve({ appversion: "3.4.11" });
      }
      if (resource === "speedlimit") {
        return Promise.resolve({ speedlimit_enabled: false });
      }
      if (resource === "nzb") {
        // state 2 downloads; paused or not is its own flag
        return Promise.resolve({
          nzbs: ["1", "2"].map(id => ({ id: Number(id), state: 2, isPaused: !world.running.has(id) })),
        });
      }
      const [, key, verb] = resource.split("/");
      if (verb === "pause") {
        world.halt([key]);
      } else if (verb === "resume") {
        world.wake([key]);
      }
      return Promise.resolve({ result: "ok" });
    }
    reset(): void {}
    close(): void {}
  },
}));
vi.mock("../lib/programs/freebox/client", () => ({
  FbxClient: class {
    apiVersion(): Promise<Record<string, unknown>> {
      return Promise.resolve({ api_version: "8.0" });
    }
    call(method: string, resource: string, body?: { json?: { status?: string } }): Promise<unknown> {
      if (method === "GET" && resource === "downloads/config/") {
        return Promise.resolve({ throttling: { normal: { rx_rate: 0, tx_rate: 0 } } });
      }
      if (method === "GET" && resource === "downloads/") {
        const status = (id: string): string => (world.running.has(id) ? "downloading" : "stopped");
        return Promise.resolve(["1", "2"].map(id => ({ id: Number(id), name: id, type: "bt", status: status(id) })));
      }
      const key = resource.split("/").pop() ?? "";
      if (body?.json?.status === "stopped") {
        world.halt([key]);
      } else if (body?.json?.status === "downloading") {
        world.wake([key]);
      }
      return Promise.resolve(null);
    }
    reset(): void {}
    close(): void {}
  },
}));

const CFG: ProgramConfig = {
  type: "",
  name: "guard",
  host: "192.0.2.1",
  port: 0,
  https: false,
  path: "",
  username: "user",
  password: "pw",
  apiKey: "key",
  device: "",
  deviceId: "",
};
const quiet = (): void => undefined;

/** The `paused` datapoint's object, which keeps the adapter-made pause across a restart. */
function pausedObject(): {
  getForeignObjectAsync: (id: string) => Promise<ioBroker.Object>;
  setForeignObject: (id: string, o: ioBroker.SettableObject) => Promise<void>;
} {
  let obj = { type: "state", common: {}, native: {} } as unknown as ioBroker.Object;
  return {
    getForeignObjectAsync: () => Promise.resolve(structuredClone(obj)),
    setForeignObject: (_id, o) => {
      obj = structuredClone(o) as ioBroker.Object;
      return Promise.resolve();
    },
  };
}

/**
 * @param type a program type
 * @param deps adapter services of this start
 * @returns the program's driver as the adapter builds it
 */
const driverOf = (type: string, deps: DriverDeps): ProgramDriver => findProgram(type)!.create({ ...CFG, type }, deps);
const plainDeps = (): DriverDeps => ({
  setTimeout: () => undefined,
  clearTimeout: () => undefined,
  log: { debug: quiet, info: quiet, warn: quiet },
});

/** Every program whose driver makes the pause itself — read from the drivers, never listed by hand. */
const MADE_PAUSE = CATALOG.map(p => p.type).filter(type =>
  Object.values(driverOf(type, plainDeps())).some(v => v instanceof EmulatedPause),
);

describe("K4 what a program can do decides its datapoints; a missing program pause is made by the adapter", () => {
  it("gives every program the datapoints of exactly what it can do", async () => {
    for (const { type } of CATALOG) {
      const driver = driverOf(type, plainDeps());
      const ids: string[] = [];
      const a: TreeAdapter = {
        namespace: "dl-manager.0",
        log: { debug: quiet, info: quiet, warn: quiet },
        extendObject: (id, obj) => Promise.resolve(void (obj.type === "state" && ids.push(id))),
        removeObject: () => Promise.resolve(),
        knownObject: () => undefined,
        getForeignObjects: () => Promise.resolve({}),
        knownValue: () => undefined,
        setState: () => Promise.resolve(),
        setStateChanged: () => Promise.resolve(),
      };
      const tree = new ProgramTree(a, "p", "P", driver, { scope: "all", limit: 0 });
      await tree.ensureDevice(undefined);
      await tree.sync({
        status: { version: "1", paused: false, downloadBps: 0 },
        items: [
          {
            key: "k",
            name: "k",
            status: "queued",
            sizeBytes: 1,
            doneBytes: 0,
            speedBps: 0,
            etaSeconds: null,
            error: "",
          },
        ],
        complete: true,
      });
      const rel = ids.map(id => id.slice("dl-manager.0.p.".length));
      const item = rel.filter(id => id.startsWith("downloads.")).map(id => id.split(".").slice(2).join("."));
      const can = (d: { capability?: string }): boolean =>
        !d.capability || driver.capabilities.has(d.capability as never);
      // a download's datapoint stands exactly when the program can do what it shows
      for (const d of ITEM_DATAPOINTS) {
        expect(item.includes(d.id), `${type} downloads.*.${d.id}`).toBe(can(d));
      }
      // a program's own datapoint never stands for something it cannot do
      for (const d of PROGRAM_DATAPOINTS.filter(x => !can(x))) {
        expect(rel, `${type} ${d.id}`).not.toContain(d.id);
      }
    }
  });

  it("gives every program a pause of the whole program, its own or one the adapter makes", () => {
    need(MADE_PAUSE.length > 0, "no program whose pause the adapter makes");
    for (const { type } of CATALOG) {
      expect(driverOf(type, plainDeps()).capabilities.has("globalPause"), type).toBe(true);
    }
  });

  for (const type of MADE_PAUSE) {
    it(`pauses ${type} by stopping only what runs, and resumes exactly that after a restart`, async () => {
      // every program lists the same two downloads: 1 runs, 2 does not
      const [run, idle] = ["1", "2"];
      world.running = new Set([run]);
      world.qbVersion = "v5.2.0";
      world.stopped = [];
      world.started = [];
      const store = pausedObject();
      const deps = (): DriverDeps => ({ ...plainDeps(), pauseStore: objectPauseStore(store, "dl-manager.0.p.paused") });
      const before = driverOf(type, deps());
      await before.poll();
      await before.command({ kind: "pauseAll" });
      expect(world.stopped).toEqual([run]);
      expect(world.running.size).toBe(0);
      expect((await before.poll()).status.paused).toBe(true);

      // the adapter restarts: a new driver, the pause read back from the datapoint's object
      const after = driverOf(type, deps());
      expect((await after.poll()).status.paused).toBe(true);
      await after.command({ kind: "resumeAll" });
      expect(world.started).toEqual([run]);
      expect([...world.running]).toEqual([run]);
      expect([...world.stopped, ...world.started]).not.toContain(idle);
    });
  }
});
