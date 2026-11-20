import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer, type FixtureAnswer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import { AuthError, ProtocolError, UnreachableError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { FloodDriver } from "./driver";
import { behindDeluge, mapFloodStatus, statusTable } from "./map";

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
    type: "flood",
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
 * @param version recorded version
 * @param state state folder
 * @param name file name
 * @returns the recording as the fixture server's answer, without its masked cookie
 */
const recorded = (version: string, state: string, name: string): FixtureAnswer => {
  const f = loadFixture("flood", version, state, name);
  const headers = Object.fromEntries(Object.entries(f.headers ?? {}).filter(([k]) => k !== "set-cookie"));
  return { status: f.status, body: f.body, headers };
};

/**
 * @param version recorded version
 * @param state state folder
 * @returns the recorded hashes by torrent name
 */
const hashes = (version: string, state: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(
      (loadFixture("flood", version, state, "torrents").body as { torrents: Record<string, { name: string }> })
        .torrents,
    ).map(([h, t]) => [t.name, h]),
  );

/** What the recorded Flood answers; the test changes it between calls. */
interface FloodState {
  /** State folder of `GET /api/torrents`. */
  torrents: string;
  /** State folder of `GET /api/client/settings`, default the one of the torrents. */
  settings?: string;
  /** The answer of `GET /api/client/settings` in place of the recorded one. */
  settingsAnswer?: FixtureAnswer;
  /** The answer of `POST /api/torrents/add-urls`, default the recorded add stopped by URL. */
  add?: FixtureAnswer;
  /** The answer of `PATCH /api/client/settings`, default the recorded limits. */
  patch?: FixtureAnswer;
  /** `GET /api/torrents` fails as a proxy in front of a Flood that does not run. */
  down?: boolean;
}

/**
 * Flood from the recordings: the session in the cookie jwt, reads by route, a stop, start or delete naming a hash the
 * list does not carry answered as the recorded backend answers an unknown one.
 *
 * @param version recorded version
 * @param state the answers, read at every request
 * @returns the running server
 */
async function floodServer(version: string, state: FloodState): Promise<ContractServer> {
  let expire = false;
  const s = await startFixtureServer(call => {
    if (call.path === "/api/auth/authenticate") {
      const creds = JSON.parse(call.body) as { username?: string; password?: string };
      return creds.username === "admin" && creds.password === "good"
        ? { ...recorded(version, "auth", "authenticate-ok"), headers: { "set-cookie": "jwt=abc; Path=/; HttpOnly" } }
        : recorded(version, "auth", "authenticate-wrong");
    }
    if (call.headers.cookie !== "jwt=abc" || expire) {
      expire = false;
      return recorded(version, "auth", "torrents-no-cookie");
    }
    switch (`${call.method} ${call.path}`) {
      case "GET /api/openapi.json":
        return recorded(version, "auth", "openapi");
      case "GET /api/torrents":
        return state.down ? { status: 503, body: "" } : recorded(version, state.torrents, "torrents");
      case "GET /api/client/settings":
        return state.settingsAnswer ?? recorded(version, state.settings ?? state.torrents, "settings");
      case "PATCH /api/client/settings":
        return state.patch ?? recorded(version, "commands", "settings-limits");
      case "POST /api/torrents/add-urls":
        return state.add ?? recorded(version, "commands", "add-urls-stopped");
      case "POST /api/torrents/stop":
      case "POST /api/torrents/start":
      case "POST /api/torrents/delete": {
        const listed = new Set(Object.values(hashes(version, state.torrents)));
        const all = (JSON.parse(call.body) as { hashes: string[] }).hashes.every(h => listed.has(h));
        return recorded(version, "commands", all ? "stop" : "stop-mixed");
      }
      default:
        return { status: 404, body: "" };
    }
  });
  return {
    ...s,
    expireSession: () => {
      expire = true;
    },
  };
}

const isLogin = (call: RecordedCall): boolean => call.path === "/api/auth/authenticate";

/** The first torrent of the qBittorrent `added-stopped` recording — the contract pauses it. */
const FIRST = Object.keys(
  (loadFixture("flood", "4.16.4-qbittorrent", "added-stopped", "torrents").body as { torrents: object }).torrents,
)[0];

runDriverContract({
  type: "flood",
  server: () => floodServer("4.16.4-qbittorrent", { torrents: "added-stopped" }),
  makeDriver: (base, creds) => new FloodDriver(cfg(base, creds.good ? "good" : "wrong"), { ...timers, log }),
  mapStatus: mapFloodStatus,
  statusTable,
  unknownStatus: "warning",
  commandCalls: {
    pauseAll: { method: "POST", path: "/api/torrents/stop", bodyContains: '{"hashes":["' },
    resumeAll: { method: "POST", path: "/api/torrents/start", bodyContains: '{"hashes":["' },
    pause: { method: "POST", path: "/api/torrents/stop", bodyContains: `{"hashes":["${FIRST}"]}` },
    resume: { method: "POST", path: "/api/torrents/start", bodyContains: `{"hashes":["${FIRST}"]}` },
    remove: { method: "POST", path: "/api/torrents/delete", bodyContains: `"deleteData":false` },
    add: { method: "POST", path: "/api/torrents/add-urls", bodyContains: '"start":true' },
    setSpeedLimit: { method: "PATCH", path: "/api/client/settings", bodyContains: '"throttleGlobalDownSpeed":2000000' },
    setUploadLimit: { method: "PATCH", path: "/api/client/settings", bodyContains: '"throttleGlobalUpSpeed":2000000' },
  },
  removeWithFiles: { method: "POST", path: "/api/torrents/delete", bodyContains: '"deleteData":true' },
  isLoginCall: isLogin,
});

/**
 * @param s the server
 * @param s.calls the requests it saw
 * @param path the route
 * @returns the hash lists sent to that route
 */
const sent = (s: { calls: RecordedCall[] }, path: string): string[][] =>
  s.calls.filter(c => c.path === path).map(c => (JSON.parse(c.body) as { hashes: string[] }).hashes);

describe("Flood driver — version", () => {
  it("reads 4.16's version from its OpenAPI document once", async () => {
    const s = await floodServer("4.16.4-qbittorrent", { torrents: "running" });
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log });
      expect((await d.poll()).status.version).toBe("4.16.4");
      await d.poll();
      expect(s.calls.filter(c => c.path === "/api/openapi.json")).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it("asks 4.11, which has no document, once until a poll fails", async () => {
    const state: FloodState = { torrents: "running" };
    const s = await floodServer("4.11.0-transmission", state);
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log });
      for (let i = 0; i < 3; i++) {
        expect((await d.poll()).status.version).toBe("");
      }
      expect(s.calls.filter(c => c.path === "/api/openapi.json")).toHaveLength(1);
      state.down = true;
      await expect(d.poll()).rejects.toThrow();
      state.down = false;
      await d.poll();
      expect(s.calls.filter(c => c.path === "/api/openapi.json")).toHaveLength(2);
    } finally {
      await s.close();
    }
  });
});

