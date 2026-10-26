// Core decision K4 (accepted 2026-10-22, krobi: "alle soweit ok"; 22:25: "k4 and k6 are the same in content"): what a
// program can do decides its datapoints — SABnzbd has no speed per download, pyLoad no pause per download, only torrent
// programs know upload and ratio. A program without a pause of its own (Transmission, aria2, qBittorrent before 5.3) gets
// one from the adapter: it stops only the downloads that run and later resumes exactly these, also after a restart.
import { describe, expect, it, vi } from "vitest";
import { objectPauseStore } from "../lib/core/emulated-pause";
import type { Capability, DriverDeps, ProgramConfig, ProgramDriver } from "../lib/core/model";
import { ProgramTree, type TreeAdapter } from "../lib/core/tree";
import { findProgram } from "../lib/programs/registry";

/** The programs as the mocked clients see them, and every request that changes something. */
const world = vi.hoisted(() => ({
  running: new Set<string>(),
  qbVersion: "v5.2.0",
  sent: [] as { program: string; method: string; params: unknown }[],
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
            torrents: ["a", "b"].map(h => ({ hash_string: h, name: h, status: world.running.has(h) ? 4 : 0 })),
          });
        case "session_get":
          return Promise.resolve({ version: "4.0.6 (38c164933e)", download_dir: "" });
        case "session_stats":
          return Promise.resolve({});
      }
      world.sent.push({ program: "transmission", method, params });
      for (const id of params.ids ?? []) {
        if (method === "torrent_stop") {
          world.running.delete(id);
        } else if (method === "torrent_start") {
          world.running.add(id);
        }
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
      const torrents = Object.fromEntries(["a", "b"].map(h => [h, { name: h, state: state(h) }]));
      return Promise.resolve({ text: "", json: () => ({ full_update: true, rid: 1, torrents, server_state: {} }) });
    }
    post(method: string, params: { hashes?: string } = {}): Promise<string> {
      world.sent.push({ program: "qbittorrent", method, params });
      for (const h of params.hashes?.split("|") ?? []) {
        if (method === "torrents/stop") {
          world.running.delete(h);
        } else if (method === "torrents/start") {
          world.running.add(h);
        }
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
      const active = ["a", "b"].filter(g => world.running.has(g)).map(entry);
      const waiting = ["a", "b"].filter(g => !world.running.has(g)).map(entry);
      return Promise.resolve([{ version: "1.37.0" }, active, waiting, [], {}, {}]);
    }
    call(method: string, params: string[]): Promise<unknown> {
      world.sent.push({ program: "aria2", method, params });
      if (method === "aria2.pause") {
        world.running.delete(params[0]);
      } else if (method === "aria2.unpause") {
        world.running.add(params[0]);
      }
      return Promise.resolve("OK");
    }
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
  username: "",
  password: "",
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

describe("K4 what a program can do decides its datapoints; a missing program pause is made by the adapter", () => {
  it("gives every program only the datapoints of what it can do", async () => {
    const deps: DriverDeps = {
      setTimeout: () => undefined,
      clearTimeout: () => undefined,
      log: { debug: quiet, info: quiet, warn: quiet },
    };
    const caps = (type: string): ReadonlySet<Capability> => driverOf(type, deps).capabilities;
    expect(caps("sabnzbd").has("itemSpeed")).toBe(false);
    expect(caps("pyload").has("itemPause")).toBe(false);
    for (const type of ["jdownloader", "jdownloader-cloud", "sabnzbd", "nzbget", "pyload"]) {
      expect(caps(type).has("upload"), type).toBe(false);
    }
    for (const type of ["qbittorrent", "transmission", "deluge"]) {
      expect(caps(type).has("upload"), type).toBe(true);
    }

    const datapoints = async (type: string): Promise<{ program: string[]; item: string[] }> => {
      const ids: string[] = [];
      const a: TreeAdapter = {
        namespace: "dl-manager.0",
        log: { debug: quiet, info: quiet, warn: quiet },
        extendObject: (id, obj) => Promise.resolve(void (obj.type === "state" && ids.push(id))),
        delObject: () => Promise.resolve(),
        knownObject: () => undefined,
        getForeignObjects: () => Promise.resolve({}),
        knownValue: () => undefined,
        setState: () => Promise.resolve(),
        setStateChanged: () => Promise.resolve(),
      };
      const tree = new ProgramTree(a, "p", "P", driverOf(type, deps), { scope: "all", limit: 0 });
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
      return {
        program: rel.filter(id => !id.startsWith("downloads.")),
        item: rel.filter(id => id.startsWith("downloads.")).map(id => id.split(".").slice(2).join(".")),
      };
    };
    const sab = await datapoints("sabnzbd");
    expect(sab.item).not.toContain("speed");
    expect(sab.item).not.toContain("uploadSpeed");
    expect(sab.item).not.toContain("ratio");
    expect(sab.program).not.toContain("uploadSpeed");
    expect((await datapoints("pyload")).item).not.toContain("paused");
    const qb = await datapoints("qbittorrent");
    expect(qb.item).toEqual(expect.arrayContaining(["speed", "uploadSpeed", "ratio", "paused"]));
  });

  for (const [type, version] of [
    ["transmission", ""],
    ["aria2", ""],
    ["qbittorrent", "v5.2.0"],
  ] as const) {
    it(`pauses ${type}${version ? ` ${version}` : ""} by stopping only what runs, and resumes exactly that after a restart`, async () => {
      world.running = new Set(["a"]);
      world.qbVersion = version || world.qbVersion;
      world.sent = [];
      const store = pausedObject();
      const deps = (): DriverDeps => ({
        setTimeout: () => undefined,
        clearTimeout: () => undefined,
        log: { debug: quiet, info: quiet, warn: quiet },
        pauseStore: objectPauseStore(store, "dl-manager.0.p.paused"),
      });
      const before = driverOf(type, deps());
      await before.poll();
      await before.command({ kind: "pauseAll" });
      expect(world.running.size).toBe(0);
      expect((await before.poll()).status.paused).toBe(true);
      const stopped = world.sent.map(s => s.params);

      // the adapter restarts: a new driver, the pause read back from the datapoint's object
      const after = driverOf(type, deps());
      expect((await after.poll()).status.paused).toBe(true);
      world.sent = [];
      await after.command({ kind: "resumeAll" });
      expect([...world.running]).toEqual(["a"]);
      expect(world.sent).toHaveLength(1);
      expect(stopped).toHaveLength(1);
      expect(JSON.stringify([stopped, world.sent])).not.toContain('"b"');
    });
  }

  it("leaves qBittorrent 5.3 and later its own pause", async () => {
    world.running = new Set(["a"]);
    world.qbVersion = "v5.3.0";
    world.sent = [];
    const driver = driverOf("qbittorrent", {
      setTimeout: () => undefined,
      clearTimeout: () => undefined,
      log: { debug: quiet, info: quiet, warn: quiet },
    });
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    expect(world.sent.map(s => s.method)).toEqual(["transfer/pauseSession"]);
  });
});
