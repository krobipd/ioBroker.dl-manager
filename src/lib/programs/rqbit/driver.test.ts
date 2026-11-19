import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runDriverContract } from "../../../../test/helpers/contract";
import { startFixtureServer, type FixtureAnswer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import { AuthError, ProtocolError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { RqDriver } from "./driver";
import { mapRqStatus, statusTable } from "./map";

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
    type: "rqbit",
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

/**
 * @param version recorded version
 * @param state state folder
 * @param name file name
 * @returns the recording as the fixture server's answer
 */
const recorded = (version: string, state: string, name: string): FixtureAnswer => {
  const f = loadFixture("rqbit", version, state, name);
  return { status: f.status, body: f.body, headers: f.headers };
};

/** The torrents of the 9.1.0 running recording, in the program's order. */
const RUNNING = (
  loadFixture("rqbit", "9.1.0", "running", "torrents").body as {
    torrents: { info_hash: string; stats: { state: string } }[];
  }
).torrents;
/** The first torrent of the list — the contract pauses it, and the global pause stops it first. */
const FIRST = RUNNING[0].info_hash;

/** Requests rqbit answered with 401 — its "login" is basic auth on every request. */
const rejected = new Set<RecordedCall>();

/**
 * rqbit from the recordings: basic auth on every request, reads and commands by route.
 *
 * @param version recorded version (8.1.1 answers 405 for the limits, 9.1.0 tells them)
 * @returns the running server
 */
async function rqServer(version = "9.1.0"): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  const good = `Basic ${Buffer.from("admin:good").toString("base64")}`;
  const known = new Set(RUNNING.map(t => t.info_hash));
  return startFixtureServer(call => {
    if (call.headers.authorization !== good) {
      rejected.add(call);
      return recorded(version, "auth", call.headers.authorization ? "root-wrong" : "root-no-auth");
    }
    const route = `${call.method} ${call.path}`;
    const action = /^POST \/torrents\/([0-9a-f]{40})\/(pause|start|forget)$/.exec(route);
    if (action) {
      return known.has(action[1])
        ? recorded(version, "commands", "torrent-pause")
        : recorded(version, "commands", "torrent-unknown");
    }
    const routes: Record<string, [string, string]> = {
      "GET /": ["auth", "root"],
      "GET /torrents": ["running", "torrents"],
      "GET /stats": ["running", "stats"],
      "GET /torrents/limits": ["running", "limits"],
      "POST /torrents": ["commands", "torrents-post-file"],
      "POST /torrents/limits": ["commands", "limits-set"],
    };
    const hit = routes[route];
    return hit ? recorded(version, ...hit) : { status: 404, body: "" };
  });
}

runDriverContract({
  type: "rqbit",
  server: () => rqServer(),
  makeDriver: (base, creds) => new RqDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }),
  mapStatus: mapRqStatus,
  statusTable,
  unknownStatus: "frozen:left",
  commandCalls: {
    pauseAll: { method: "POST", path: `/torrents/${FIRST}/pause` },
    resumeAll: { method: "POST", path: `/torrents/${FIRST}/start` },
    pause: { method: "POST", path: `/torrents/${FIRST}/pause` },
    resume: { method: "POST", path: `/torrents/${FIRST}/start` },
    remove: { method: "POST", path: `/torrents/${FIRST}/forget` },
    add: { method: "POST", path: "/torrents", bodyContains: "magnet:?xt=urn:btih:" },
    setSpeedLimit: { method: "POST", path: "/torrents/limits", bodyContains: '"download_bps":2000000' },
    setUploadLimit: { method: "POST", path: "/torrents/limits", bodyContains: '"upload_bps":2000000' },
  },
  isLoginCall: call => rejected.has(call),
});

/** What a synthetic rqbit answers; the test changes it between calls. */
interface RqState {
  torrents: unknown[];
  /** `GET /torrents/limits`, undefined = the route of 8.x (405). */
  limits?: unknown;
  /** `GET /stats`, default both speeds 0. */
  stats?: unknown;
  /** The answer of `POST /torrents`. */
  add?: FixtureAnswer;
  /** Answers by `<method> <path>` ahead of the default `{}`. */
  answers?: Record<string, FixtureAnswer>;
}