describe("Flood driver — limits", () => {
  it("keeps the torrents when Flood refuses the settings (4.11 in front of rTorrent 0.16), and leaves the limits as they are", async () => {
    const s = await floodServer("4.11.0-rtorrent", { torrents: "empty" });
    try {
      expect(loadFixture("flood", "4.11.0-rtorrent", "empty", "settings").status).toBe(500);
      const snap = await new FloodDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      // a refused part is no "unlimited" and no "none": the datapoints keep what they hold (fleet D6 on a 500)
      expect([snap.complete, snap.status.speedLimitBps, snap.status.uploadLimitBps]).toEqual([
        true,
        undefined,
        undefined,
      ]);
    } finally {
      await s.close();
    }
  });

  it("refuses settings that lost a field it reads — read as none they empty both limits, written back they break the backend (fleet C26b)", async () => {
    const good = loadFixture("flood", "4.16.4-deluge", "limited", "settings").body as Record<string, unknown>;
    // the two limits and the two values that tell Deluge behind Flood, each the way the fleet suite drifts it
    const fields = ["throttleGlobalDownSpeed", "throttleGlobalUpSpeed", "networkMaxOpenFiles", "piecesMemoryMax"];
    const cases = fields.flatMap(key => [
      Object.fromEntries(Object.entries(good).filter(([k]) => k !== key)),
      { ...good, [key]: null },
      { ...good, [key]: String(good[key]) },
    ]);
    for (const body of cases) {
      const s = await floodServer("4.16.4-deluge", { torrents: "limited", settingsAnswer: { body } });
      try {
        const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log });
        await expect(d.poll()).rejects.toThrow(ProtocolError);
        await expect(d.command({ kind: "setSpeedLimit", bps: 2_000_000 })).rejects.toThrow(ProtocolError);
        expect(s.calls.filter(c => c.method === "PATCH")).toEqual([]);
      } finally {
        await s.close();
      }
    }
  });

  it("writes the whole settings object with one limit changed — a part breaks Deluge and Transmission", async () => {
    // the recorded proof: after a part, Deluge answers every settings read with 500, Transmission's seed queue is on
    expect(loadFixture("flood", "4.16.4-deluge", "partial", "settings").status).toBe(500);
    const before = loadFixture("flood", "4.16.4-transmission", "unlimited", "settings").body as Record<string, unknown>;
    expect([
      before.throttleMaxUploadsGlobal,
      (loadFixture("flood", "4.16.4-transmission", "partial", "settings").body as Record<string, unknown>)
        .throttleMaxUploadsGlobal,
    ]).toEqual([0, 10]);
    for (const [version, down, off] of [
      // Deluge behind Flood keeps KiB/s, -1 = off (its gateway passes the value on unchanged)
      ["4.16.4-deluge", 100, -1],
      ["4.16.4-transmission", 102400, 0],
    ] as const) {
      const settings = loadFixture("flood", version, "empty", "settings").body as Record<string, unknown>;
      const s = await floodServer(version, { torrents: "empty" });
      try {
        const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log });
        await d.command({ kind: "setSpeedLimit", bps: 102400 });
        await d.command({ kind: "setUploadLimit", bps: -5 });
        const patches = s.calls
          .filter(c => c.method === "PATCH")
          .map(c => JSON.parse(c.body) as Record<string, unknown>);
        expect(patches, version).toEqual([
          { ...settings, throttleGlobalDownSpeed: down },
          { ...settings, throttleGlobalUpSpeed: off },
        ]);
      } finally {
        await s.close();
      }
    }
  });

  it("knows Deluge behind Flood from the settings its gateway fixes, and reads its KiB/s as bytes per second", async () => {
    const root = join(__dirname, "../../../../test/fixtures/flood");
    const read = readdirSync(root).flatMap(version =>
      readdirSync(join(root, version))
        .filter(state => existsSync(join(root, version, state, "settings.json")))
        .map(state => [version, state, loadFixture("flood", version, state, "settings")] as const)
        .filter(([, , f]) => f.status === 200),
    );
    // every backend recorded, and only the Deluge recordings are taken for Deluge
    expect(new Set(read.map(([v]) => v.replace(/^[\d.]+-/, "")))).toEqual(
      new Set(["deluge", "qbittorrent", "rtorrent", "transmission"]),
    );
    for (const [version, state, f] of read) {
      expect(behindDeluge(f.body as Record<string, unknown>), `${version}/${state}`).toBe(version.endsWith("-deluge"));
    }
    // the same limits written through Flood (recordings `throttled`: 102400 down, 51200 up)
    for (const [version, down, up] of [
      ["4.16.4-deluge", 102400 * 1024, 51200 * 1024],
      ["4.16.4-qbittorrent", 102400, 51200],
    ] as const) {
      const s = await floodServer(version, { torrents: "throttled" });
      try {
        const snap = await new FloodDriver(cfg(s.baseUrl), { ...timers, log }).poll();
        expect([snap.status.speedLimitBps, snap.status.uploadLimitBps], version).toEqual([down, up]);
      } finally {
        await s.close();
      }
    }
  });

  it("takes rTorrent's error answer as done when the settings read back show the limit", async () => {
    // rTorrent refuses its own empty local address and takes the limits in the same call
    const refused = recorded("4.16.4-rtorrent", "commands", "settings-throttle");
    expect(refused.status).toBe(500);
    const state: FloodState = { torrents: "running", settings: "running", patch: refused };
    const s = await floodServer("4.16.4-rtorrent", state);
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log });
      // the read back still shows no limit: the error stands
      await expect(d.command({ kind: "setSpeedLimit", bps: 102400 })).rejects.toThrow(/HTTP 500 \(Tried to set local/);
      // the read back shows it (state `throttled`, written in the same way)
      let reads = 0;
      const throttled = loadFixture("flood", "4.16.4-rtorrent", "throttled", "settings").body;
      expect(throttled).toMatchObject({ throttleGlobalDownSpeed: 102400 });
      const s2 = await startFixtureServer(call => {
        if (call.path === "/api/auth/authenticate") {
          return { body: { success: true }, headers: { "set-cookie": "jwt=abc; Path=/" } };
        }
        if (call.method === "PATCH") {
          return refused;
        }
        reads++;
        return { body: reads === 1 ? loadFixture("flood", "4.16.4-rtorrent", "running", "settings").body : throttled };
      });
      try {
        await new FloodDriver(cfg(s2.baseUrl), { ...timers, log }).command({ kind: "setSpeedLimit", bps: 102400 });
        expect(reads).toBe(2);
      } finally {
        await s2.close();
      }
    } finally {
      await s.close();
    }
  });
});

