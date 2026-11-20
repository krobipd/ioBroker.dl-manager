import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer, type FixtureAnswer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import { AuthError, ProtocolError, RefusedError, UnreachableError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { DsDriver } from "./driver";
import { mapDsStatus, statusTable } from "./map";

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
    type: "downloadstation",
    deviceId: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "",
    username: "admin",
    password,
    apiKey: "",
    device: "",
  };
};

/**
 * @param version fixture version
 * @param state state folder
 * @param name file name
 * @returns the answer as the fixture server sends it
 */
const answer = (version: string, state: string, name: string): FixtureAnswer => {
  const f = loadFixture("downloadstation", version, state, name);
  return { status: f.status, body: f.body };
};

/** A task list as the fixtures hold it. */
interface TaskList {
  data: { tasks: Record<string, unknown>[] };
}

/**
 * @param version fixture version
 * @param state state folder
 * @returns a copy of the fixture's task list to change in a test
 */
const listOf = (version: string, state: string): TaskList =>
  structuredClone(loadFixture("downloadstation", version, state, "list").body) as TaskList;

/**
 * @param list a task list
 * @param id a task
 * @param status its new status
 * @returns the list with that task's status changed
 */
const withStatus = (list: TaskList, id: string, status: string): TaskList => ({
  ...list,
  data: { ...list.data, tasks: list.data.tasks.map(t => (t.id === id ? { ...t, status } : t)) },
});

/**
 * The recorded answer of a command per id (dbid_1 and dbid_2), narrowed to the ids asked for — an id it does not hold
 * gets the recorded success (error 0), as Download Station answers each id it was given.
 *
 * @param method `pause`, `resume` or `delete`
 * @param ids the comma-separated ids of the request
 * @returns the answer
 */
function perIdAnswer(method: string, ids: string): FixtureAnswer {
  const recorded = loadFixture("downloadstation", "4.1-5012", "commands", method).body as {
    data: { error: number; id: string }[];
  };
  const errors = new Map(recorded.data.map(e => [e.id, e.error]));
  return {
    body: { data: ids.split(",").map(id => ({ error: errors.get(id) ?? 0, id })), success: true },
  };
}

/** What the fixture server answers; the test changes it between calls. */
interface DsState {
  /** Fixture version. */
  version: string;
  /** State folder of `getinfo`, `getconfig` and `list`. */
  state: string;
  /** A task list of its own instead of the state's. */
  list?: TaskList;
  /** The API list of its own. */
  apis?: unknown;
  /** Every call with a session answers this error code. */
  refuseAll?: number;
  /** The answer to a request ahead of every other route, undefined for the usual one. */
  route?: (call: RecordedCall, form: URLSearchParams) => FixtureAnswer | undefined;
}

/**
 * Download Station from the fixtures: the API list, a login with admin/good opening the session `session_id`, every
 * other call routed by its CGI and form field `method`.
 *
 * @param state the answers, read at every request
 * @returns the running server
 */
async function dsServer(state: DsState): Promise<ContractServer & { expireWith(code: number): void }> {
  let expire: number | null = null;
  const v = state.version;
  const s = await startFixtureServer(call => {
    const form = new URLSearchParams(call.body);
    const own = state.route?.(call, form);
    if (own) {
      return own;
    }
    if (call.path === "/webapi/query.cgi") {
      return state.apis ? { body: state.apis } : answer(v, "auth", "api-info");
    }
    if (form.get("method") === "login") {
      return form.get("account") === "admin" && form.get("passwd") === "good"
        ? answer(v, "auth", "login")
        : answer("4.1-5012", "auth", "login-wrong");
    }
    if (form.get("_sid") !== "session_id") {
      return answer("4.1-5012", "auth", "session-expired");
    }
    if (state.refuseAll !== undefined) {
      return { body: { error: { code: state.refuseAll }, success: false } };
    }
    if (expire !== null) {
      const code = expire;
      expire = null;
      return code === 105 ? answer("4.1-5012", "auth", "no-permission") : answer("4.1-5012", "auth", "session-expired");
    }
    switch (`${call.path} ${form.get("method")}`) {
      case "/webapi/DownloadStation/info.cgi getinfo":
        return answer(v, state.state, "info");
      case "/webapi/DownloadStation/info.cgi getconfig":
        return answer(v, state.state, "config");
      case "/webapi/DownloadStation/info.cgi setserverconfig":
        return answer("4.1-5012", "commands", "setserverconfig");
      case "/webapi/DownloadStation/task.cgi list":
        return state.list ? { body: state.list } : answer(v, state.state, "list");
      case "/webapi/DownloadStation/task.cgi pause":
      case "/webapi/DownloadStation/task.cgi resume":
      case "/webapi/DownloadStation/task.cgi delete":
        return perIdAnswer(String(form.get("method")), String(form.get("id")));
      case "/webapi/DownloadStation/task.cgi create":
        return answer("4.1-5012", "commands", "create");
      default:
        return { status: 404, body: "" };
    }
  });
  return {
    ...s,
    expireSession: () => {
      expire = 119;
    },
    expireWith: (code: number) => {
      expire = code;
    },
  };
}

