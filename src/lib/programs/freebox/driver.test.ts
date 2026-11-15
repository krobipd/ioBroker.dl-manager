import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer, type FixtureAnswer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import { AuthError, ProtocolError, UnreachableError } from "../../core/errors";
import { HttpClient } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { APP_ID, pairFreebox, sessionPassword, versionUrl } from "./client";
import { FbxDriver } from "./driver";
import { mapFbxStatus, statusTable } from "./map";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };

/** The app token the fixture server accepts — free-go's test token (client/suite_test.go L20). */
const TOKEN = "xXXyyX9999wwwwwwwwxxx99999XXYYYYYYWWW000000000999999XXXXX9999Yx";
/** Challenge and session token of the fixtures (placeholders of the captures). */
const CHALLENGE = "REDACTED_CHALLENGE_A";
const SESSION = "REDACTED_SESSION_TOKEN_A";
const V = "v8";
const API = "/api/v8/";

const endpoint = (base: string): { host: string; port: number; https: boolean; path: string } => {
  const u = new URL(base);
  return { host: u.hostname, port: Number(u.port), https: false, path: "" };
};

const cfg = (base: string, apiKey = TOKEN): ProgramConfig => ({
  type: "freebox",
  deviceId: "",
  name: "",
  ...endpoint(base),
  username: "",
  password: "",
  apiKey,
  device: "",
});

/**
 * @param state state folder
 * @param name file name
 * @returns the answer as the fixture server sends it
 */
const answer = (state: string, name: string): FixtureAnswer => {
  const f = loadFixture("freebox", V, state, name);
  return { status: f.status, body: f.body };
};

/** A list as the fixtures hold it. */
interface List {
  success: boolean;
  result?: Record<string, unknown>[];
}

/**
 * @param name the list's fixture
 * @returns a copy to change in a test
 */
const list = (name = "list"): List => structuredClone(loadFixture("freebox", V, "queue", name).body) as List;

/** @returns a copy of the fixture config's `result` */
const config = (): Record<string, unknown> =>
  structuredClone((loadFixture("freebox", V, "config", "get").body as { result: Record<string, unknown> }).result);

/** What the fixture server answers; the test changes it between calls. */
interface FbxState {
  /** The answer to `GET downloads/` instead of the fixture list. */
  list?: unknown;
  /** The session's app lacks the right to the downloads. */
  noDownloader?: boolean;
  /** Every call with a session answers 403 `auth_required` — also on a session just opened. */
  refuseAll?: boolean;
  /** These tasks refuse `stopped` with `task_not_found`. */
  refuseStop?: string[];
  /** A `PUT downloads/config/` answers 403 `insufficient_rights`. */
  noSettings?: boolean;
  /** The answer to `downloads/add` instead of the fixture's. */
  added?: unknown;
  /** The answer to `GET downloads/config/` instead of the config. */
  configAnswer?: unknown;
  /** The statuses `GET login/authorize/42` answers in turn, the last one for ever. */
  track?: string[];
}

/**
 * The Freebox from the fixtures: `api_version`, a challenge, a session that checks the documented HMAC over the
 * challenge keyed with `TOKEN`, every other call only with the session in `X-Fbx-App-Auth`, routed by its path.
 * `PUT downloads/{id}` changes the task's status in the list, `PUT downloads/config/` the config.
 *
 * @param state the answers, read at every request
 * @returns the running server
 */
