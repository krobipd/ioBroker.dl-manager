import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer, type FixtureAnswer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import { AuthError, ProtocolError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { baseUrl, catalogEntry } from "../catalog";
import { HkDriver } from "./driver";
import { mapHkStatus, statusTable } from "./map";

/** The recording: Hadouken 5.2.0 with libtorrent 1.0.5 (live-programs run 43714685079, `test/live/programs/hadouken.mjs`). */
const VERSION = "5.2.0";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const cfg = (base: string, password = "good"): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "hadouken",
    deviceId: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "/api",
    username: "admin",
    password,
    apiKey: "",
    device: "",
  };
};

/**
 * @param state state folder
 * @returns the rows of the recorded `webui.list`
 */
const rows = (state: string): unknown[][] =>
  (loadFixture("hadouken", VERSION, state, "list").body as { result: { torrents: unknown[][] } }).result.torrents;

/**
 * @param state state folder
 * @returns the recorded hashes by torrent name
 */
const hashOf = (state: string): Record<string, string> =>
  Object.fromEntries(rows(state).map(r => [String(r[2]), String(r[0])]));

/** What the recorded Hadouken answers; the test changes it between calls. */
interface HkState {
  /** State folder of `webui.list` and `webui.getSettings`. */
  state: string;
  /** `webui.getProperties` names the torrent outside the queue (recording `probe/get-properties-paused`). */
  forced?: boolean;
  /** `core.getSystemInfo` without Hadouken's version. */
  noVersion?: boolean;
}

/**
 * One JSON-RPC call as the driver sent it.
 *
 * @param call the request the server saw
 * @returns method and parameters
 */
const rpcOf = (call: RecordedCall): { method: string; params: unknown[] } => {
  const { method, params } = JSON.parse(call.body) as { method: string; params: unknown[] };
  return { method, params };
};

/** Requests Hadouken answered with 401 — its "login" is basic auth on every request. */
const rejected = new Set<RecordedCall>();

/**
 * Hadouken from the recordings: basic auth on every request (401 with Hadouken's realm otherwise, recording `auth/wrong`),
 * the recorded answer of each method under the id of the call.
 *
 * @param s the answers, read at every request
 * @returns the running server
 */
function hadoukenServer(s: HkState = { state: "running" }): Promise<ContractServer> {
  const good = `Basic ${Buffer.from("admin:good").toString("base64")}`;
  const refused = loadFixture("hadouken", VERSION, "auth", "wrong");
  return startFixtureServer((call): FixtureAnswer => {
    if (call.headers.authorization !== good) {
      rejected.add(call);
      return { status: refused.status, body: "", headers: refused.headers };
    }
    const { method, id } = JSON.parse(call.body) as { method: string; id: number };
    const answer = (state: string, name: string): FixtureAnswer => ({
      body: { ...(loadFixture("hadouken", VERSION, state, name).body as object), id },
    });
    switch (method) {
      case "core.getSystemInfo":
        return s.noVersion
          ? { body: { id, jsonrpc: "2.0", result: { versions: { libtorrent: "1.0.5.0" } } } }
          : answer("probe", "get-system-info");
      case "webui.list":
        return answer(s.state, "list");
      case "webui.getSettings":
        return answer(s.state, "get-settings");
      case "webui.getProperties":
        return answer("probe", s.forced ? "get-properties-paused" : "get-properties-managed");
      default:
        // every recorded command answers without a result (webui.perform, webui.setProperties, webui.setSettings, a
        // webui.addTorrent of a URL)
        return answer("commands", "start");
    }
  });
}