const isLogin = (call: RecordedCall): boolean => new URLSearchParams(call.body).get("method") === "login";
const formOf = (call: RecordedCall): URLSearchParams => new URLSearchParams(call.body);
const TASK = "/webapi/DownloadStation/task.cgi";

runDriverContract({
  type: "downloadstation",
  server: () => dsServer({ version: "4.1-5012", state: "running" }),
  makeDriver: (base, creds) => new DsDriver(cfg(base, creds.good ? "good" : "wrong"), { ...timers, log }),
  mapStatus: mapDsStatus,
  statusTable,
  unknownStatus: "stalled",
  commandCalls: {
    pauseAll: { method: "POST", path: TASK, bodyContains: "method=pause" },
    resumeAll: { method: "POST", path: TASK, bodyContains: "method=resume" },
    pause: { method: "POST", path: TASK, bodyContains: "method=pause" },
    resume: { method: "POST", path: TASK, bodyContains: "method=resume" },
    remove: "refused",
    add: { method: "POST", path: TASK, bodyContains: "method=create" },
    setUploadLimit: { method: "POST", path: "/webapi/DownloadStation/info.cgi", bodyContains: "bt_max_upload=1953" },
  },
  removeWithFiles: { method: "POST", path: TASK, bodyContains: ["method=delete", "force_complete=false"] },
  isLoginCall: isLogin,
});

