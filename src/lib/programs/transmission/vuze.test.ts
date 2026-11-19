import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import { AuthError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { TrDriver } from "./driver";
import { mapTrStatus, statusTable } from "./map";

/** The recording: Vuze 5.7.6.0 with its Web Remote plugin 0.6.5 (live-programs, `test/live/programs/vuze.mjs`). */
const VERSION = "5.7.6.0-xmwebui-0.6.5";

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
    type: "vuze",
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

/** Requests the server answered with 401 or 409 — the plugin's "login" is basic auth plus the session round. */
const handshakes = new Set<RecordedCall>();

/**
 * Vuze from the recording: basic auth, the 409 session round (legacy protocol only, no RPC version header), reads by
 * method from one recorded state.
 *
 * @param state recorded state the reads come from
 */
async function vuzeServer(state = "running"): Promise<ContractServer> {
  let sid = 1;
  const good = `Basic ${Buffer.from("admin:good").toString("base64")}`;
  const READS = new Set(["torrent-get", "session-get", "session-stats", "free-space"]);
  const s = await startFixtureServer(call => {
    if (call.headers.authorization !== good) {
      handshakes.add(call);
      const r = loadFixture("vuze", VERSION, "auth", "login-wrong");
      return { status: r.status, body: r.body };
    }
    if (call.headers["x-transmission-session-id"] !== `sid${sid}`) {
      handshakes.add(call);
      return { status: 409, body: "", headers: { "x-transmission-session-id": `sid${sid}` } };
    }
    const method = String((JSON.parse(call.body) as { method?: unknown }).method);
    if (READS.has(method)) {
      return { body: loadFixture("vuze", VERSION, state, method).body };
    }
    return { body: { arguments: {}, result: "success", tag: 1 } };
  });
  return {
    ...s,
    expireSession: () => {
      sid++;
    },
  };
}

runDriverContract({
  type: "vuze",
  server: () => vuzeServer(),
  makeDriver: (base, creds) => new TrDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }),
  mapStatus: mapTrStatus,
  statusTable,
  unknownStatus: "9:0:left",
  commandCalls: {
    pauseAll: { method: "POST", path: "/transmission/rpc", bodyContains: '"method":"torrent-stop"' },
    resumeAll: { method: "POST", path: "/transmission/rpc", bodyContains: '"method":"torrent-start"' },
    pause: { method: "POST", path: "/transmission/rpc", bodyContains: '"method":"torrent-stop"' },
    resume: { method: "POST", path: "/transmission/rpc", bodyContains: '"method":"torrent-start"' },
    remove: { method: "POST", path: "/transmission/rpc", bodyContains: '"delete-local-data":false' },
    add: { method: "POST", path: "/transmission/rpc", bodyContains: '"filename":"magnet:' },
    // 2,000,000 B/s in Vuze's KB/s (× 1024)
    setSpeedLimit: { method: "POST", path: "/transmission/rpc", bodyContains: '"speed-limit-down":1953' },
    setUploadLimit: { method: "POST", path: "/transmission/rpc", bodyContains: '"speed-limit-up":1953' },
  },
  isLoginCall: call => handshakes.has(call),
});

