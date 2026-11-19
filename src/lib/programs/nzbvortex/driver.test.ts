import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer, type FixtureAnswer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import { AuthError, ProtocolError, UnreachableError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { loginHash } from "./client";
import { NvDriver } from "./driver";
import { mapNvStatus, statusTable } from "./map";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };

/** The API key the fixture server accepts. */
const KEY = "1EC2-FCD9";
/** Nonce and session id of the fixtures (placeholders of the captures). */
const NONCE = "11111111-1111-1111-1111-111111111111";
const SESSION = "22222222-2222-2222-2222-222222222222";
const V = "doc-1.7";

const cfg = (base: string, apiKey = KEY): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "nzbvortex",
    deviceId: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "",
    username: "",
    password: "",
    apiKey,
    device: "",
  };
};

/**
 * @param state state folder
 * @param name file name
 * @returns the answer as the fixture server sends it
 */
const answer = (state: string, name: string): FixtureAnswer => {
  const f = loadFixture("nzbvortex", V, state, name);
  return { status: f.status, body: f.body };
};

/** A queue as the fixtures hold it. */
interface Queue {
  result: string;
  nzbs: Record<string, unknown>[];
}

/** @returns a copy of the fixture queue to change in a test */
const queue = (): Queue => structuredClone(loadFixture("nzbvortex", V, "queue", "list").body) as Queue;

/** What the fixture server answers; the test changes it between calls. */
interface NvState {
  /** A queue of its own instead of the fixture's. */
  list?: Queue;
  /** The answer to `nzb/add` instead of the fixture's. */
  added?: unknown;
  /** The answer to `speedlimit` instead of the fixture's. */
  limit?: unknown;
  /** Every call with a session answers 403 — also on a session just opened. */
  refuseAll?: boolean;
  /** A lapsed session answers HTTP 200 with `not_logged_in` instead of a 403. */
  lapseAs200?: boolean;
  /** These NZBs refuse a pause. */
  refusePause?: string[];
  /** The answer to a request ahead of every other route, undefined for the usual one. */
  route?: (call: RecordedCall) => FixtureAnswer | undefined;
}

/**
 * NZBVortex from the fixtures: a nonce, a login that checks the documented hash over the nonce and the key `KEY`,
 * every other call routed by its path. Pause and resume per NZB change the queue's `isPaused`.
 *
 * @param state the answers, read at every request
 * @returns the running server
 */
async function nvServer(state: NvState = {}): Promise<ContractServer> {
  let lapse = false;
  const pausedNow = new Map<string, boolean>();
  const s = await startFixtureServer(call => {
    const own = state.route?.(call);
    if (own) {
      return own;
    }
    const q = new URLSearchParams(call.query);
    if (call.path === "/api/auth/nonce") {
      return answer("auth", "nonce");
    }
    if (call.path === "/api/auth/login") {
      const ok = q.get("nonce") === NONCE && q.get("hash") === loginHash(NONCE, q.get("cnonce") ?? "", KEY);
      return ok ? answer("auth", "login") : answer("auth", "login-failed");
    }
    if (q.get("sessionid") !== SESSION || state.refuseAll) {
      return answer("auth", "not-logged-in");
    }
    if (lapse) {
      lapse = false;
      return state.lapseAs200 ? { body: { result: "not_logged_in" } } : answer("auth", "not-logged-in");
    }
    const command = /^\/api\/nzb\/(\d+)\/(pause|resume|cancel)$/.exec(call.path);
    if (command) {
      const [, id, kind] = command;
      if (kind === "pause" && state.refusePause?.includes(id)) {
        return { body: { result: "failed" } };
      }
      if (kind !== "cancel") {
        pausedNow.set(id, kind === "pause");
      }
      return answer("commands", "ok");
    }
    switch (call.path) {
      case "/api/app/appversion":
        return answer("app", "appversion");
      case "/api/nzb": {
        const list = state.list ?? queue();
        return {
          body: {
            ...list,
            nzbs: list.nzbs.map(e => ({ ...e, isPaused: pausedNow.get(String(e.id)) ?? e.isPaused })),
          },
        };
      }
      case "/api/nzb/add":
        return state.added === undefined ? answer("commands", "add") : { body: state.added };
      case "/api/speedlimit":
        return state.limit === undefined ? answer("speedlimit", "get") : { body: state.limit };
      case "/api/speedlimit/enable":
        return answer("speedlimit", "enable");
      case "/api/speedlimit/disable":
        return answer("speedlimit", "disable");
      default:
        return { status: 404, body: { result: "unknown_command" } };
    }
  });
  return {
    ...s,
    expireSession: () => {
      lapse = true;
    },
  };
}

