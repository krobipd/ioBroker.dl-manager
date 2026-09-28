import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { loadFixture } from "../../../../test/helpers/fixtures";
import type { ProgramConfig } from "../registry";
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
    key: "",
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