describe("Download Station driver", () => {
  let server: Awaited<ReturnType<typeof dsServer>>;
  let state: DsState;
  let driver: DsDriver;
  const start = async (over: Partial<DsState> = {}): Promise<void> => {
    state = { version: "4.1-5012", state: "running", ...over };
    server = await dsServer(state);
    driver = new DsDriver(cfg(server.baseUrl), { ...timers, log, pauseStore: memoryPauseStore() });
  };
  afterEach(async () => {
    await driver.close();
    await server.close();
  });

  it("reads DSM 7.2.2's live list: a magnet without metadata and a finished HTTP task", async () => {
    await start();
    const s = await driver.poll();
    expect(s.status).toMatchObject({ version: "4.1-5012", paused: false, downloadBps: 0, uploadBps: 0 });
    // no download limit for the whole program; bt_max_upload 20 KB/s, eMule switched off
    expect(s.status).not.toHaveProperty("speedLimitBps");
    expect(s.status.uploadLimitBps).toBe(20 * 1024);
    expect(s.items).toEqual([
      expect.objectContaining({
        key: "dbid_1",
        name: "capture-magnet",
        status: "downloading",
        sizeBytes: null,
        doneBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        addedMs: 1791647736000,
        finishedMs: null,
        error: "",
      }),
      expect.objectContaining({
        key: "dbid_2",
        name: "Unknown",
        status: "completed",
        sizeBytes: 577,
        doneBytes: 577,
        ratio: null,
        finishedMs: 1791647740000,
      }),
    ]);
  });

  it("logs in with version 6 on DSM 7 and keeps password and session out of every URL", async () => {
    await start();
    await driver.poll();
    const login = server.calls.find(isLogin);
    expect(login).toMatchObject({ method: "POST", path: "/webapi/entry.cgi", query: "" });
    expect(Object.fromEntries(formOf(login as RecordedCall))).toMatchObject({
      api: "SYNO.API.Auth",
      version: "6",
      session: "DownloadStation",
      format: "sid",
    });
    expect(server.calls.filter(c => c.path !== "/webapi/query.cgi").every(c => c.query === "")).toBe(true);
    expect(
      server.calls.filter(c => !isLogin(c) && c.path !== "/webapi/query.cgi").map(c => formOf(c).get("_sid")),
    ).toEqual(["session_id", "session_id", "session_id"]);
  });

  it("reads DSM 6's list with version 2 at auth.cgi — without transfer no bytes, rates or time left", async () => {
    await start({ version: "3.8-3543" });
    const s = await driver.poll();
    expect(formOf(server.calls.find(isLogin) as RecordedCall).get("version")).toBe("2");
    expect(server.calls.find(isLogin)?.path).toBe("/webapi/auth.cgi");
    expect(s.status.version).toBe("3.8-3543");
    expect(s.status.uploadLimitBps).toBe(800 * 1024);
    expect(s.items.map(i => [i.key, i.status, i.error])).toEqual([
      ["dbid_86", "downloading", ""],
      ["dbid_164", "downloading", ""],
      ["dbid_486", "downloading", ""],
      ["dbid_518", "paused", ""],
      ["dbid_522", "completed", ""],
      ["dbid_531", "completed", ""],
      ["dbid_533", "failed", "unknown"],
      ["dbid_549", "failed", "broken_link"],
    ]);
    for (const i of s.items) {
      expect([i.doneBytes, i.speedBps, i.etaSeconds, i.uploadBps]).toEqual([null, null, null, null]);
    }
  });

  it("refuses a login DSM answers with 400 as a rejected login", async () => {
    await start();
    driver = new DsDriver(cfg(server.baseUrl, "wrong"), { ...timers, log });
    await expect(driver.poll()).rejects.toThrow(/login rejected — no such account or wrong password/);
  });

  it("logs in again once on a 105 for an old session and repeats the call", async () => {
    await start();
    await driver.poll();
    server.expireWith(105);
    expect((await driver.poll()).complete).toBe(true);
    expect(server.calls.filter(isLogin)).toHaveLength(2);
  });

  it("calls a 105 on a session just opened the account's missing right — an AuthError", async () => {
    await start({ refuseAll: 105 });
    await expect(driver.poll()).rejects.toThrow(AuthError);
    expect(server.calls.filter(isLogin)).toHaveLength(1);
  });

  it("calls a DiskStation that lists no Download Station unreachable", async () => {
    await start({
      apis: { data: { "SYNO.API.Auth": { maxVersion: 7, minVersion: 1, path: "entry.cgi" } }, success: true },
    });
    await expect(driver.poll()).rejects.toThrow(UnreachableError);
  });

  it("refuses an API list whose path leaves /webapi/", async () => {
    await start({
      apis: {
        data: {
          "SYNO.API.Auth": { maxVersion: 7, minVersion: 1, path: "../entry.cgi" },
          "SYNO.DownloadStation.Info": { maxVersion: 2, minVersion: 1, path: "DownloadStation/info.cgi" },
          "SYNO.DownloadStation.Task": { maxVersion: 3, minVersion: 1, path: "DownloadStation/task.cgi" },
        },
        success: true,
      },
    });
    await expect(driver.poll()).rejects.toThrow(
      new ProtocolError("Download Station's API list, SYNO.API.Auth, lost its shape — answer refused"),
    );
  });

  it("shows no upload limit to an account that does not manage Download Station and refuses to set it", async () => {
    await start({ state: "user" });
    const s = await driver.poll();
    expect(s.status.uploadLimitBps).toBeNull();
    await expect(driver.command({ kind: "setUploadLimit", bps: 1_000_000 })).rejects.toThrow(/manager/);
    expect(server.calls.some(c => formOf(c).get("method") === "setserverconfig")).toBe(false);
  });

  it("writes the upload limit into the upload fields only, 0 for unlimited", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "setUploadLimit", bps: 0 });
    const set = formOf(server.calls.filter(c => formOf(c).get("method") === "setserverconfig")[0]);
    expect([...set.keys()].filter(k => k.endsWith("_max_upload") || k.endsWith("_max_download"))).toEqual([
      "bt_max_upload",
    ]);
    expect(set.get("bt_max_upload")).toBe("0");
  });

  it("refuses a pause Download Station refuses for the task (405)", async () => {
    await start();
    await driver.poll();
    await expect(driver.command({ kind: "pause", key: "dbid_2" })).rejects.toThrow(/dbid_2 \(error 405\)/);
  });

  it("removes a finished task keeping its files and an unfinished one with them, refuses the rest, adds one link", async () => {
    await start();
    await driver.poll();
    const deletes = (): string[] =>
      server.calls
        .map(formOf)
        .filter(f => f.get("method") === "delete")
        .map(f => `${f.get("id")} ${f.get("force_complete")}`);
    // dbid_1 loads, dbid_2 is finished: Download Station discards what dbid_1 loaded and keeps dbid_2's files
    await expect(driver.command({ kind: "remove", key: "dbid_1" })).rejects.toThrow(
      new RefusedError("Download Station deletes what an unfinished download loaded"),
    );
    await expect(driver.command({ kind: "remove", key: "dbid_2", deleteFiles: true })).rejects.toThrow(
      new RefusedError("Download Station does not delete the files of a finished download"),
    );
    await expect(driver.command({ kind: "remove", key: "dbid_9", deleteFiles: true })).rejects.toThrow(
      new RefusedError("Download Station's last answer does not list this download"),
    );
    expect(deletes()).toEqual([]);
    await driver.command({ kind: "remove", key: "dbid_1", deleteFiles: true });
    await driver.command({ kind: "remove", key: "dbid_2" });
    expect(deletes()).toEqual(["dbid_1 false", "dbid_2 false"]);
    await driver.command({ kind: "add", url: "http://example.com/a,b" });
    const sent = server.calls.map(formOf);
    expect(sent.find(f => f.get("method") === "create")?.get("uri")).toBe("http://example.com/a\\,b");
  });

  it("counts a paused task with every byte as finished when it says what a removal can do (core decision D-13)", async () => {
    // dbid_2 has every byte; paused, Download Station keeps its files on removal like a finished task's
    await start({
      list: withStatus(withStatus(listOf("4.1-5012", "running"), "dbid_2", "paused"), "dbid_1", "paused"),
    });
    const s = await driver.poll();
    expect(s.items.map(i => [i.key, i.status])).toEqual([
      ["dbid_1", "paused"],
      ["dbid_2", "completed"],
    ]);
    expect([driver.removable("dbid_2", false), driver.removable("dbid_2", true)]).toEqual([true, false]);
    expect([driver.removable("dbid_1", false), driver.removable("dbid_1", true)]).toEqual([false, true]);
  });

  it("pauses again a task whose pause came undone within two polls, and keeps the pause for everything", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    const pauses = (): number => server.calls.filter(c => formOf(c).get("method") === "pause").length;
    expect(pauses()).toBe(1);
    // the poll right after the pause still reads it running (the program's own race, cmeans #243)
    let s = await driver.poll();
    expect(pauses()).toBe(2);
    expect(s.status.paused).toBe(true);
    expect(s.items[0].status).toBe("paused");
    // the second pause held
    state.list = withStatus(listOf("4.1-5012", "running"), "dbid_1", "paused");
    s = await driver.poll();
    expect([s.status.paused, pauses()]).toEqual([true, 2]);
    // later the user starts it in Download Station: the pause for everything ends
    state.list = undefined;
    s = await driver.poll();
    expect([s.status.paused, pauses()]).toEqual([false, 2]);
  });

  it("forgets a paused task after two polls in which it stayed paused", async () => {
    await start({ list: withStatus(listOf("4.1-5012", "running"), "dbid_1", "paused") });
    await driver.poll();
    await driver.command({ kind: "pause", key: "dbid_1" });
    await driver.poll();
    await driver.poll();
    state.list = undefined;
    await driver.poll();
    expect(server.calls.filter(c => formOf(c).get("method") === "pause")).toHaveLength(1);
  });

  it("pauses and holds a task added while the pause holds", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    state.list = withStatus(listOf("4.1-5012", "running"), "dbid_1", "paused");
    await driver.poll();
    await driver.command({ kind: "add", url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" });
    const added = { ...listOf("4.1-5012", "running").data.tasks[0], id: "dbid_3", title: "added" };
    state.list = { ...state.list, data: { ...state.list.data, tasks: [...state.list.data.tasks, added] } };
    const s = await driver.poll();
    expect(server.calls.filter(c => formOf(c).get("method") === "pause").map(c => formOf(c).get("id"))).toEqual([
      "dbid_1",
      "dbid_3",
    ]);
    expect(s.items.find(i => i.key === "dbid_3")?.status).toBe("paused");
    await driver.command({ kind: "resumeAll" });
    expect(formOf(server.calls.filter(c => formOf(c).get("method") === "resume")[0]).get("id")).toBe("dbid_1,dbid_3");
  });

  it("pauses again on the next poll when pausing a task again did not reach Download Station (K4)", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    const pauses = (): number => server.calls.filter(c => formOf(c).get("method") === "pause").length;
    state.route = (_, f) => (f.get("method") === "pause" ? { status: 503, body: "" } : undefined);
    await expect(driver.poll()).rejects.toThrow(UnreachableError);
    state.route = undefined;
    // still read running: the pause that did not arrive is tried again, the pause for everything holds
    const s = await driver.poll();
    expect(pauses()).toBe(3);
    expect(s.items[0].status).toBe("paused");
    expect(s.status.paused).toBe(true);
  });

  it("pauses and holds a task added during the pause on the next poll when the first pause did not reach it (K4)", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    state.list = withStatus(listOf("4.1-5012", "running"), "dbid_1", "paused");
    await driver.poll();
    await driver.command({ kind: "add", url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" });
    const added = { ...listOf("4.1-5012", "running").data.tasks[0], id: "dbid_3", title: "added" };
    state.list = { ...state.list, data: { ...state.list.data, tasks: [...state.list.data.tasks, added] } };
    state.route = (_, f) => (f.get("method") === "pause" ? { status: 503, body: "" } : undefined);
    await expect(driver.poll()).rejects.toThrow(UnreachableError);
    state.route = undefined;
    const s = await driver.poll();
    expect(s.items.find(i => i.key === "dbid_3")?.status).toBe("paused");
    await driver.command({ kind: "resumeAll" });
    expect(formOf(server.calls.filter(c => formOf(c).get("method") === "resume")[0]).get("id")).toBe("dbid_1,dbid_3");
  });

  it("reads a refusal with the bare code of the 2014 API guide as one with {code}", async () => {
    await start({
      route: (_, f) => (f.get("method") === "login" ? { body: { error: 400, success: false } } : undefined),
    });
    await expect(driver.poll()).rejects.toThrow(
      new AuthError("downloadstation: login rejected — no such account or wrong password"),
    );
  });

  it("refuses a no without a whole-number code, and an answer without success, as an answer that lost its shape", async () => {
    await start();
    await driver.poll();
    const shape = "Download Station's answer to SYNO.DownloadStation.Task list lost its shape — answer refused";
    state.route = (_, f) =>
      f.get("method") === "list" ? { body: { error: { code: "119" }, success: false } } : undefined;
    await expect(driver.poll()).rejects.toThrow(shape);
    state.route = (_, f) => (f.get("method") === "list" ? { body: { data: {}, success: "yes" } } : undefined);
    await expect(driver.poll()).rejects.toThrow(shape);
  });

  it("passes on a refusal that is no lost session as a protocol error, without a new login", async () => {
    await start();
    await driver.poll();
    state.route = (_, f) =>
      f.get("method") === "list" ? { body: { error: { code: 544 }, success: false } } : undefined;
    const err = await driver.poll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as Error).message).toBe("downloadstation: SYNO.DownloadStation.Task list refused — error 544");
    expect(server.calls.filter(isLogin)).toHaveLength(1);
  });

  it("calls a session refused again right after the new login a protocol error", async () => {
    await start();
    await driver.poll();
    state.refuseAll = 119;
    await expect(driver.poll()).rejects.toThrow(
      new ProtocolError("downloadstation: the new session was refused at once (error 119)"),
    );
    expect(server.calls.filter(isLogin)).toHaveLength(2);
  });

  it("passes on a refusal of the call repeated after the new login as a protocol error", async () => {
    await start();
    await driver.poll();
    const codes = [119, 544];
    state.route = (_, f) =>
      f.get("method") === "list" && codes.length
        ? { body: { error: { code: codes.shift() }, success: false } }
        : undefined;
    const err = await driver.poll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as Error).message).toBe("downloadstation: SYNO.DownloadStation.Task list refused — error 544");
    expect(server.calls.filter(isLogin)).toHaveLength(2);
  });

  it("passes on a login refused with a code outside the login codes as a protocol error", async () => {
    await start({
      route: (_, f) => (f.get("method") === "login" ? { body: { error: { code: 101 }, success: false } } : undefined),
    });
    const err = await driver.poll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err).not.toBeInstanceOf(AuthError);
    expect((err as Error).message).toBe("downloadstation: SYNO.API.Auth login refused — error 101");
  });

  it("refuses a login answer without a session id", async () => {
    await start({ route: (_, f) => (f.get("method") === "login" ? { body: { data: {}, success: true } } : undefined) });
    await expect(driver.poll()).rejects.toThrow("Download Station's login without a session id — answer refused");
  });

  it("names what the API list or a call answered when it is no answer of Download Station", async () => {
    await start({ route: call => (call.path === "/webapi/query.cgi" ? { status: 500, body: "" } : undefined) });
    await expect(driver.poll()).rejects.toThrow("downloadstation: the API list answered HTTP 500");
    state.route = call =>
      call.path === "/webapi/query.cgi" ? { body: { error: { code: 102 }, success: false } } : undefined;
    const err = await driver.poll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as Error).message).toBe("downloadstation: SYNO.API.Info query refused — error 102");
    state.route = (_, f) => (f.get("method") === "list" ? { status: 500, body: "" } : undefined);
    await expect(driver.poll()).rejects.toThrow("downloadstation: SYNO.DownloadStation.Task list answered HTTP 500");
  });

  it("refuses an answer to a pause that is no list of ids and codes", async () => {
    await start();
    await driver.poll();
    state.route = (_, f) => (f.get("method") === "pause" ? { body: { success: true } } : undefined);
    await expect(driver.command({ kind: "pause", key: "dbid_1" })).rejects.toThrow(
      "Download Station's answer to pause is no list — answer refused",
    );
    state.route = (_, f) =>
      f.get("method") === "pause" ? { body: { data: [{ error: "0", id: "dbid_1" }], success: true } } : undefined;
    await expect(driver.command({ kind: "pause", key: "dbid_1" })).rejects.toThrow(
      "an entry of Download Station's answer to pause lost its shape — answer refused",
    );
  });

  it("leaves a task added during the pause running when the pause ended before it was listed", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    state.list = withStatus(listOf("4.1-5012", "running"), "dbid_1", "paused");
    await driver.poll();
    await driver.command({ kind: "add", url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" });
    await driver.command({ kind: "resumeAll" });
    const running = listOf("4.1-5012", "running");
    const added = { ...running.data.tasks[0], id: "dbid_3", title: "added" };
    state.list = { ...running, data: { ...running.data, tasks: [...running.data.tasks, added] } };
    const s = await driver.poll();
    expect(server.calls.filter(c => formOf(c).get("method") === "pause").map(c => formOf(c).get("id"))).toEqual([
      "dbid_1",
    ]);
    expect(s.items.find(i => i.key === "dbid_3")?.status).toBe("downloading");
  });

  it("holds the first task that comes new after an add made before the first poll, and asks nothing before", async () => {
    await start();
    await driver.close();
    driver = new DsDriver(cfg(server.baseUrl), {
      ...timers,
      log,
      pauseStore: memoryPauseStore({ paused: true, keys: [] }),
    });
    await driver.command({ kind: "add", url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" });
    // the first poll cannot tell a new task from an old one, the second lists none that is new
    expect((await driver.poll()).complete).toBe(true);
    await driver.poll();
    const running = listOf("4.1-5012", "running");
    const added = { ...running.data.tasks[0], id: "dbid_3", title: "added" };
    state.list = { ...running, data: { ...running.data, tasks: [...running.data.tasks, added] } };
    const s = await driver.poll();
    expect(server.calls.filter(c => formOf(c).get("method") === "pause").map(c => formOf(c).get("id"))).toEqual([
      "dbid_3",
    ]);
    expect(s.items.find(i => i.key === "dbid_3")?.status).toBe("paused");
  });
});