const isLogin = (call: RecordedCall): boolean => call.path === "/api/auth/login";

runDriverContract({
  type: "nzbvortex",
  server: () => nvServer(),
  makeDriver: (base, creds) => new NvDriver(cfg(base, creds.good ? KEY : "wrong"), { ...timers, log }),
  mapStatus: mapNvStatus,
  statusTable,
  unknownStatus: "25",
  commandCalls: {
    pauseAll: { method: "GET", path: "/api/nzb/11/pause" },
    resumeAll: { method: "GET", path: "/api/nzb/11/resume" },
    pause: { method: "GET", path: "/api/nzb/11/pause" },
    resume: { method: "GET", path: "/api/nzb/11/resume" },
    remove: { method: "GET", path: "/api/nzb/11/cancel" },
    add: { method: "GET", path: "/api/nzb/add", bodyContains: "url=magnet" },
    setSpeedLimit: { method: "GET", path: "/api/speedlimit/enable", bodyContains: "speed=1953" },
  },
  isLoginCall: isLogin,
});

describe("NZBVortex login hash", () => {
  it("gives the documentation's test vector (p. 7)", () => {
    expect(loginHash("B8DB315C-2C2C-45AA-9088-875D9ED9A90E", "5E992A86", "1EC2-FCD9")).toBe(
      "AmFTryv+yASQ6japQf4KgD9ChvJl67+e5SytFhCbWRM=",
    );
  });
});

