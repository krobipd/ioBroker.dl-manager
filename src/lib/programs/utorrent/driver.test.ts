import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer, type FixtureAnswer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import { AuthError, ProtocolError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { UtDriver } from "./driver";
import { mapUtStatus, statusTable } from "./map";

/** The recording: µTorrent Server 3.3 build 30470 (live-programs run 43685205704, `test/live/programs/utorrent.mjs`). */
const VERSION = "3.3.0.30470";

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
    type: "utorrent",
    deviceId: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "/gui",
    username: "admin",
    password,
    apiKey: "",
    device: "",
  };
};

/**
 * @param state state folder
 * @returns the rows of the recorded `list=1`
 */
const rows = (state: string): unknown[][] =>
  (loadFixture("utorrent", VERSION, state, "list").body as { torrents: unknown[][] }).torrents;

/**
 * @param state state folder
 * @returns the recorded hashes by torrent name
 */
const hashOf = (state: string): Record<string, string> =>
  Object.fromEntries(rows(state).map(r => [String(r[2]), String(r[0])]));

/** What the recorded µTorrent answers; the test changes it between calls. */
interface UtState {
  /** State folder of `list=1` and `action=getsettings`. */
  state: string;
  /** A build without `getversion`: it answers 400 "invalid request" like an unknown action. */
  noGetVersion?: boolean;
}

/**
 * µTorrent from the recordings: basic auth on every request, the token of `token.html` with the GUID cookie of that
 * request, 400 "invalid request" for a token or cookie it does not know (recordings `auth/bad-token`, `auth/no-cookie`).
 *
 * @param s the answers, read at every request
 * @returns the running server
 */
async function utorrentServer(s: UtState = { state: "running" }): Promise<ContractServer> {
  let session = 1;
  const good = `Basic ${Buffer.from("admin:good").toString("base64")}`;
  const refused = loadFixture("utorrent", VERSION, "auth", "token-wrong");
  const invalid = loadFixture("utorrent", VERSION, "auth", "bad-token");
  const server = await startFixtureServer((call): FixtureAnswer => {
    if (call.headers.authorization !== good) {
      return { status: refused.status, body: "", headers: { "www-authenticate": 'Basic realm="uTorrent"' } };
    }
    if (call.path === "/gui/token.html") {
      const page = String(loadFixture("utorrent", VERSION, "auth", "token").body);
      return { body: page.replace("<token>", `tok${session}`), headers: { "set-cookie": `GUID=g${session}` } };
    }
    const q = new URLSearchParams(call.query);
    if (call.path !== "/gui/" || q.get("token") !== `tok${session}` || call.headers.cookie !== `GUID=g${session}`) {
      return { status: invalid.status, body: String(invalid.body) };
    }
    if (q.get("list") === "1") {
      return { body: loadFixture("utorrent", VERSION, s.state, "list").body };
    }
    switch (q.get("action")) {
      case "getsettings":
        return { body: loadFixture("utorrent", VERSION, s.state, "getsettings").body };
      case "getversion":
        return s.noGetVersion
          ? { status: invalid.status, body: String(invalid.body) }
          : { body: loadFixture("utorrent", VERSION, "probe", "getversion").body };
      default:
        return { body: loadFixture("utorrent", VERSION, "commands", "stop").body };
    }
  });
  return {
    ...server,
    expireSession: () => {
      session++;
    },
  };
}

const isLogin = (call: RecordedCall): boolean => call.path === "/gui/token.html";

runDriverContract({
  type: "utorrent",
  server: () => utorrentServer(),
  makeDriver: (base, creds) => new UtDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }),
  mapStatus: mapUtStatus,
  statusTable,
  unknownStatus: "Status_Unknown",
  commandCalls: {
    pauseAll: { method: "GET", path: "/gui/", bodyContains: "action=pause&hash=" },
    resumeAll: { method: "GET", path: "/gui/", bodyContains: "action=unpause&hash=" },
    pause: { method: "GET", path: "/gui/", bodyContains: "action=pause&hash=" },
    // the first row of `running` waits in the queue (200), it is not paused
    resume: { method: "GET", path: "/gui/", bodyContains: "action=start&hash=" },
    remove: { method: "GET", path: "/gui/", bodyContains: "action=remove&hash=" },
    add: { method: "GET", path: "/gui/", bodyContains: "action=add-url&s=magnet%3A" },
    // 2,000,000 B/s in µTorrent's KiB/s
    setSpeedLimit: { method: "GET", path: "/gui/", bodyContains: "action=setsetting&s=max_dl_rate&v=1953" },
    setUploadLimit: { method: "GET", path: "/gui/", bodyContains: "action=setsetting&s=max_ul_rate&v=1953" },
  },
  isLoginCall: isLogin,
});