async function fbxServer(state: FbxState = {}): Promise<ContractServer> {
  let lapse = false;
  const statusNow = new Map<string, string>();
  const current = config();
  let track = 0;
  const s = await startFixtureServer(call => {
    if (call.method === "GET" && call.path === "/api_version") {
      return answer("app", "api-version");
    }
    const resource = call.path.startsWith(API) ? call.path.slice(API.length) : null;
    if (resource === null) {
      return { status: 404, body: "Not Found" };
    }
    if (call.method === "GET" && resource === "login/") {
      return answer("auth", "challenge");
    }
    if (call.method === "POST" && resource === "login/session/") {
      const sent = JSON.parse(call.body) as { app_id?: string; password?: string };
      if (sent.app_id !== APP_ID || sent.password !== sessionPassword(TOKEN, CHALLENGE)) {
        return answer("auth", "invalid-token");
      }
      return state.noDownloader ? answer("auth", "session-no-downloader") : answer("auth", "session");
    }
    if (call.method === "POST" && resource === "login/authorize/") {
      return answer("pairing", "authorize");
    }
    if (call.method === "GET" && resource === "login/authorize/42") {
      const statuses = state.track ?? ["granted"];
      const status = statuses[Math.min(track++, statuses.length - 1)];
      return { body: { success: true, result: { status, challenge: "Bj6xMqoe+DCHD44KqBljJ579seOXNWr2" } } };
    }
    if (call.headers["x-fbx-app-auth"] !== SESSION || state.refuseAll) {
      return answer("auth", "auth-required");
    }
    if (lapse) {
      lapse = false;
      return answer("auth", "auth-required");
    }
    const task = /^downloads\/(\d+)$/.exec(resource);
    if (task && call.method === "PUT") {
      const status = (JSON.parse(call.body) as { status?: string }).status ?? "";
      if (status === "stopped" && state.refuseStop?.includes(task[1])) {
        return answer("commands", "task-not-found");
      }
      statusNow.set(task[1], status);
      return answer("commands", "put");
    }
    if (task && call.method === "DELETE") {
      return answer("commands", "delete");
    }
    switch (`${call.method} ${resource}`) {
      case "GET downloads/": {
        if (state.list !== undefined) {
          return { body: state.list };
        }
        const l = list();
        return {
          body: { ...l, result: l.result?.map(t => ({ ...t, status: statusNow.get(String(t.id)) ?? t.status })) },
        };
      }
      case "GET downloads/config/":
        return { body: state.configAnswer ?? { success: true, result: current } };
      case "PUT downloads/config/": {
        if (state.noSettings) {
          return {
            status: 403,
            body: { success: false, error_code: "insufficient_rights", msg: "Accès refusé" },
          };
        }
        Object.assign(current, JSON.parse(call.body));
        return { body: { success: true, result: current } };
      }
      case "POST downloads/add":
        return state.added === undefined ? answer("commands", "add") : { body: state.added };
      default:
        return { status: 404, body: { success: false, error_code: "invalid_request" } };
    }
  });
  return {
    ...s,
    expireSession: () => {
      lapse = true;
    },
  };
}

const isLogin = (call: RecordedCall): boolean => call.method === "POST" && call.path === `${API}login/session/`;

runDriverContract({
  type: "freebox",
  server: () => fbxServer(),
  makeDriver: (base, creds) => new FbxDriver(cfg(base, creds.good ? TOKEN : "wrong"), { ...timers, log }),
  mapStatus: mapFbxStatus,
  statusTable,
  unknownStatus: "verifying",
  commandCalls: {
    pauseAll: { method: "PUT", path: `${API}downloads/341`, bodyContains: '"status":"stopped"' },
    resumeAll: { method: "PUT", path: `${API}downloads/341`, bodyContains: '"status":"downloading"' },
    pause: { method: "PUT", path: `${API}downloads/341`, bodyContains: '"status":"stopped"' },
    resume: { method: "PUT", path: `${API}downloads/341`, bodyContains: '"status":"downloading"' },
    remove: { method: "DELETE", path: `${API}downloads/341` },
    add: { method: "POST", path: `${API}downloads/add`, bodyContains: "download_url=magnet" },
    setSpeedLimit: { method: "PUT", path: `${API}downloads/config/`, bodyContains: '"rx_rate":2000000' },
    setUploadLimit: { method: "PUT", path: `${API}downloads/config/`, bodyContains: '"tx_rate":2000000' },
  },
  isLoginCall: isLogin,
});

describe("Freebox session password", () => {
  it("gives free-go's test vector (HMAC-SHA1 of the challenge keyed with the app token, hex)", () => {
    expect(sessionPassword(TOKEN, "9Va31tSgQWM853j0kSCtBUyzYNhPN7IY")).toBe("c3464d210c1be4f1ef6f34c578d463fc28d40a61");
  });
});

describe("Freebox api_version URL", () => {
  it("sits beside api/ on the box and below a proxy's path", () => {
    expect(versionUrl("https://mafreebox.freebox.fr:443/api/v8/")).toBe("https://mafreebox.freebox.fr:443/api_version");
    expect(versionUrl("https://proxy.example:8443/fbx/api/v8/")).toBe("https://proxy.example:8443/fbx/api_version");
  });
});