describe("Vuze through Transmission's driver", () => {
  it("reads Vuze's own version, not the plugin's, and offers neither labels nor the faked alternative speed", async () => {
    const s = await vuzeServer();
    try {
      const d = new TrDriver(cfg(s.baseUrl), { ...timers, log });
      const snap = await d.poll();
      expect(d.type).toBe("vuze");
      expect(snap.status.version).toBe("5.7.6.0");
      expect(d.capabilities.has("altSpeed")).toBe(false);
      await expect(d.command({ kind: "setAltSpeed", on: true })).rejects.toThrow("vuze: command not supported");
      expect(d.capabilities.has("category")).toBe(false);
      expect(d.capabilities.has("freeSpace")).toBe(true);
      expect(snap.items.every(i => i.key === i.key.toUpperCase())).toBe(true);
      const get = s.calls.find(c => c.body.includes('"torrent-get"'));
      expect(get?.body).toContain('"hashString"');
    } finally {
      await s.close();
    }
  });

  it("gives up an unanswered call after Vuze's slow first answer and with room before the fleet's hang deadline (D21)", async () => {
    const waits: number[] = [];
    const counting = {
      setTimeout: (cb: () => void, ms: number): ioBroker.Timeout => {
        waits.push(ms);
        return timers.setTimeout(cb, ms);
      },
      clearTimeout: timers.clearTimeout,
    };
    const s = await vuzeServer();
    try {
      await new TrDriver(cfg(s.baseUrl), { ...counting, log }).poll();
      const wait = Math.max(...waits);
      // Vuze's first session-get waited 89.9 s for its version server (live-programs run 43680925710); the fleet suite
      // measures a hung call from outside against 120 s, so the abort comes with room before it (an abort at exactly
      // 120 s ended after 120001 ms there)
      expect(wait).toBeGreaterThan(89_900);
      expect(wait).toBeLessThanOrEqual(120_000 - 10_000);
    } finally {
      await s.close();
    }
  });

  it("reads a loading and a queued torrent, and Vuze's overflowed infinity as no estimate", async () => {
    const at = async (
      state: string,
    ): Promise<Map<string, { status: string; eta: number | null; speed: number | null }>> => {
      const s = await vuzeServer(state);
      try {
        const snap = await new TrDriver(cfg(s.baseUrl), { ...timers, log }).poll();
        return new Map(snap.items.map(i => [i.name, { status: i.status, eta: i.etaSeconds, speed: i.speedBps }]));
      } finally {
        await s.close();
      }
    };
    const loading = await at("downloading");
    expect(loading.get("big.bin")).toMatchObject({ status: "downloading", eta: 113, speed: 117964 });
    expect(loading.get("queued.bin")?.status).toBe("queued");
    expect(loading.get("stopped.bin")?.status).toBe("paused");
    // gone.bin loads again without any source: eta 1827387392 = 10000 years overflowed in int (Constants.java 123)
    const resumed = await at("resumed");
    expect(resumed.get("gone.bin")).toMatchObject({ status: "downloading", eta: null });
    expect(resumed.get("big.bin")?.status).toBe("seeding");
    expect((await at("checking")).get("check.bin")?.status).toBe("checking");
    expect((await at("all-stopped")).get("done.bin")?.status).toBe("completed");
  });

  it("reads the limits as KB/s × 1024 and writes them so, also before the first poll", async () => {
    const s = await vuzeServer("limited");
    try {
      const fresh = new TrDriver(cfg(s.baseUrl), { ...timers, log });
      await fresh.command({ kind: "setSpeedLimit", bps: 2000 * 1024 });
      expect(s.calls.at(-1)?.body).toContain('"speed-limit-down":2000');
      const snap = await new TrDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      expect(snap.status.speedLimitBps).toBe(2000 * 1024);
      expect(snap.status.uploadLimitBps).toBe(500 * 1024);
    } finally {
      await s.close();
    }
  });

  it("asks Vuze's default port and Transmission's path", async () => {
    const d = new TrDriver({ ...cfg("http://nas:1"), port: 0 }, { ...timers, log });
    expect(await firstUrl(() => d.poll())).toBe("http://nas:9091/transmission/rpc");
  });

  it("names the plugin's Access setting on a 403 and holds it as a refused login", async () => {
    const s = await startFixtureServer(() => ({ status: 403, body: "Cannot access resource from this IP address." }));
    try {
      const poll = new TrDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      await expect(poll).rejects.toThrow(AuthError);
      await expect(new TrDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(/Access/);
    } finally {
      await s.close();
    }
  });

  it("stops by upper-case hash, never the metadata download it cannot reach, and holds what it adds", async () => {
    const s = await vuzeServer();
    const store = memoryPauseStore();
    // the recording: big loading, queued waiting, three seeding, stopped.bin stopped, the dead magnet loading metadata
    const raw = loadFixture("vuze", VERSION, "running", "torrent-get").body as {
      arguments: { torrents: { hashString: string; status: number; metadataPercentComplete: number }[] };
    };
    const magnet = raw.arguments.torrents.find(t => t.metadataPercentComplete === 0);
    try {
      const d = new TrDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      const stop = s.calls.find(c => c.body.includes('"torrent-stop"'));
      const ids = (JSON.parse(stop?.body ?? "{}") as { arguments: { ids: string[] } }).arguments.ids;
      expect(magnet?.status).toBe(4);
      expect(ids).not.toContain(magnet?.hashString);
      expect(ids).toEqual(
        raw.arguments.torrents.filter(t => t.status !== 0 && t.metadataPercentComplete !== 0).map(t => t.hashString),
      );
      expect(ids.length).toBeGreaterThan(0);
      await d.command({ kind: "add", url: "magnet:?xt=urn:btih:x" });
      expect(s.calls.at(-1)?.body).toContain('"paused":true');
    } finally {
      await s.close();
    }
  });
});