describe("µTorrent's driver", () => {
  it("reads µTorrent's version and offers neither the alternative speed nor the free space", async () => {
    const s = await utorrentServer();
    try {
      const d = new UtDriver(cfg(s.baseUrl), { ...timers, log });
      const snap = await d.poll();
      expect(snap.status.version).toBe("3.3.0.30470");
      expect(d.capabilities.has("altSpeed")).toBe(false);
      expect(d.capabilities.has("freeSpace")).toBe(false);
      expect(d.capabilities.has("globalPause")).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("takes the build number of the answers as the version of a build without getversion, asked once", async () => {
    const s = await utorrentServer({ state: "running", noGetVersion: true });
    try {
      const d = new UtDriver(cfg(s.baseUrl), { ...timers, log });
      expect((await d.poll()).status.version).toBe("30470");
      expect((await d.poll()).status.version).toBe("30470");
      expect(s.calls.filter(c => c.query.includes("action=getversion"))).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it("reads every recorded state as µTorrent's own Web UI does", async () => {
    const at = async (state: string): Promise<Map<string, { status: string; error: string; size: number | null }>> => {
      const s = await utorrentServer({ state });
      try {
        const snap = await new UtDriver(cfg(s.baseUrl), { ...timers, log }).poll();
        return new Map(snap.items.map(i => [i.name, { status: i.status, error: i.error, size: i.sizeBytes }]));
      } finally {
        await s.close();
      }
    };
    const loading = await at("downloading");
    expect(loading.get("big.bin")?.status).toBe("downloading");
    expect(loading.get("queued.bin")?.status).toBe("queued");
    expect(loading.get("stopped.bin")?.status).toBe("paused");
    const running = await at("running");
    // the magnet waits in the queue (200) and knows no size; a complete one waiting is a queued seed
    expect(running.get("nobody-seeds-this")).toMatchObject({ status: "queued", size: null });
    expect(running.get("check.bin")?.status).toBe("seeding");
    // forced past the queue (137, "Finding peers") it loads
    expect((await at("metadata")).get("nobody-seeds-this")).toMatchObject({ status: "downloading", size: null });
    expect((await at("paused")).get("big.bin")?.status).toBe("paused");
    expect((await at("checking")).get("check.bin")?.status).toBe("checking");
    expect((await at("error")).get("gone.bin")).toMatchObject({
      status: "failed",
      error: "Error: Files missing from job. Please recheck.",
    });
    expect((await at("completed")).get("done.bin")?.status).toBe("completed");
    const paused = await at("all-paused");
    // paused while loading (233) or waiting (169) is paused; paused when finished (232, 233 at 1000 ‰) is completed,
    // like qBittorrent's pausedUP
    expect(paused.get("queued.bin")?.status).toBe("paused");
    expect(paused.get("nobody-seeds-this")?.status).toBe("paused");
    expect(["big.bin", "check.bin", "done.bin"].map(n => paused.get(n)?.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("reads the limits as KiB/s × 1024, 0 and µTorrent Server's -1 as unlimited", async () => {
    const limits = async (state: string): Promise<[number | null, number | null]> => {
      const s = await utorrentServer({ state });
      try {
        const st = (await new UtDriver(cfg(s.baseUrl), { ...timers, log }).poll()).status;
        return [st.speedLimitBps ?? null, st.uploadLimitBps ?? null];
      } finally {
        await s.close();
      }
    };
    expect(await limits("limited")).toEqual([2000 * 1024, 500 * 1024]);
    expect(await limits("unlimited")).toEqual([0, 0]);
    expect(await limits("empty")).toEqual([0, 0]);
  });

  it("writes a limit in KiB/s, at least 1, and 0 to switch it off", async () => {
    const s = await utorrentServer();
    try {
      const d = new UtDriver(cfg(s.baseUrl), { ...timers, log });
      await d.command({ kind: "setSpeedLimit", bps: 500 });
      expect(s.calls.at(-1)?.query).toContain("s=max_dl_rate&v=1");
      await d.command({ kind: "setUploadLimit", bps: 0 });
      expect(s.calls.at(-1)?.query).toContain("s=max_ul_rate&v=0");
    } finally {
      await s.close();
    }
  });

  it("keeps no rate of a torrent that does not load", async () => {
    const s = await utorrentServer({ state: "paused" });
    try {
      const big = (await new UtDriver(cfg(s.baseUrl), { ...timers, log }).poll()).items.find(i => i.name === "big.bin");
      // the paused row still carries 1394 B/s and an ETA
      expect(big).toMatchObject({ status: "paused", speedBps: 0, etaSeconds: null });
    } finally {
      await s.close();
    }
  });

  it("resumes a paused torrent with unpause and a stopped one with start, and never removes data", async () => {
    const s = await utorrentServer({ state: "paused" });
    const h = hashOf("paused");
    try {
      const d = new UtDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      await d.command({ kind: "resume", key: h["big.bin"] });
      expect(s.calls.at(-1)?.query).toContain(`action=unpause&hash=${h["big.bin"]}`);
      await d.command({ kind: "resume", key: h["stopped.bin"] });
      expect(s.calls.at(-1)?.query).toContain(`action=start&hash=${h["stopped.bin"]}`);
      await d.command({ kind: "remove", key: h["big.bin"] });
      expect(s.calls.at(-1)?.query).toContain("action=remove&");
      expect(s.calls.some(c => c.query.includes("removedata"))).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("pauses what is started or queued with µTorrent's pause over one hash list and unpauses exactly those", async () => {
    const s = await utorrentServer({ state: "running" });
    const store = memoryPauseStore();
    // in `running`: the magnet, queued.bin, check.bin and gone.bin wait (200), big.bin and done.bin run (201),
    // stopped.bin is stopped (136)
    const expected = rows("running")
      .filter(r => (Number(r[1]) & 32) === 0 && (Number(r[1]) & (1 | 64)) !== 0)
      .map(r => `hash=${String(r[0])}`)
      .join("&");
    try {
      const d = new UtDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      expect(s.calls.at(-1)?.query).toContain(`action=pause&${expected}`);
      expect(expected).not.toContain(hashOf("running")["stopped.bin"]);
      expect((await store.load()).paused).toBe(true);
      await d.command({ kind: "resumeAll" });
      expect(s.calls.at(-1)?.query).toContain(`action=unpause&${expected}`);
    } finally {
      await s.close();
    }
  });

  it("pauses and holds a torrent added while the pause holds, which µTorrent starts at once", async () => {
    const state: UtState = { state: "downloading" };
    const s = await utorrentServer(state);
    const store = memoryPauseStore();
    try {
      const d = new UtDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      await d.command({ kind: "add", url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" });
      // the next poll lists the new torrents of `running`; the first new one that runs is the added one
      state.state = "running";
      const from = s.calls.length;
      const snap = await d.poll();
      const before = new Set(Object.values(hashOf("downloading")));
      const added = rows("running").find(r => !before.has(String(r[0])) && (Number(r[1]) & (1 | 64)) !== 0);
      const key = String(added?.[0]);
      expect(s.calls.slice(from).some(c => c.query.includes(`action=pause&hash=${key}`))).toBe(true);
      expect((await store.load()).keys).toContain(key);
      expect(snap.items.find(i => i.key === key)?.status).toBe("paused");
      expect(snap.status.paused).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("leaves a torrent added running when the pause ended before it showed", async () => {
    const state: UtState = { state: "downloading" };
    const s = await utorrentServer(state);
    try {
      const d = new UtDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: memoryPauseStore() });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      await d.command({ kind: "add", url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" });
      await d.command({ kind: "resumeAll" });
      state.state = "running";
      const from = s.calls.length;
      await d.poll();
      expect(s.calls.slice(from).some(c => c.query.includes("action=pause"))).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("asks µTorrent's default port and path", async () => {
    const d = new UtDriver({ ...cfg("http://nas:1"), port: 0, path: "" }, { ...timers, log });
    expect(await firstUrl(() => d.poll())).toBe("http://nas:8080/gui/token.html");
  });

  it("holds a refused login as such and a page without a token as a protocol error", async () => {
    const s = await utorrentServer();
    try {
      await expect(new UtDriver(cfg(s.baseUrl, "bad"), { ...timers, log }).poll()).rejects.toThrow(AuthError);
    } finally {
      await s.close();
    }
    const blank = await startFixtureServer(() => ({ body: "<html></html>" }));
    try {
      await expect(new UtDriver(cfg(blank.baseUrl), { ...timers, log }).poll()).rejects.toThrow(ProtocolError);
    } finally {
      await blank.close();
    }
  });
});