describe("Freebox driver", () => {
  let server: ContractServer;
  let state: FbxState;
  let driver: FbxDriver;
  const start = async (over: FbxState = {}, apiKey = TOKEN): Promise<void> => {
    state = { ...over };
    server = await fbxServer(state);
    driver = new FbxDriver(cfg(server.baseUrl, apiKey), { ...timers, log, pauseStore: memoryPauseStore() });
  };
  const made = (from = 0): string[] => server.calls.slice(from).map(c => `${c.method} ${c.path}`);
  afterEach(async () => {
    vi.restoreAllMocks();
    await driver.close();
    await server.close();
  });

  it("reads the list of a running Freebox: share loaded, rates, ratio, time left, sums and the normal limits", async () => {
    await start();
    const s = await driver.poll();
    expect(s.status).toEqual({
      version: "16.0",
      paused: false,
      downloadBps: 104_230_000,
      uploadBps: 132_600,
      speedLimitBps: 0,
      uploadLimitBps: 0,
    });
    expect(s.items).toHaveLength(24);
    expect(s.items.filter(i => i.status === "seeding")).toHaveLength(23);
    const loading = s.items.find(i => i.key === "365");
    // rx_pct 774 of 10000 of 3.3 GB; `eta` counts while it loads
    expect(loading).toMatchObject({
      name: "REDACTED-release-24",
      status: "downloading",
      sizeBytes: 3_300_000_000,
      doneBytes: 255_420_000,
      speedBps: 104_230_000,
      uploadBps: 132_600,
      etaSeconds: 29,
      addedMs: 1_787_668_802_000,
      error: "",
    });
    const first = list().result?.[0] ?? {};
    // a seeding torrent's ratio is what went up over its size, its `eta` (to the seed ratio) is no time left
    expect(s.items[0].ratio).toBeCloseTo(Number(first.tx_bytes) / Number(first.size));
    expect(s.items[0].etaSeconds).toBeNull();
  });

  it("maps every status a Freebox lists, per type, and names the error code of a failed task", async () => {
    await start({ list: list("list-states") });
    const s = await driver.poll();
    expect(s.items.map(i => [i.key, i.status, i.error, i.etaSeconds])).toEqual([
      ["501", "completed", "", null],
      ["502", "failed", "unknown_host", null],
      ["503", "postprocessing", "", null],
      ["504", "postprocessing", "", null],
      ["505", "postprocessing", "", null],
      ["506", "checking", "", null],
      ["507", "paused", "", null],
      ["508", "queued", "", null],
      ["509", "queued", "", null],
      ["510", "downloading", "", 1000],
      ["511", "failed", "nzb_missing_segments", null],
    ]);
    // only a torrent is shared
    expect(s.items.filter(i => i.ratio !== null).map(i => i.key)).toEqual(["506", "507"]);
  });

  it("reads a torrent's data check as checking and a stopped task as paused, as a running Freebox lists them", async () => {
    await start({ list: list("list-checking") });
    expect((await driver.poll()).items.map(i => i.status)).toEqual([
      "downloading",
      "downloading",
      "checking",
      "checking",
      "checking",
      "checking",
      "downloading",
      "seeding",
    ]);
    state.list = list("list-stopped");
    expect((await driver.poll()).items.map(i => i.status)).toEqual([
      "paused",
      "paused",
      "paused",
      "paused",
      "paused",
      "paused",
      "downloading",
      "downloading",
    ]);
  });

  it("reads an empty list as a running Freebox sends it — without result", async () => {
    await start({ list: list("list-empty") });
    expect((await driver.poll()).items).toEqual([]);
  });

  it("refuses a list that is null or an object, instead of reading it as empty", async () => {
    await start({ list: { success: true, result: null } });
    await expect(driver.poll()).rejects.toThrow(ProtocolError);
    // the documentation's own example writes the list as an object
    state.list = { success: true, result: { id: 1 } };
    await expect(driver.poll()).rejects.toThrow(/no list/);
    state.list = { result: [] };
    await expect(driver.poll()).rejects.toThrow(/lost its shape/);
  });

  it("opens the session with the HMAC of the challenge; the app token never travels, the session goes along", async () => {
    await start();
    await driver.poll();
    expect(made()).toEqual([
      "GET /api_version",
      `GET ${API}login/`,
      `POST ${API}login/session/`,
      `GET ${API}downloads/`,
      `GET ${API}downloads/config/`,
    ]);
    expect(JSON.parse(server.calls[2].body)).toEqual({ app_id: APP_ID, password: sessionPassword(TOKEN, CHALLENGE) });
    expect(server.calls.every(c => !c.body.includes(TOKEN) && !JSON.stringify(c.headers).includes(TOKEN))).toBe(true);
    expect(server.calls.slice(3).every(c => c.headers["x-fbx-app-auth"] === SESSION)).toBe(true);
    // the version is read once, the session holds
    await driver.poll();
    expect(made(5)).toEqual([`GET ${API}downloads/`, `GET ${API}downloads/config/`]);
  });

  it("opens the next session with the challenge of the refusal, without asking login/ again", async () => {
    await start();
    await driver.poll();
    server.expireSession?.();
    const from = server.calls.length;
    expect((await driver.poll()).complete).toBe(true);
    expect(made(from)).toEqual([
      `GET ${API}downloads/`,
      `POST ${API}login/session/`,
      `GET ${API}downloads/`,
      `GET ${API}downloads/config/`,
    ]);
  });

  it("refuses a session the Freebox rejects right after it opened it, without opening another", async () => {
    await start({ refuseAll: true });
    await expect(driver.poll()).rejects.toThrow(/refused at once/);
    expect(server.calls.filter(isLogin)).toHaveLength(1);
  });

  it("gives up on an app token the Freebox no longer knows, with the way back", async () => {
    await start({}, "revoked");
    await expect(driver.poll()).rejects.toThrow(AuthError);
    await expect(driver.poll()).rejects.toThrow(/pair the card with the Freebox again/);
  });

  it("refuses a session without the right to the downloads like a rejected login, naming where to grant it", async () => {
    await start({ noDownloader: true });
    const err = await driver.poll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(String(err)).toMatch(/right to the downloads.*Gestion des accès/);
  });

  it("fails a limit the app may not write with the way to grant it, and polls on", async () => {
    await start({ noSettings: true });
    await driver.poll();
    await expect(driver.command({ kind: "setSpeedLimit", bps: 1000 })).rejects.toThrow(
      /needs a right the app lacks.*Gestion des accès/,
    );
    expect((await driver.poll()).complete).toBe(true);
  });

  it("names the host that fits when the certificate holds for mafreebox.freebox.fr only", async () => {
    await start();
    vi.spyOn(HttpClient.prototype, "request").mockRejectedValue(
      new UnreachableError(
        "Hostname/IP does not match certificate's altnames: IP: 192.168.1.254 is not in the cert's list: ",
      ),
    );
    const err = await driver.poll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect(String(err)).toMatch(/enter mafreebox\.freebox\.fr as host, or switch HTTPS off/);
  });

  it("pauses everything by stopping what runs, and resumes exactly that", async () => {
    await start({ list: list("list-stopped") });
    await driver.poll();
    const from = server.calls.length;
    await driver.command({ kind: "pauseAll" });
    // 417–422 the user stopped himself
    expect(made(from)).toEqual([`GET ${API}downloads/`, `PUT ${API}downloads/423`, `PUT ${API}downloads/424`]);
    expect(server.calls.slice(from + 1).map(c => c.body)).toEqual(['{"status":"stopped"}', '{"status":"stopped"}']);
    const back = server.calls.length;
    await driver.command({ kind: "resumeAll" });
    expect(made(back).filter(c => c.startsWith("PUT"))).toEqual([`PUT ${API}downloads/423`, `PUT ${API}downloads/424`]);
    expect(server.calls.at(-1)?.body).toBe('{"status":"downloading"}');
  });

  it("stops a torrent in its data check too — it would load right after", async () => {
    await start({ list: list("list-checking") });
    await driver.poll();
    const from = server.calls.length;
    await driver.command({ kind: "pauseAll" });
    expect(made(from).filter(c => c.startsWith("PUT"))).toEqual(
      ["417", "418", "419", "420", "421", "422", "423", "424"].map(id => `PUT ${API}downloads/${id}`),
    );
  });

  it("shows the pause it holds, and pauses on when a task refuses the stop", async () => {
    await start({ refuseStop: ["342"] });
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    const s = await driver.poll();
    expect(s.status.paused).toBe(true);
    expect(s.items.find(i => i.key === "342")?.status).toBe("seeding");
    expect(s.items.find(i => i.key === "341")?.status).toBe("paused");
    const back = server.calls.length;
    await driver.command({ kind: "resumeAll" });
    const resumed = made(back).filter(c => c.startsWith("PUT"));
    expect(resumed).toHaveLength(23);
    expect(resumed).not.toContain(`PUT ${API}downloads/342`);
  });

  it("stops and holds a link added during the pause, by the id the Freebox names for it", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "pauseAll" });
    const from = server.calls.length;
    await driver.command({ kind: "add", url: "https://example.com/a.torrent" });
    expect(made(from)).toEqual([`POST ${API}downloads/add`, `PUT ${API}downloads/365`]);
    expect(server.calls[from].body).toBe("download_url=https%3A%2F%2Fexample.com%2Fa.torrent");
    expect(server.calls[from].headers["content-type"]).toContain("application/x-www-form-urlencoded");
    const back = server.calls.length;
    await driver.command({ kind: "resumeAll" });
    expect(made(back)).toContain(`PUT ${API}downloads/365`);
  });

  it("leaves a link added while nothing is paused running, and refuses an answer without the new id", async () => {
    await start();
    await driver.poll();
    const from = server.calls.length;
    await driver.command({ kind: "add", url: "magnet:?xt=urn:btih:abc" });
    expect(made(from)).toEqual([`POST ${API}downloads/add`]);
    state.added = { success: true, result: {} };
    await expect(driver.command({ kind: "add", url: "magnet:?xt=urn:btih:abc" })).rejects.toThrow(ProtocolError);
  });

  it("sends only the throttling back, as read with the one rate changed", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "setSpeedLimit", bps: 2_000_000.4 });
    const sent = JSON.parse(server.calls.at(-1)?.body ?? "") as Record<string, unknown>;
    const throttling = config().throttling as Record<string, unknown>;
    expect(sent).toEqual({ throttling: { ...throttling, normal: { rx_rate: 2_000_000, tx_rate: 0 } } });
    expect((await driver.poll()).status.speedLimitBps).toBe(2_000_000);
    await driver.command({ kind: "setUploadLimit", bps: 50_000 });
    await driver.command({ kind: "setSpeedLimit", bps: 0 });
    expect(JSON.parse(server.calls.at(-1)?.body ?? "")).toMatchObject({
      throttling: { normal: { rx_rate: 0, tx_rate: 50_000 } },
    });
    const s = await driver.poll();
    expect([s.status.speedLimitBps, s.status.uploadLimitBps]).toEqual([0, 50_000]);
  });

  it("refuses a config answer without the config instead of reading no limits", async () => {
    await start({ configAnswer: { success: true } });
    await expect(driver.poll()).rejects.toThrow(/download config is no object/);
  });

  it("removes with DELETE, which keeps the files, and refuses a key that is no task id", async () => {
    await start();
    await driver.poll();
    await driver.command({ kind: "remove", key: "365" });
    expect(made(server.calls.length - 1)).toEqual([`DELETE ${API}downloads/365`]);
    const from = server.calls.length;
    await expect(driver.command({ kind: "pause", key: "../config" })).rejects.toThrow(ProtocolError);
    expect(server.calls.length).toBe(from);
    expect(server.calls.some(c => c.path.endsWith("/erase"))).toBe(false);
  });
});