/**
 * @param state the answers, read at every request
 * @returns the running server
 */
async function rqSynth(state: RqState): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  return startFixtureServer(call => {
    switch (`${call.method} ${call.path}`) {
      case "GET /":
        return { body: { version: "9.1.0" } };
      case "GET /torrents":
        return { body: { torrents: state.torrents } };
      case "GET /stats":
        return { body: state.stats ?? { download_speed: { mbps: 0 }, upload_speed: { mbps: 0 } } };
      case "GET /torrents/limits":
        return state.limits === undefined ? { status: 405, body: "" } : { body: state.limits };
      case "POST /torrents":
        return state.add ?? { body: { id: 9, details: { info_hash: "n".repeat(40) } } };
      default:
        return state.answers?.[`${call.method} ${call.path}`] ?? { body: {} };
    }
  });
}
/** rqbit's recorded answer to a command on a torrent it does not know (404 torrent_not_found). */
const UNKNOWN = ((f): FixtureAnswer => ({ status: f.status, body: f.body }))(
  loadFixture("rqbit", "9.1.0", "commands", "torrent-unknown"),
);
const posts = (s: { calls: RecordedCall[] }): string[] =>
  s.calls.filter(c => c.method === "POST").map(c => `${c.path}${c.body ? ` ${c.body}` : ""}`);
const t = (hash: string, state: string): Record<string, unknown> => ({
  info_hash: hash,
  name: hash,
  stats: { state, finished: false, progress_bytes: 0, total_bytes: 1 },
});

describe("rqbit driver on 8.1.1", () => {
  it("polls the recorded answers and leaves the limits unknown, the route answers 405", async () => {
    const s = await rqServer("8.1.1");
    try {
      const snap = await new RqDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      expect(snap.status).toMatchObject({ version: "8.1.1", speedLimitBps: null, uploadLimitBps: null });
      expect(snap.items.find(i => i.name === "big.bin")?.status).toBe("downloading");
    } finally {
      await s.close();
    }
  });

  it("sets one limit and keeps the other the adapter set last — unlimited after a start", async () => {
    const s = await rqSynth({ torrents: [] });
    try {
      const d = new RqDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      await d.command({ kind: "setSpeedLimit", bps: 2_000_000 });
      await d.poll();
      await d.command({ kind: "setUploadLimit", bps: 500_000 });
      await d.command({ kind: "setSpeedLimit", bps: 0 });
      expect(posts(s)).toEqual([
        '/torrents/limits {"download_bps":2000000,"upload_bps":null}',
        '/torrents/limits {"download_bps":2000000,"upload_bps":500000}',
        '/torrents/limits {"download_bps":null,"upload_bps":500000}',
      ]);
    } finally {
      await s.close();
    }
  });
});