describe("Flood driver — emulated pause", () => {
  it("adds stopped while paused and holds the hash Flood answers, upper case — a check is no start", async () => {
    const v = "4.16.4-qbittorrent";
    const late = hashes(v, "added-stopped")["late.bin"];
    // the recorded answer names the hash in lower case
    expect(recorded(v, "commands", "add-urls-stopped").body).toEqual([late.toLowerCase()]);
    const state: FloodState = { torrents: "running" };
    const s = await floodServer(v, state);
    const store = memoryPauseStore({ paused: true, keys: [] });
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.command({ kind: "add", url: "http://seed:8080/late.torrent" });
      expect(JSON.parse(s.calls.find(c => c.path === "/api/torrents/add-urls")?.body ?? "")).toEqual({
        urls: ["http://seed:8080/late.torrent"],
        start: false,
      });
      expect(await store.load()).toEqual({ paused: true, keys: [late] });
      const paused: boolean[] = [];
      // qBittorrent lists it `checking` first, then stopped; started by the user it downloads
      for (const st of ["added-stopped", "all-stopped", "resumed"]) {
        state.torrents = st;
        paused.push((await d.poll()).status.paused);
      }
      expect(paused).toEqual([true, true, false]);
    } finally {
      await s.close();
    }
  });

  it("holds the next new stopped torrent when Flood names no hash (rTorrent)", async () => {
    const v = "4.16.4-rtorrent";
    expect(recorded(v, "commands", "add-urls-stopped")).toMatchObject({ status: 202, body: [] });
    const late = hashes(v, "added-stopped")["late.bin"];
    const state: FloodState = { torrents: "finished" };
    const s = await floodServer(v, state);
    const store = memoryPauseStore({ paused: true, keys: [] });
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      expect(hashes(v, "finished")["late.bin"]).toBeUndefined();
      await d.poll();
      await d.command({ kind: "add", url: "http://seed:8080/late.torrent" });
      state.torrents = "added-stopped";
      expect((await d.poll()).status.paused).toBe(true);
      expect(await store.load()).toEqual({ paused: true, keys: [late] });
      await d.command({ kind: "resumeAll" });
      expect(sent(s, "/api/torrents/start")).toEqual([[late]]);
    } finally {
      await s.close();
    }
  });

  it("adds started while not paused", async () => {
    const s = await floodServer("4.16.4-transmission", { torrents: "running" });
    const store = memoryPauseStore();
    try {
      await new FloodDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store }).command({
        kind: "add",
        url: "magnet:?xt=urn:btih:x",
      });
      expect(JSON.parse(s.calls.find(c => c.path === "/api/torrents/add-urls")?.body ?? "")).toMatchObject({
        start: true,
      });
      expect(await store.load()).toEqual({ paused: false, keys: [] });
    } finally {
      await s.close();
    }
  });

  it("stops what runs, never a torrent an error stopped, and resumes exactly those", async () => {
    const v = "4.16.4-rtorrent";
    const h = hashes(v, "missing");
    const s = await floodServer(v, { torrents: "missing" });
    const store = memoryPauseStore();
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      const [stopped] = sent(s, "/api/torrents/stop");
      expect(stopped).not.toContain(h["gone.bin"]);
      expect(stopped).not.toContain(h["stopped.bin"]);
      expect(stopped).toContain(h["check.bin"]);
      expect(await store.load()).toEqual({ paused: true, keys: stopped });
      await d.command({ kind: "resumeAll" });
      expect(sent(s, "/api/torrents/start")).toEqual([stopped]);
    } finally {
      await s.close();
    }
  });

  it("sends the list once more without a torrent gone since the poll — Deluge refuses it whole", async () => {
    const v = "4.16.4-deluge";
    // the recorded proof: one unknown hash in the list, and Flood answers 500
    expect(recorded(v, "commands", "stop-mixed").status).toBe(500);
    const state: FloodState = { torrents: "resumed" };
    const s = await floodServer(v, state);
    const store = memoryPauseStore();
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      // queued.bin is removed before the pause goes out
      const queued = hashes(v, "resumed")["queued.bin"];
      expect(hashes(v, "removed")["queued.bin"]).toBeUndefined();
      state.torrents = "removed";
      await d.command({ kind: "pauseAll" });
      const [first, again] = sent(s, "/api/torrents/stop");
      expect(first).toContain(queued);
      expect(again).toEqual(first.filter(x => x !== queued));
      expect(await store.load()).toEqual({ paused: true, keys: again });
    } finally {
      await s.close();
    }
  });
});

