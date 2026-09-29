import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import { AuthError, ProtocolError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { TrDriver } from "./driver";
import { mapTrStatus, statusTable } from "./map";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const cfg = (base: string, pass = "good"): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "transmission",
    deviceId: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "",
    username: "admin",
    password: pass,
    apiKey: "",
    device: "",
  };
};

/** Requests the server answered with 401 or 409 — Transmission's "login" is basic auth plus the session round. */
const handshakes = new Set<RecordedCall>();

/**
 * Transmission from the recordings: basic auth, the 409 session round, reads by method.
 *
 * @param version recorded version (4.0.6 legacy, 4.1.3 JSON-RPC)
 */
async function trServer(version = "4.1.3"): Promise<ContractServer> {
  const modern = version.startsWith("4.1");
  let sid = 1;
  const good = `Basic ${Buffer.from("admin:good").toString("base64")}`;
  const READS: Record<string, string> = {
    torrent_get: "torrent-get",
    "torrent-get": "torrent-get",
    session_get: "session-get",
    "session-get": "session-get",
    session_stats: "session-stats",
    "session-stats": "session-stats",
    free_space: "free-space",
    "free-space": "free-space",
  };
  const s = await startFixtureServer(call => {
    if (call.headers.authorization !== good) {
      handshakes.add(call);
      const r = loadFixture("transmission", version, "auth", "login-wrong");
      return { status: r.status, body: r.body };
    }
    if (call.headers["x-transmission-session-id"] !== `sid${sid}`) {
      handshakes.add(call);
      return {
        status: 409,
        body: "<h1>409: Conflict</h1>",
        headers: {
          "x-transmission-session-id": `sid${sid}`,
          ...(modern ? { "x-transmission-rpc-version": "6.0.1" } : {}),
        },
      };
    }
    const method = String((JSON.parse(call.body) as { method?: unknown }).method);
    const read = READS[method];
    if (read) {
      return { body: loadFixture("transmission", version, "running", read).body };
    }
    return { body: modern ? { jsonrpc: "2.0", result: {}, id: 1 } : { arguments: {}, result: "success", tag: 1 } };
  });
  return {
    ...s,
    expireSession: () => {
      sid++;
    },
  };
}

runDriverContract({
  type: "transmission",
  server: () => trServer(),
  makeDriver: (base, creds) => new TrDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }),
  mapStatus: mapTrStatus,
  statusTable,
  unknownStatus: "9:0:left",
  commandCalls: {
    pauseAll: { method: "POST", path: "/transmission/rpc", bodyContains: '"method":"torrent_stop"' },
    resumeAll: { method: "POST", path: "/transmission/rpc", bodyContains: '"method":"torrent_start"' },
    pause: { method: "POST", path: "/transmission/rpc", bodyContains: '"method":"torrent_stop"' },
    resume: { method: "POST", path: "/transmission/rpc", bodyContains: '"method":"torrent_start"' },
    remove: { method: "POST", path: "/transmission/rpc", bodyContains: '"delete_local_data":false' },
    add: { method: "POST", path: "/transmission/rpc", bodyContains: '"filename":"magnet:' },
    setSpeedLimit: { method: "POST", path: "/transmission/rpc", bodyContains: '"speed_limit_down":2000' },
    setUploadLimit: { method: "POST", path: "/transmission/rpc", bodyContains: '"speed_limit_up":2000' },
    setAltSpeed: { method: "POST", path: "/transmission/rpc", bodyContains: '"alt_speed_enabled":true' },
  },
  isLoginCall: call => handshakes.has(call),
});

describe("Transmission driver on the legacy protocol (4.0.6)", () => {
  it("polls with legacy names and camelCase fields and reads the same model", async () => {
    const s = await trServer("4.0.6");
    try {
      const d = new TrDriver(cfg(s.baseUrl), { ...timers, log });
      const snap = await d.poll();
      expect(snap.status.version).toBe("4.0.6");
      expect(snap.items.find(i => i.name === "big.bin")?.status).toBe("downloading");
      const get = s.calls.find(c => c.body.includes('"torrent-get"'));
      expect(get?.body).toContain('"hashString"');
      await d.command({ kind: "remove", key: snap.items[0].key });
      expect(s.calls.at(-1)?.body).toContain('"delete-local-data":false');
    } finally {
      await s.close();
    }
  });
});

/**
 * A Transmission 4.1 (JSON-RPC) whose answers the test sets per method.
 *
 * @param state result per method; `torrent_get` etc.
 * @returns the running server
 */