runDriverContract({
  type: "hadouken",
  server: () => hadoukenServer(),
  makeDriver: (base, creds) => new HkDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }),
  mapStatus: mapHkStatus,
  statusTable,
  unknownStatus: "Status_Unknown",
  commandCalls: {
    pauseAll: { method: "POST", path: "/api", bodyContains: '"method":"webui.perform","params":["pause",[' },
    resumeAll: { method: "POST", path: "/api", bodyContains: '"method":"webui.perform","params":["start",[' },
    pause: { method: "POST", path: "/api", bodyContains: '"method":"webui.perform","params":["pause",[' },
    resume: { method: "POST", path: "/api", bodyContains: '"method":"webui.perform","params":["start",[' },
    remove: { method: "POST", path: "/api", bodyContains: '"method":"webui.perform","params":["remove",[' },
    add: { method: "POST", path: "/api", bodyContains: '"method":"webui.addTorrent","params":["url","magnet:' },
    // libtorrent's session takes bytes per second (webui_setSettings.js → session_settings.download_rate_limit)
    setSpeedLimit: { method: "POST", path: "/api", bodyContains: '"params":[{"max_dl_rate":2000000}]' },
    setUploadLimit: { method: "POST", path: "/api", bodyContains: '"params":[{"max_ul_rate":2000000}]' },
  },
  isLoginCall: call => rejected.has(call),
});