describe("Flood driver — details", () => {
  it("logs in with the jwt cookie and refuses a wrong login without a second try", async () => {
    const s = await floodServer("4.16.4-qbittorrent", { torrents: "running" });
    try {
      await expect(new FloodDriver(cfg(s.baseUrl, "wrong"), { ...timers, log }).poll()).rejects.toThrow(
        new AuthError("flood: login rejected (Failed login.)"),
      );
      await new FloodDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      expect(s.calls.filter(c => !isLogin(c)).every(c => c.headers.cookie === "jwt=abc")).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("refuses a login answer without the jwt cookie", async () => {
    const s = await startFixtureServer(() => ({ body: { success: true } }));
    try {
      await expect(new FloodDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(
        /unexpected login answer HTTP 200/,
      );
    } finally {
      await s.close();
    }
  });

  it("removes without the files and reports Flood's reason for a refused command", async () => {
    const s = await floodServer("4.16.4-rtorrent", { torrents: "running" });
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log });
      await expect(d.command({ kind: "remove", key: "F".repeat(40) })).rejects.toThrow(
        /HTTP 500 \(invalid parameters: info-hash not found\)/,
      );
      expect(s.calls.filter(c => c.path === "/api/torrents/delete").map(c => c.body)).toEqual([
        `{"hashes":["${"F".repeat(40)}"],"deleteData":false}`,
      ]);
    } finally {
      await s.close();
    }
  });

  it("refuses a torrent list with an entry without its hash (fleet C26b)", async () => {
    for (const odd of [null, { name: "x" }, { hash: 7 }]) {
      const s = await startFixtureServer(call =>
        call.path === "/api/auth/authenticate"
          ? { body: { success: true }, headers: { "set-cookie": "jwt=abc; Path=/" } }
          : call.path === "/api/torrents"
            ? { body: { id: 1, torrents: { ["A".repeat(40)]: odd } } }
            : { body: {} },
      );
      try {
        await expect(new FloodDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(ProtocolError);
      } finally {
        await s.close();
      }
    }
  });

  it("asks Sonarr's default port without a path", async () => {
    expect(await firstUrl(() => new FloodDriver({ ...cfg("http://nas:1"), port: 0 }, { ...timers, log }).poll())).toBe(
      "http://nas:3000/api/auth/authenticate",
    );
  });
});

/**
 * A Flood whose session works: the login sets the jwt cookie, every other request goes to `route` first and otherwise
 * gets the qBittorrent recording `running`.
 *
 * @param route the answer to a request, undefined for the recorded one
 * @returns the running server
 */
async function floodWith(
  route: (call: RecordedCall) => FixtureAnswer | undefined,
): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  const v = "4.16.4-qbittorrent";
  return startFixtureServer(call => {
    if (call.path === "/api/auth/authenticate") {
      return { body: { success: true }, headers: { "set-cookie": "jwt=abc; Path=/" } };
    }
    const own = route(call);
    if (own) {
      return own;
    }
    switch (`${call.method} ${call.path}`) {
      case "GET /api/openapi.json":
        return recorded(v, "auth", "openapi");
      case "GET /api/torrents":
        return recorded(v, "running", "torrents");
      case "GET /api/client/settings":
        return recorded(v, "running", "settings");
      default:
        return { status: 404, body: "" };
    }
  });
}

describe("Flood driver — failures that are no refusal of Flood", () => {
  it("holds a session refused again after a new login as a refused login, and lists nothing to retry on it", async () => {
    const s = await floodWith(call => (call.path === "/api/torrents/stop" ? { status: 401, body: "" } : undefined));
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: memoryPauseStore() });
      await d.poll();
      const lists = (): number => s.calls.filter(c => c.method === "GET" && c.path === "/api/torrents").length;
      const before = lists();
      await expect(d.command({ kind: "pauseAll" })).rejects.toThrow(
        new AuthError("flood: access refused after a new login (HTTP 401)"),
      );
      expect(lists()).toBe(before);
    } finally {
      await s.close();
    }
  });

  it("refuses a stop whose torrents are all still listed with Flood's reason, sent once", async () => {
    const s = await floodWith(call =>
      call.path === "/api/torrents/stop" ? { status: 500, body: { message: "boom" } } : undefined,
    );
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: memoryPauseStore() });
      await d.poll();
      await expect(d.command({ kind: "pauseAll" })).rejects.toThrow(
        "flood: POST /torrents/stop answered HTTP 500 (boom)",
      );
      expect(s.calls.filter(c => c.path === "/api/torrents/stop")).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it("fails the poll when the settings cannot be reached — only Flood's refusal leaves the limits as they are", async () => {
    const s = await floodServer("4.16.4-qbittorrent", {
      torrents: "running",
      settingsAnswer: { status: 503, body: "" },
    });
    try {
      await expect(new FloodDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(UnreachableError);
    } finally {
      await s.close();
    }
  });

  it("holds a refused login while setting a limit, even when the settings read back show the limit", async () => {
    const throttled = loadFixture("flood", "4.16.4-rtorrent", "throttled", "settings").body;
    expect(throttled).toMatchObject({ throttleGlobalDownSpeed: 102400 });
    const s = await floodWith(call =>
      call.method === "PATCH"
        ? { status: 401, body: "" }
        : call.path === "/api/client/settings"
          ? { body: throttled }
          : undefined,
    );
    try {
      await expect(
        new FloodDriver(cfg(s.baseUrl), { ...timers, log }).command({ kind: "setSpeedLimit", bps: 102400 }),
      ).rejects.toThrow(AuthError);
    } finally {
      await s.close();
    }
  });
});