async function trSynth(state: Record<string, unknown>): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  return startFixtureServer(call => {
    if (call.headers["x-transmission-session-id"] !== "s") {
      return { status: 409, headers: { "x-transmission-session-id": "s", "x-transmission-rpc-version": "6.0.1" } };
    }
    const { method, id } = JSON.parse(call.body) as { method: string; id: number };
    return { body: { jsonrpc: "2.0", id, result: state[method] ?? {} } };
  });
}
const bodies = (s: { calls: RecordedCall[] }, method: string): Record<string, unknown>[] =>
  s.calls
    .map(c => (c.body ? (JSON.parse(c.body) as { method?: string; params?: Record<string, unknown> }) : {}))
    .filter(b => b.method === method)
    .map(b => b.params ?? {});

describe("Transmission driver details", () => {
  it("asks the default port and path, adds the slash to a bare path, sends basic auth only with a user", async () => {
    const d = (over: Partial<ProgramConfig>): TrDriver =>
      new TrDriver({ ...cfg("http://nas:1"), port: 0, ...over }, { ...timers, log });
    expect(await firstUrl(() => d({}).poll())).toBe("http://nas:9091/transmission/rpc");
    expect(await firstUrl(() => d({ path: "rpc" }).poll())).toBe("http://nas:9091/rpc");
    const s = await trSynth({});
    try {
      await new TrDriver({ ...cfg(s.baseUrl), username: "", password: "" }, { ...timers, log }).poll();
      expect(s.calls.every(c => c.headers.authorization === undefined)).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("stops only running, keyed torrents, forgets gone ones and asks free space only with a folder", async () => {
    const state: Record<string, unknown> = {
      torrent_get: { torrents: [{ hash_string: "a", status: 0 }, { hash_string: "b", status: 4 }, { status: 4 }] },
      session_get: { version: "4.1.3 (abc)" },
    };
    const s = await trSynth(state);
    const store = memoryPauseStore();
    try {
      const d = new TrDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      expect(bodies(s, "free_space")).toEqual([]);
      await d.command({ kind: "pauseAll" });
      expect(bodies(s, "torrent_stop")).toEqual([{ ids: ["b"] }]);
      await d.command({ kind: "add", url: "magnet:?xt=1" });
      expect(bodies(s, "torrent_add")[0]).toMatchObject({ paused: true });
      state.torrent_get = { torrents: [{ hash_string: "a", status: 0 }] };
      state.session_get = { version: "4.1.3", download_dir: "/dl" };
      state.free_space = { path: "/dl", size_bytes: 123 };
      expect((await d.poll()).status.freeSpaceBytes).toBe(123);
      expect(await store.load()).toEqual({ paused: true, keys: [] });
    } finally {
      await s.close();
    }
  });

  it("switches a limit off without overwriting it, and never sends a limit below 1", async () => {
    const s = await trSynth({});
    try {
      const d = new TrDriver(cfg(s.baseUrl), { ...timers, log });
      await d.command({ kind: "setSpeedLimit", bps: 0 });
      await d.command({ kind: "setUploadLimit", bps: 0 });
      await d.command({ kind: "setSpeedLimit", bps: 100 });
      expect(bodies(s, "session_set")).toEqual([
        { speed_limit_down_enabled: false },
        { speed_limit_up_enabled: false },
        { speed_limit_down: 1, speed_limit_down_enabled: true },
      ]);
    } finally {
      await s.close();
    }
  });

  it("turns error answers into the right error", async () => {
    const answer = async (a: { status?: number; body?: unknown }, re: RegExp | typeof AuthError): Promise<void> => {
      const s = await startFixtureServer(call =>
        call.headers["x-transmission-session-id"] !== "s"
          ? { status: 409, headers: { "x-transmission-session-id": "s", "x-transmission-rpc-version": "6.0.1" } }
          : a,
      );
      try {
        await expect(new TrDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(re);
      } finally {
        await s.close();
      }
    };
    await answer({ status: 403, body: "" }, AuthError);
    await answer({ status: 421, body: "" }, /rpc-host-whitelist/);
    await answer({ status: 404, body: {} }, /HTTP 404/);
    await answer({ body: { jsonrpc: "2.0", id: 1, error: { message: "boom" } } }, /failed: boom/);
    const legacy = await startFixtureServer(call =>
      call.headers["x-transmission-session-id"] !== "s"
        ? { status: 409, headers: { "x-transmission-session-id": "s" } }
        : { body: { result: "no such method", arguments: {} } },
    );
    try {
      await expect(new TrDriver(cfg(legacy.baseUrl), { ...timers, log }).poll()).rejects.toThrow(ProtocolError);
    } finally {
      await legacy.close();
    }
  });
});