describe("Freebox pairing", () => {
  let server: ContractServer;
  afterEach(async () => {
    await server.close();
  });
  const app = { name: "ioBroker dl-manager", version: "0.5.0", device: "iobroker-host" };
  const quick = { everyMs: 1, maxMs: 50 };

  it("asks for an app token and hands it over once the user granted it on the Freebox", async () => {
    server = await fbxServer({ track: ["pending", "pending", "granted"] });
    const out = await pairFreebox(endpoint(server.baseUrl), timers, app, quick);
    expect(out).toEqual({ token: "dyNYgfK0Ya6FWGqq83sBHa7TwzWo+pg4fDFUJHShcjVYzTfaRrZzm93p7OTAfH/0" });
    expect(JSON.parse(server.calls[0].body)).toEqual({
      app_id: APP_ID,
      app_name: "ioBroker dl-manager",
      app_version: "0.5.0",
      device_name: "iobroker-host",
    });
    expect(server.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      `POST ${API}login/authorize/`,
      `GET ${API}login/authorize/42`,
      `GET ${API}login/authorize/42`,
      `GET ${API}login/authorize/42`,
    ]);
  });

  it("hands over no token when the user refused it, the request lapsed or the Freebox forgot it", async () => {
    for (const status of ["denied", "timeout", "unknown"]) {
      server = await fbxServer({ track: ["pending", status] });
      expect(await pairFreebox(endpoint(server.baseUrl), timers, app, quick)).toEqual({ refused: status });
      await server.close();
    }
    server = await fbxServer();
  });

  it("stops waiting after its longest wait", async () => {
    server = await fbxServer({ track: ["pending"] });
    expect(await pairFreebox(endpoint(server.baseUrl), timers, app, { everyMs: 1, maxMs: 3 })).toEqual({
      refused: "timeout",
    });
    expect(server.calls.filter(c => c.method === "GET")).toHaveLength(4);
  });

  it("ends the wait when the adapter stops, and refuses a status no documentation names", async () => {
    server = await fbxServer({ track: ["pending"] });
    const stopping = { ...timers, setTimeout: (): ioBroker.Timeout | undefined => undefined };
    await expect(pairFreebox(endpoint(server.baseUrl), stopping, app, quick)).rejects.toThrow(UnreachableError);
    await server.close();
    server = await fbxServer({ track: ["waiting"] });
    await expect(pairFreebox(endpoint(server.baseUrl), timers, app, quick)).rejects.toThrow(/answered "waiting"/);
  });
});