describe("NZBVortex driver", () => {
  let server: ContractServer;
  let state: NvState;
  let driver: NvDriver;
  const start = async (over: NvState = {}, apiKey = KEY): Promise<void> => {
    state = { ...over };
    server = await nvServer(state);
    driver = new NvDriver(cfg(server.baseUrl, apiKey), { ...timers, log, pauseStore: memoryPauseStore() });
  };
  const paths = (from = 0): string[] => server.calls.slice(from).map(c => c.path);
  afterEach(async () => {
    await driver.close();
    await server.close();
  });

  it("reads the queue: every status, bytes, rate, time left, group and the error of a failed NZB", async () => {
    await start();
    const s = await driver.poll();
    // the documentation's limit example is switched off: 0 = unlimited
    expect(s.status).toEqual({ version: "2.9.0", paused: false, downloadBps: 2_500_000, speedLimitBps: 0 });
    expect(s.items.map(i => [i.key, i.status, i.error])).toEqual([
      ["11", "downloading", ""],
      ["12", "queued", ""],
      ["13", "paused", ""],
      ["14", "postprocessing", ""],
      ["15", "completed", ""],
      ["16", "failed", "Check failed, data corrupt"],
    ]);
    expect(s.items[0]).toMatchObject({
      name: "nzb-loading",
      sizeBytes: 1_000_000_000,
      doneBytes: 400_000_000,
      speedBps: 2_500_000,
      etaSeconds: 240,
      category: "Software",
    });
    expect(s.items[2]).toMatchObject({ speedBps: 0, etaSeconds: null, category: "" });
  });

  it("reads an empty queue as a running NZBVortex sent it", async () => {
    await start({ list: loadFixture("nzbvortex", V, "queue", "list-empty").body as Queue });
    expect((await driver.poll()).items).toEqual([]);
  });

  it("logs in with the hash and keeps the API key out of every request; the session goes last", async () => {
    await start();
    await driver.poll();
    expect(paths()).toEqual([
      "/api/auth/nonce",
      "/api/auth/login",
      "/api/app/appversion",
      "/api/nzb",
      "/api/speedlimit",
    ]);
    const login = new URLSearchParams(server.calls[1].query);
    expect(login.get("hash")).toBe(loginHash(NONCE, login.get("cnonce") ?? "", KEY));
    // Base64's + / = percent-encoded (documentation p. 7)
    expect(/(^|&)hash=[A-Za-z0-9%]+(&|$)/.test(server.calls[1].query)).toBe(true);
    expect(server.calls.every(c => !c.query.includes(KEY))).toBe(true);
    expect(server.calls.slice(2).every(c => c.query.endsWith(`sessionid=${SESSION}`))).toBe(true);
    // the version is read once
    await driver.poll();
    expect(paths(5)).toEqual(["/api/nzb", "/api/speedlimit"]);
  });

  it("gives up on a wrong API key with one rejected login", async () => {
    await start({}, "wrong");
    await expect(driver.poll()).rejects.toThrow(AuthError);
    await expect(driver.poll()).rejects.toThrow(/check the API key/);
  });

  it("logs in again on a lapsed session that answers 200 with not_logged_in", async () => {
    await start({ lapseAs200: true });
    await driver.poll();
    server.expireSession?.();
    expect((await driver.poll()).complete).toBe(true);
    expect(server.calls.filter(isLogin)).toHaveLength(2);
  });

  it("refuses a session NZBVortex rejects right after the login, without logging in again", async () => {
    await start({ refuseAll: true });
    await expect(driver.poll()).rejects.toThrow(ProtocolError);
    await expect(driver.poll()).rejects.toThrow(/refused at once/);
    expect(server.calls.filter(isLogin)).toHaveLength(2);
  });

  it("refuses an answer that is not ok", async () => {
    await start({ limit: { result: "unknown_command" } });
    await expect(driver.poll()).rejects.toThrow(/speedlimit refused \(unknown_command\)/);
    // a refusal that is no lost session opens no new one
    expect(server.calls.filter(isLogin)).toHaveLength(1);
  });

  it("pauses everything by pausing what runs, and resumes exactly that", async () => {
    await start();
    await driver.poll();
    const from = server.calls.length;
    await driver.command({ kind: "pauseAll" });
    expect(paths(from)).toEqual(["/api/nzb", "/api/nzb/11/pause", "/api/nzb/12/pause"]);
    const s = await driver.poll();
    expect(s.status.paused).toBe(true);
    expect(s.items.slice(0, 3).map(i => i.status)).toEqual(["paused", "paused", "paused"]);
    const back = server.calls.length;
    await driver.command({ kind: "resumeAll" });
    // 13 the user paused himself — it stays paused
    expect(paths(back)).toEqual(["/api/nzb", "/api/nzb/11/resume", "/api/nzb/12/resume"]);
    expect((await driver.poll()).status.paused).toBe(false);
  });

  it("ends the pause when the user starts one of its NZBs himself", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    expect((await driver.poll()).status.paused).toBe(true);
    await driver.command({ kind: "resume", key: "11" });
    expect((await driver.poll()).status.paused).toBe(false);
  });

  it("pauses what it can when one NZB refuses the pause", async () => {
    await start({ refusePause: ["12"] });
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    await driver.poll();
    const back = server.calls.length;
    await driver.command({ kind: "resumeAll" });
    expect(paths(back)).toEqual(["/api/nzb", "/api/nzb/11/resume"]);
  });

  it("holds a link added during the pause by the add_uuid NZBVortex named for it", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    await driver.poll();
    await driver.command({ kind: "add", url: "https://example.com/a.nzb" });
    expect(server.calls.at(-1)?.query).toContain("url=https%3A%2F%2Fexample.com%2Fa.nzb");
    // NZBVortex queues it a little later: the next poll does not list it yet, the one after does
    await driver.poll();
    const list = queue();
    list.nzbs.push({
      ...list.nzbs[0],
      id: 17,
      uiTitle: "nzb-added",
      addUUID: "{0D4E1F2A-0000-4000-8000-000000000021}",
    });
    state.list = list;
    const from = server.calls.length;
    const s = await driver.poll();
    expect(paths(from)).toContain("/api/nzb/17/pause");
    expect(s.items.find(i => i.key === "17")?.status).toBe("paused");
    expect(s.status.paused).toBe(true);
    const back = server.calls.length;
    await driver.command({ kind: "resumeAll" });
    expect(paths(back)).toEqual(["/api/nzb", "/api/nzb/11/resume", "/api/nzb/12/resume", "/api/nzb/17/resume"]);
  });

  it("holds a link added during the pause without add_uuid as the next new running NZB", async () => {
    await start({ added: { result: "ok" } });
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    await driver.command({ kind: "add", url: "https://example.com/b.nzb" });
    const list = queue();
    list.nzbs.push({ ...list.nzbs[1], id: 18, uiTitle: "nzb-added", addUUID: null });
    state.list = list;
    const s = await driver.poll();
    expect(s.items.find(i => i.key === "18")?.status).toBe("paused");
    // held once: the next poll pauses nothing more, not even an NZB the user adds in NZBVortex itself
    const from = server.calls.length;
    await driver.poll();
    list.nzbs.push({ ...list.nzbs[1], id: 19, uiTitle: "nzb-of-the-user", addUUID: null });
    await driver.poll();
    expect(paths(from)).toEqual(["/api/nzb", "/api/speedlimit", "/api/nzb", "/api/speedlimit"]);
  });

  it("holds a link added during the pause on the next poll when the first hold did not reach NZBVortex (K4)", async () => {
    await start({ added: { result: "ok" } });
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    await driver.command({ kind: "add", url: "https://example.com/b.nzb" });
    const list = queue();
    list.nzbs.push({ ...list.nzbs[1], id: 18, uiTitle: "nzb-added", addUUID: null });
    state.list = list;
    state.route = c => (c.path === "/api/nzb/18/pause" ? { status: 503, body: "" } : undefined);
    await expect(driver.poll()).rejects.toThrow(UnreachableError);
    state.route = undefined;
    const s = await driver.poll();
    expect(s.items.find(i => i.key === "18")?.status).toBe("paused");
    const back = server.calls.length;
    await driver.command({ kind: "resumeAll" });
    expect(paths(back)).toContain("/api/nzb/18/resume");
  });

  it("leaves a link added while nothing is paused running", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "add", url: "https://example.com/c.nzb" });
    const list = queue();
    list.nzbs.push({ ...list.nzbs[0], id: 19, addUUID: "{0D4E1F2A-0000-4000-8000-000000000021}" });
    state.list = list;
    const from = server.calls.length;
    const s = await driver.poll();
    expect(paths(from)).toEqual(["/api/nzb", "/api/speedlimit"]);
    expect(s.items.find(i => i.key === "19")?.status).toBe("downloading");
  });

  it("sets the limit in KB/s and switches it off at 0; reads a limit that is on", async () => {
    await start({
      limit: { result: "ok", speedlimit_enabled: true, speedlimit: 512, speedlimit_minutes: 0 },
    });
    expect((await driver.poll()).status.speedLimitBps).toBe(512 * 1024);
    await driver.command({ kind: "setSpeedLimit", bps: 2_000_000 });
    expect(server.calls.at(-1)).toMatchObject({ path: "/api/speedlimit/enable" });
    expect(new URLSearchParams(server.calls.at(-1)?.query).get("speed")).toBe("1953");
    await driver.command({ kind: "setSpeedLimit", bps: 0 });
    expect(server.calls.at(-1)?.path).toBe("/api/speedlimit/disable");
  });

  it("removes with cancel, which keeps the files, and refuses a key that is no NZB id", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "remove", key: "16" });
    expect(server.calls.at(-1)?.path).toBe("/api/nzb/16/cancel");
    const from = server.calls.length;
    await expect(driver.command({ kind: "pause", key: "../app" })).rejects.toThrow(ProtocolError);
    expect(server.calls.length).toBe(from);
    expect(server.calls.some(c => c.path.includes("cancelDelete"))).toBe(false);
  });

  it("refuses the session opened after a lapse when NZBVortex rejects it at once too", async () => {
    await start();
    await driver.poll();
    state.refuseAll = true;
    await expect(driver.poll()).rejects.toThrow(
      new ProtocolError("nzbvortex: the new session was refused at once (HTTP 403)"),
    );
    expect(server.calls.filter(isLogin)).toHaveLength(2);
  });

  it("fails the poll when the call repeated with the new session is refused", async () => {
    await start();
    await driver.poll();
    server.expireSession?.();
    let lists = 0;
    state.route = c => (c.path === "/api/nzb" && ++lists === 2 ? { body: { result: "failed" } } : undefined);
    await expect(driver.poll()).rejects.toThrow("nzbvortex: nzb refused (failed)");
    expect(server.calls.filter(isLogin)).toHaveLength(2);
  });

  it("refuses a login without its nonce or session id, and names what an answer that is none answered", async () => {
    await start({ route: c => (c.path === "/api/auth/nonce" ? { body: { result: "ok" } } : undefined) });
    await expect(driver.poll()).rejects.toThrow("NZBVortex's nonce is missing — answer refused");
    state.route = c =>
      c.path === "/api/auth/login" ? { body: { result: "ok", loginResult: "successful" } } : undefined;
    await expect(driver.poll()).rejects.toThrow("NZBVortex's login answer lost its shape — answer refused");
    state.route = c => (c.path === "/api/auth/nonce" ? { status: 500, body: "x" } : undefined);
    await expect(driver.poll()).rejects.toThrow("nzbvortex: auth/nonce answered HTTP 500");
    state.route = c => (c.path === "/api/nzb" ? { status: 500, body: "x" } : undefined);
    await expect(driver.poll()).rejects.toThrow("nzbvortex: nzb answered HTTP 500");
    state.route = c => (c.path === "/api/nzb" ? { body: { nzbs: [] } } : undefined);
    await expect(driver.poll()).rejects.toThrow("nzbvortex: nzb refused (no result)");
  });

  it("fails the pause for everything when a pause does not reach NZBVortex, instead of passing over it", async () => {
    await start({ route: c => (c.path === "/api/nzb/11/pause" ? { status: 503, body: "" } : undefined) });
    await driver.poll();
    await expect(driver.command({ kind: "pauseAll" })).rejects.toThrow(UnreachableError);
  });

  it("remembers what it paused before a pause did not reach NZBVortex, and resumes that later (K4)", async () => {
    await start({ route: c => (c.path === "/api/nzb/12/pause" ? { status: 503, body: "" } : undefined) });
    await driver.poll();
    await expect(driver.command({ kind: "pauseAll" })).rejects.toThrow(UnreachableError);
    state.route = undefined;
    expect((await driver.poll()).status.paused).toBe(true);
    const back = server.calls.length;
    await driver.command({ kind: "resumeAll" });
    expect(paths(back)).toEqual(["/api/nzb", "/api/nzb/11/resume"]);
  });

  it("keeps the pause for what a resume did not reach yet, and resumes that next time (K4)", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    await driver.poll();
    state.route = c => (c.path === "/api/nzb/12/resume" ? { status: 503, body: "" } : undefined);
    await expect(driver.command({ kind: "resumeAll" })).rejects.toThrow(UnreachableError);
    state.route = undefined;
    // 11 runs again, the pause holds for 12
    expect((await driver.poll()).status.paused).toBe(true);
    const back = server.calls.length;
    await driver.command({ kind: "resumeAll" });
    expect(paths(back)).toEqual(["/api/nzb", "/api/nzb/12/resume"]);
  });

  it("leaves a link added during the pause running when the pause ended before it was listed", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    await driver.poll();
    await driver.command({ kind: "add", url: "https://example.com/a.nzb" });
    await driver.command({ kind: "resumeAll" });
    const list = queue();
    list.nzbs.push({
      ...list.nzbs[0],
      id: 17,
      uiTitle: "nzb-added",
      addUUID: "{0D4E1F2A-0000-4000-8000-000000000021}",
    });
    state.list = list;
    const from = server.calls.length;
    const s = await driver.poll();
    expect(paths(from)).toEqual(["/api/nzb", "/api/speedlimit"]);
    expect(s.items.find(i => i.key === "17")?.status).toBe("downloading");
  });
});