describe("Hadouken's driver", () => {
  it("reads Hadouken's version and offers neither the alternative speed nor the free space", async () => {
    const s = await hadoukenServer();
    try {
      const d = new HkDriver(cfg(s.baseUrl), { ...timers, log });
      expect((await d.poll()).status.version).toBe("5.2.0");
      expect(d.capabilities.has("altSpeed")).toBe(false);
      expect(d.capabilities.has("freeSpace")).toBe(false);
      expect(d.capabilities.has("globalPause")).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("refuses an answer without Hadouken's version and asks for it again", async () => {
    const state: HkState = { state: "running", noVersion: true };
    const s = await hadoukenServer(state);
    try {
      const d = new HkDriver(cfg(s.baseUrl), { ...timers, log });
      await expect(d.poll()).rejects.toThrow(ProtocolError);
      state.noVersion = false;
      expect((await d.poll()).status.version).toBe("5.2.0");
      expect(s.calls.filter(c => rpcOf(c).method === "core.getSystemInfo")).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it("writes every header Hadouken reads by its exact name — Content-Length and Authorization", async () => {
    const s = await hadoukenServer();
    try {
      await new HkDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      expect(s.calls.length).toBeGreaterThan(0);
      for (const call of s.calls) {
        // connection_handler.cpp reads a body only behind "Content-Length", http_server.cpp a login only under
        // "Authorization" — fetch writes the length in lower case and Hadouken drops the connection (run 43714685079)
        expect(call.rawHeaders).toContain("Content-Length");
        expect(call.rawHeaders).toContain("Authorization");
      }
    } finally {
      await s.close();
    }
  });

  it("reads every recorded state as Hadouken's own Web UI does", async () => {
    const at = async (state: string): Promise<Map<string, { status: string; error: string; size: number | null }>> => {
      const s = await hadoukenServer({ state });
      try {
        const snap = await new HkDriver(cfg(s.baseUrl), { ...timers, log }).poll();
        return new Map(snap.items.map(i => [i.name, { status: i.status, error: i.error, size: i.sizeBytes }]));
      } finally {
        await s.close();
      }
    };
    const loading = await at("downloading");
    expect(loading.get("big.bin")?.status).toBe("downloading");
    // added paused (32)
    expect(loading.get("stopped.bin")?.status).toBe("paused");
    const running = await at("running");
    // the magnet without metadata lists -1 bytes; complete ones started are seeds
    expect(running.get("nobody-seeds-this")).toMatchObject({ status: "downloading", size: null });
    expect(["check.bin", "done.bin", "gone.bin"].map(n => running.get(n)?.status)).toEqual([
      "seeding",
      "seeding",
      "seeding",
    ]);
    expect(running.get("added-paused")).toMatchObject({ status: "paused", size: null });
    // checking (3) before started, error (48) before paused — the Web UI's order
    expect((await at("checking")).get("check.bin")?.status).toBe("checking");
    expect((await at("error")).get("stopped.bin")).toMatchObject({
      status: "failed",
      error: "Is a directory: /data/stopped.bin",
    });
    expect((await at("completed")).get("done.bin")?.status).toBe("completed");
    const paused = await at("all-paused");
    // paused at 1000 ‰ is completed, like qBittorrent's pausedUP; paused at 0 ‰ is paused
    expect(["big.bin", "check.bin", "done.bin", "gone.bin", "queued.bin"].map(n => paused.get(n)?.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(paused.get("nobody-seeds-this")?.status).toBe("paused");
  });

  it("reads the limits as libtorrent's bytes per second, 0 as unlimited", async () => {
    const limits = async (state: string): Promise<[number | null, number | null]> => {
      const s = await hadoukenServer({ state });
      try {
        const st = (await new HkDriver(cfg(s.baseUrl), { ...timers, log }).poll()).status;
        return [st.speedLimitBps ?? null, st.uploadLimitBps ?? null];
      } finally {
        await s.close();
      }
    };
    expect(await limits("limited")).toEqual([2_048_000, 512_000]);
    expect(await limits("unlimited")).toEqual([0, 0]);
    expect(await limits("empty")).toEqual([0, 0]);
  });

  it("writes a limit in whole bytes per second, 0 to switch it off", async () => {
    const s = await hadoukenServer();
    try {
      const d = new HkDriver(cfg(s.baseUrl), { ...timers, log });
      await d.command({ kind: "setSpeedLimit", bps: 1500.6 });
      expect(rpcOf(s.calls.at(-1) as RecordedCall).params).toEqual([{ max_dl_rate: 1501 }]);
      await d.command({ kind: "setUploadLimit", bps: 0 });
      expect(rpcOf(s.calls.at(-1) as RecordedCall).params).toEqual([{ max_ul_rate: 0 }]);
    } finally {
      await s.close();
    }
  });

  it("keeps no rate of a torrent that does not load", async () => {
    const s = await hadoukenServer({ state: "all-paused" });
    try {
      const items = (await new HkDriver(cfg(s.baseUrl), { ...timers, log }).poll()).items;
      // the failed one still lists 610 B/s and an ETA of 190 s
      expect(items.find(i => i.name === "stopped.bin")).toMatchObject({
        status: "failed",
        speedBps: 0,
        etaSeconds: null,
      });
    } finally {
      await s.close();
    }
  });

  it("takes a torrent out of the queue before it pauses it and hands it back when it resumes", async () => {
    const state: HkState = { state: "running" };
    const s = await hadoukenServer(state);
    const big = hashOf("running")["big.bin"];
    try {
      const d = new HkDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      let from = s.calls.length;
      await d.command({ kind: "pause", key: big });
      // a pause alone does not hold: the queue started it again within a second (recording `pause-managed`)
      expect(s.calls.slice(from).map(rpcOf)).toEqual([
        { method: "webui.getProperties", params: [big] },
        { method: "webui.setProperties", params: [[big], { auto_managed: false }] },
        { method: "webui.perform", params: ["pause", [big]] },
      ]);
      state.state = "paused";
      await d.poll();
      from = s.calls.length;
      await d.command({ kind: "resume", key: big });
      expect(s.calls.slice(from).map(rpcOf)).toEqual([
        { method: "webui.perform", params: ["start", [big]] },
        { method: "webui.setProperties", params: [[big], { auto_managed: true }] },
      ]);
    } finally {
      await s.close();
    }
  });

  it("leaves a torrent that ran outside the queue outside it when it resumes, and never removes data", async () => {
    const state: HkState = { state: "running", forced: true };
    const s = await hadoukenServer(state);
    const big = hashOf("running")["big.bin"];
    try {
      const d = new HkDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      await d.command({ kind: "pause", key: big });
      state.state = "paused";
      await d.poll();
      const from = s.calls.length;
      await d.command({ kind: "resume", key: big });
      expect(s.calls.slice(from).map(rpcOf)).toEqual([{ method: "webui.perform", params: ["start", [big]] }]);
      // a torrent that runs keeps how it runs — a resume only starts it
      await d.command({ kind: "resume", key: hashOf("paused")["check.bin"] });
      expect(rpcOf(s.calls.at(-1) as RecordedCall).method).toBe("webui.perform");
      await d.command({ kind: "remove", key: big });
      expect(rpcOf(s.calls.at(-1) as RecordedCall).params).toEqual(["remove", [big]]);
      expect(s.calls.some(c => c.body.includes("removedata"))).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("pauses what is started or queued over a fresh list and resumes exactly those that are still listed", async () => {
    const state: HkState = { state: "running" };
    const s = await hadoukenServer(state);
    const store = memoryPauseStore();
    // in `running` every torrent but stopped.bin and added-paused is started (1)
    const expected = rows("running")
      .filter(r => (Number(r[1]) & 32) === 0 && (Number(r[1]) & (1 | 64)) !== 0)
      .map(r => String(r[0]));
    try {
      const d = new HkDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      let from = s.calls.length;
      await d.command({ kind: "pauseAll" });
      const paused = s.calls.slice(from).map(rpcOf);
      expect(paused[0].method).toBe("webui.list");
      expect(paused.slice(-2)).toEqual([
        { method: "webui.setProperties", params: [expected, { auto_managed: false }] },
        { method: "webui.perform", params: ["pause", expected] },
      ]);
      expect(expected).not.toContain(hashOf("running")["stopped.bin"]);
      expect((await store.load()).paused).toBe(true);
      // queued.bin is gone by then — a hash Hadouken does not know would stop the whole action at it
      state.state = "removed";
      from = s.calls.length;
      await d.command({ kind: "resumeAll" });
      const listed = new Set(Object.values(hashOf("removed")));
      const back = expected.filter(k => listed.has(k));
      expect(back).not.toContain(hashOf("running")["queued.bin"]);
      const resumed = s.calls.slice(from).map(rpcOf);
      expect(resumed[0].method).toBe("webui.list");
      expect(resumed[1]).toEqual({ method: "webui.perform", params: ["start", back] });
      expect((await store.load()).paused).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("adds a torrent paused while the pause holds, and holds it with the others", async () => {
    const state: HkState = { state: "downloading" };
    const s = await hadoukenServer(state);
    const store = memoryPauseStore();
    try {
      const d = new HkDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      const magnet = "magnet:?xt=urn:btih:fedcba9876543210fedcba9876543210fedcba98&dn=added-paused";
      await d.command({ kind: "add", url: magnet });
      expect(rpcOf(s.calls.at(-1) as RecordedCall).params).toEqual(["url", magnet, { paused: true }]);
      // the next poll lists the new torrents of `running`; the one that is not started is the added one
      state.state = "running";
      const snap = await d.poll();
      const key = hashOf("running")["added-paused"];
      expect((await store.load()).keys).toContain(key);
      expect(snap.status.paused).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("asks Hadouken's default port and path", async () => {
    // the port where no local fixture server can listen, the path on one
    expect(baseUrl({ ...cfg("http://nas:1"), port: 0, path: "" }, catalogEntry("hadouken"))).toBe(
      "http://nas:7070/api",
    );
    const s = await hadoukenServer();
    try {
      await new HkDriver({ ...cfg(s.baseUrl), path: "" }, { ...timers, log }).poll();
      expect(s.calls[0].path).toBe("/api");
    } finally {
      await s.close();
    }
  });

  it("holds a refused login as such and a refused call as a protocol error with Hadouken's message", async () => {
    const s = await hadoukenServer();
    try {
      await expect(new HkDriver(cfg(s.baseUrl, "bad"), { ...timers, log }).poll()).rejects.toThrow(AuthError);
    } finally {
      await s.close();
    }
    const unknown = loadFixture("hadouken", VERSION, "commands", "remove-unknown");
    const refusing = await startFixtureServer(() => ({ body: unknown.body }));
    try {
      const d = new HkDriver(cfg(refusing.baseUrl), { ...timers, log });
      await expect(d.command({ kind: "remove", key: "f".repeat(40) })).rejects.toThrow(
        "hadouken: webui.perform refused — Internal server error: identifier 'infoHash' undefined",
      );
    } finally {
      await refusing.close();
    }
  });
});