describe("Flood driver — an add and the pause", () => {
  it("holds nothing it added started when the pause began while Flood took the add", async () => {
    const pending: { answer?: () => void } = {};
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(JSON.stringify(body));
        };
        if (req.url === "/api/auth/authenticate") {
          send(200, { success: true }, { "set-cookie": "jwt=abc; Path=/" });
        } else {
          // the add, answered with the hash Flood names only once the test says so
          pending.answer = () => send(202, ["abc"]);
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const store = memoryPauseStore();
    try {
      const d = new FloodDriver(cfg(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), {
        ...timers,
        log,
        pauseStore: store,
      });
      const adding = d.command({ kind: "add", url: "magnet:?xt=urn:btih:abc" });
      while (!pending.answer) {
        await new Promise(resolve => globalThis.setTimeout(resolve, 5));
      }
      await d.command({ kind: "pauseAll" });
      pending.answer();
      await adding;
      expect(await store.load()).toEqual({ paused: true, keys: [] });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("holds the next new stopped torrent when Flood's add answers nothing at all", async () => {
    const s = await floodServer("4.16.4-rtorrent", { torrents: "finished", add: { status: 202, body: "" } });
    const store = memoryPauseStore({ paused: true, keys: [] });
    try {
      const d = new FloodDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "add", url: "http://seed:8080/late.torrent" });
      expect(await store.load()).toEqual({ paused: true, keys: [] });
    } finally {
      await s.close();
    }
  });
});