describe("rqbit driver details", () => {
  it("keeps the other limit as the last poll read it (9.x)", async () => {
    const s = await rqSynth({ torrents: [], limits: { download_bps: 1000, upload_bps: null } });
    try {
      const d = new RqDriver(cfg(s.baseUrl), { ...timers, log });
      expect((await d.poll()).status).toMatchObject({ speedLimitBps: 1000, uploadLimitBps: 0 });
      await d.command({ kind: "setUploadLimit", bps: 500 });
      expect(posts(s)).toEqual(['/torrents/limits {"download_bps":1000,"upload_bps":500}']);
    } finally {
      await s.close();
    }
  });

  it("refuses stats or limits that lost a field — read as none they would empty speeds and limits (fleet C26b)", async () => {
    const speed = { mbps: 1, human_readable: "1.00 MiB/s" };
    const stats = { download_speed: speed, upload_speed: speed };
    const limits = { upload_bps: null, download_bps: 1000 };
    // each way the fleet suite drifts a speed: gone, null, another type (an object keeps its type, loses its first key)
    const drifted = (key: string): Record<string, unknown>[] => [
      Object.fromEntries(Object.entries(stats).filter(([k]) => k !== key)),
      { ...stats, [key]: null },
      { ...stats, [key]: { human_readable: null } },
    ];
    const cases = [
      ...[...drifted("download_speed"), ...drifted("upload_speed")].map(st => ({ stats: st, limits })),
      // null is rqbit's "unlimited" — a limit is refused when it is gone or of another type
      ...[{ upload_bps: null }, { download_bps: 1000 }, { upload_bps: null, download_bps: "1000" }].map(l => ({
        stats,
        limits: l,
      })),
    ];
    for (const c of cases) {
      const s = await rqSynth({ torrents: [], ...c });
      try {
        await expect(new RqDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(ProtocolError);
      } finally {
        await s.close();
      }
    }
    const s = await rqSynth({ torrents: [], stats, limits });
    try {
      expect((await new RqDriver(cfg(s.baseUrl), { ...timers, log }).poll()).status).toMatchObject({
        downloadBps: 1024 * 1024,
        uploadBps: 1024 * 1024,
        speedLimitBps: 1000,
        uploadLimitBps: 0,
      });
    } finally {
      await s.close();
    }
  });

  it("sets a limit on the last limits answer that kept its shape, not on a refused one", async () => {
    const state: RqState = { torrents: [], limits: { upload_bps: 2000, download_bps: 1000 } };
    const s = await rqSynth(state);
    try {
      const d = new RqDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      state.limits = { download_bps: null };
      await expect(d.poll()).rejects.toThrow(ProtocolError);
      await d.command({ kind: "setUploadLimit", bps: 500 });
      // the base of the next set is the last answer that kept its shape, not the refused one
      expect(posts(s)).toEqual(['/torrents/limits {"download_bps":1000,"upload_bps":500}']);
    } finally {
      await s.close();
    }
  });

  it("pauses only live and initializing torrents, holds one added meanwhile and resumes exactly these", async () => {
    const state: RqState = {
      torrents: [
        t("a".repeat(40), "live"),
        t("b".repeat(40), "paused"),
        t("c".repeat(40), "error"),
        t("d".repeat(40), "initializing"),
      ],
    };
    const s = await rqSynth(state);
    const store = memoryPauseStore();
    try {
      const d = new RqDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      await d.command({ kind: "add", url: "magnet:?xt=urn:btih:new" });
      expect(await store.load()).toEqual({ paused: true, keys: ["a".repeat(40), "d".repeat(40), "n".repeat(40)] });
      await d.command({ kind: "resumeAll" });
      expect(posts(s)).toEqual([
        `/torrents/${"a".repeat(40)}/pause`,
        `/torrents/${"d".repeat(40)}/pause`,
        "/torrents magnet:?xt=urn:btih:new",
        `/torrents/${"n".repeat(40)}/pause`,
        `/torrents/${"a".repeat(40)}/start`,
        `/torrents/${"d".repeat(40)}/start`,
        `/torrents/${"n".repeat(40)}/start`,
      ]);
    } finally {
      await s.close();
    }
  });

  it("pauses the others when rqbit refuses one that ended meanwhile, and resumes exactly those (K4)", async () => {
    const [a, gone, c] = ["a", "b", "c"].map(x => x.repeat(40));
    const state: RqState = {
      torrents: [t(a, "live"), t(gone, "live"), t(c, "live")],
      answers: { [`POST /torrents/${gone}/pause`]: UNKNOWN },
    };
    const s = await rqSynth(state);
    const store = memoryPauseStore();
    try {
      const d = new RqDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      expect(await store.load()).toEqual({ paused: true, keys: [a, c] });
      // one gone before the resume is skipped too — the others still start
      state.answers = { [`POST /torrents/${a}/start`]: UNKNOWN };
      await d.command({ kind: "resumeAll" });
      expect(posts(s).filter(p => p.endsWith("/start"))).toEqual([`/torrents/${a}/start`, `/torrents/${c}/start`]);
      expect(await store.load()).toEqual({ paused: false, keys: [] });
    } finally {
      await s.close();
    }
  });

  it("keeps the pause of a torrent 9.x paused during its check — it stays initializing, flagged as paused (K4)", async () => {
    // the recorded torrent `check.bin` before and after `POST /torrents/<hash>/pause` while it was checked: 9.1.0
    // answers 200 and keeps the state `initializing` with `initializing_paused` — the check stands until it is started
    const check = (st: string): unknown =>
      (loadFixture("rqbit", "9.1.0", st, "torrents").body as { torrents: { name: string }[] }).torrents.find(
        x => x.name === "check.bin",
      );
    const hash = "ccc4c11770321ec2ee5cc52b5829fce13232883d";
    const state: RqState = {
      torrents: [check("checking")],
      answers: { [`POST /torrents/${hash}/pause`]: recorded("9.1.0", "commands", "torrent-pause-checking") },
    };
    const s = await rqSynth(state);
    const store = memoryPauseStore();
    try {
      const d = new RqDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      state.torrents = [check("checking-paused")];
      await d.poll();
      const snap = await d.poll();
      expect(await store.load()).toEqual({ paused: true, keys: [hash] });
      expect([snap.status.paused, snap.items[0].status]).toEqual([true, "paused"]);
      state.answers = { [`POST /torrents/${hash}/start`]: recorded("9.1.0", "commands", "torrent-start-checked") };
      await d.command({ kind: "resumeAll" });
      expect(posts(s)).toEqual([`/torrents/${hash}/pause`, `/torrents/${hash}/start`]);
      expect(await store.load()).toEqual({ paused: false, keys: [] });
    } finally {
      await s.close();
    }
  });

  it("pauses the others when 8.x refuses to pause a torrent during its check, which runs on (K4)", async () => {
    const check = (st: string): unknown =>
      (loadFixture("rqbit", "8.1.1", st, "torrents").body as { torrents: { name: string }[] }).torrents.find(
        x => x.name === "check.bin",
      );
    const hash = "ccc4c11770321ec2ee5cc52b5829fce13232883d";
    const a = "a".repeat(40);
    const state: RqState = {
      torrents: [check("checking"), t(a, "live")],
      // 8.1.1: 400 "torrent is initializing, can't pause"
      answers: { [`POST /torrents/${hash}/pause`]: recorded("8.1.1", "commands", "torrent-pause-checking") },
    };
    const s = await rqSynth(state);
    const store = memoryPauseStore();
    try {
      const d = new RqDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      state.torrents = [check("checking-paused"), t(a, "paused")];
      await d.poll();
      const snap = await d.poll();
      expect(await store.load()).toEqual({ paused: true, keys: [a] });
      expect([snap.status.paused, snap.items.map(i => i.status)]).toEqual([true, ["checking", "paused"]]);
    } finally {
      await s.close();
    }
  });

  it("pauses and holds a torrent whose add answered after the program was paused meanwhile", async () => {
    let release = (): void => undefined;
    const answered = new Promise<void>(resolve => (release = resolve));
    const seen: string[] = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const path = (req.url ?? "/").split("?")[0];
        seen.push(`${req.method} ${path}`);
        const send = (v: unknown): void => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(v));
        };
        const answers: Record<string, unknown> = {
          "GET /": { version: "9.1.0" },
          "GET /torrents": { torrents: [t("a".repeat(40), "live")] },
          "GET /stats": { download_speed: { mbps: 0 }, upload_speed: { mbps: 0 } },
          "GET /torrents/limits": { download_bps: null, upload_bps: null },
        };
        if (`${req.method} ${path}` === "POST /torrents") {
          // rqbit answers an add once it has the metadata — here only after the pause below
          void answered.then(() => send({ details: { info_hash: "n".repeat(40) } }));
          return;
        }
        send(answers[`${req.method} ${path}`] ?? {});
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const store = memoryPauseStore();
    try {
      const d = new RqDriver(cfg(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), {
        ...timers,
        log,
        pauseStore: store,
      });
      await d.poll();
      const adding = d.command({ kind: "add", url: "magnet:?xt=urn:btih:slow" });
      await d.command({ kind: "pauseAll" });
      release();
      await adding;
      expect(seen).toContain(`POST /torrents/${"n".repeat(40)}/pause`);
      expect(await store.load()).toEqual({ paused: true, keys: ["a".repeat(40), "n".repeat(40)] });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("adds a link as the text body with overwrite, and reports rqbit's reason when it refuses the torrent", async () => {
    const s = await rqSynth({ torrents: [], add: recorded("9.1.0", "commands", "torrents-post-readonly") });
    try {
      const d = new RqDriver(cfg(s.baseUrl), { ...timers, log });
      await expect(d.command({ kind: "add", url: "https://example.org/x.torrent" })).rejects.toThrow(
        /HTTP 400 \(error adding torrent: .*Read-only file system/,
      );
      const call = s.calls.find(c => c.path === "/torrents");
      expect(call).toMatchObject({ query: "overwrite=true&timeout_ms=100000", body: "https://example.org/x.torrent" });
      expect(call?.headers["content-type"]).toBe("text/plain");
    } finally {
      await s.close();
    }
  });

  it("asks rqbit to give up an add before the adapter does, both with room before the fleet's hang deadline (D21)", async () => {
    const waits: number[] = [];
    const counting = {
      setTimeout: (cb: () => void, ms: number): ioBroker.Timeout => {
        waits.push(ms);
        return timers.setTimeout(cb, ms);
      },
      clearTimeout: timers.clearTimeout,
    };
    const s = await rqSynth({ torrents: [] });
    try {
      await new RqDriver(cfg(s.baseUrl), { ...counting, log }).command({
        kind: "add",
        url: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
      });
      const add = s.calls.find(c => c.method === "POST" && c.path === "/torrents");
      const asked = Number(new URLSearchParams(add?.query).get("timeout_ms"));
      const wait = Math.max(...waits);
      // rqbit waits 600 s for a magnet's metadata unless told otherwise (handlers/torrents.rs `Timeout<600_000, …>`); its
      // own answer names the cause, and the fleet suite measures a hung call from outside against 120 s
      expect(asked).toBeGreaterThan(0);
      expect(wait).toBeGreaterThan(asked);
      expect(wait).toBeLessThanOrEqual(120_000 - 10_000);
    } finally {
      await s.close();
    }
  });

  it("refuses a command on a torrent rqbit does not know with its text", async () => {
    const s = await rqServer();
    try {
      await expect(
        new RqDriver(cfg(s.baseUrl), { ...timers, log }).command({ kind: "pause", key: "0".repeat(40) }),
      ).rejects.toThrow(/HTTP 404 \(torrent not found/);
    } finally {
      await s.close();
    }
  });

  it("reads the version once and again after a failed poll", async () => {
    const state: RqState = { torrents: [] };
    const s = await rqSynth(state);
    const roots = (): number => s.calls.filter(c => c.path === "/").length;
    try {
      const d = new RqDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      await d.poll();
      expect(roots()).toBe(1);
      state.torrents = "broken" as unknown as unknown[];
      await expect(d.poll()).rejects.toThrow(ProtocolError);
      state.torrents = [];
      await d.poll();
      expect(roots()).toBe(2);
    } finally {
      await s.close();
    }
  });

  it("refuses a torrent list with an empty entry or a torrent without its hash (fleet C26b)", async () => {
    for (const odd of [null, { info_hash: 7, stats: { state: "live" } }]) {
      const s = await rqSynth({ torrents: [odd, t("h".repeat(40), "live")] });
      try {
        await expect(new RqDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(ProtocolError);
      } finally {
        await s.close();
      }
    }
  });

  it("asks the default port without a path, sends basic auth only with a user, rejects a wrong password", async () => {
    expect(await firstUrl(() => new RqDriver({ ...cfg("http://nas:1"), port: 0 }, { ...timers, log }).poll())).toBe(
      "http://nas:3030/",
    );
    const s = await rqSynth({ torrents: [] });
    try {
      await new RqDriver({ ...cfg(s.baseUrl), username: "", password: "" }, { ...timers, log }).poll();
      expect(s.calls.every(c => c.headers.authorization === undefined)).toBe(true);
    } finally {
      await s.close();
    }
    const r = await rqServer();
    try {
      await expect(new RqDriver(cfg(r.baseUrl, "bad"), { ...timers, log }).poll()).rejects.toThrow(AuthError);
    } finally {
      await r.close();
    }
  });
});
