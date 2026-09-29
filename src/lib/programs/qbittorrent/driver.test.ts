import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { firstUrl } from "../../../../test/helpers/first-url";
import { AuthError, ProtocolError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { QbDriver } from "./driver";
import { mapQbState, statusTable } from "./map";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const cfg = (base: string, over: Partial<ProgramConfig> = {}): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "qbittorrent",
    key: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "",
    username: "admin",
    password: "good",
    apiKey: "",
    device: "",
    ...over,
  };
};

/**
 * qBittorrent from the recordings: login with cookie, 403 without, the recorded maindata, commands answer empty.
 *
 * @param version recorded version
 * @param opts server behaviour
 * @param opts.banned the login answers 403 (address banned)
 */
async function qbServer(
  version = "5.2.3",
  opts: { banned?: boolean } = {},
): Promise<ContractServer & { failNextLogin(): void }> {
  let expire = false;
  let failLogin = false;
  const f = (state: string, name: string): { status: number; body: unknown } => {
    const r = loadFixture("qbittorrent", version, state, name);
    return { status: r.status, body: r.body };
  };
  const s = await startFixtureServer((call: RecordedCall) => {
    if (call.path === "/api/v2/auth/login") {
      if (opts.banned) {
        return { status: 403, body: "Your IP address has been banned after too many failed authentication attempts." };
      }
      if (call.body === "username=admin&password=good" && !failLogin) {
        return {
          status: version.startsWith("5.2") ? 204 : 200,
          body: version.startsWith("5.2") ? "" : "Ok.",
          headers: { "set-cookie": "SID=abc; HttpOnly" },
        };
      }
      failLogin = false;
      return f("auth", "login-wrong");
    }
    const bearer = call.headers.authorization === "Bearer qbt_key";
    if ((call.headers.cookie !== "SID=abc" && !bearer) || expire) {
      expire = false;
      return f("auth", "session-missing");
    }
    if (call.path === "/api/v2/app/version") {
      return f("auth", "app-version");
    }
    if (call.path === "/api/v2/sync/maindata") {
      return f("running", "maindata");
    }
    return { body: "" };
  });
  return {
    ...s,
    expireSession: () => {
      expire = true;
    },
    failNextLogin: () => {
      failLogin = true;
    },
  };
}

/**
 * A qBittorrent 5.3 with a real session pause (none recorded yet — WebAPI 2.16.2).
 *
 * @param paused `server_state.session_state`
 */
async function qb53(paused: boolean): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  return startFixtureServer(call => {
    if (call.path === "/api/v2/auth/login") {
      return { body: "Ok.", headers: { "set-cookie": "SID=abc; HttpOnly" } };
    }
    if (call.path === "/api/v2/app/version") {
      return { body: "v5.3.0" };
    }
    if (call.path === "/api/v2/sync/maindata") {
      return {
        body: {
          rid: 1,
          full_update: true,
          torrents: { h: { name: "x", state: "downloading" } },
          server_state: { session_state: paused },
        },
      };
    }
    return { body: "" };
  });
}

runDriverContract({
  type: "qbittorrent",
  server: () => qbServer(),
  makeDriver: (base, creds) => new QbDriver(cfg(base, { password: creds.good ? "good" : "bad" }), { ...timers, log }),
  mapStatus: mapQbState,
  statusTable,
  unknownStatus: "somethingNew",
  commandCalls: {
    pauseAll: { method: "POST", path: "/api/v2/torrents/stop", bodyContains: "hashes=" },
    resumeAll: { method: "POST", path: "/api/v2/torrents/start", bodyContains: "hashes=" },
    pause: { method: "POST", path: "/api/v2/torrents/stop", bodyContains: "hashes=" },
    resume: { method: "POST", path: "/api/v2/torrents/start", bodyContains: "hashes=" },
    remove: { method: "POST", path: "/api/v2/torrents/delete", bodyContains: "deleteFiles=false" },
    add: { method: "POST", path: "/api/v2/torrents/add", bodyContains: "magnet:" },
    setSpeedLimit: { method: "POST", path: "/api/v2/transfer/setDownloadLimit", bodyContains: "limit=2000000" },
    setUploadLimit: { method: "POST", path: "/api/v2/transfer/setUploadLimit", bodyContains: "limit=2000000" },
    setAltSpeed: { method: "POST", path: "/api/v2/transfer/setSpeedLimitsMode", bodyContains: "mode=1" },
  },
  isLoginCall: call => call.path === "/api/v2/auth/login",
});

describe("qBittorrent driver", () => {
  it("calls a 403 at login a banned address, once", async () => {
    const s = await qbServer("5.2.3", { banned: true });
    try {
      const err: unknown = await new QbDriver(cfg(s.baseUrl), { ...timers, log }).poll().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect(String(err)).toMatch(/banned/);
      expect(s.calls.filter(c => c.path === "/api/v2/auth/login")).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it("accepts the 4.x login (200 Ok.) and uses pause/resume there", async () => {
    const s = await qbServer("4.6.7");
    try {
      const d = new QbDriver(cfg(s.baseUrl), { ...timers, log });
      const snap = await d.poll();
      expect(snap.status.version).toBe("4.6.7");
      await d.command({ kind: "pause", key: snap.items[0].key });
      await d.command({ kind: "resume", key: snap.items[0].key });
      expect(s.calls.map(c => c.path)).toContain("/api/v2/torrents/pause");
      expect(s.calls.map(c => c.path)).toContain("/api/v2/torrents/resume");
    } finally {
      await s.close();
    }
  });

  it("rejects 4.x login data with Fails. as a login error", async () => {
    const s = await qbServer("4.6.7");
    try {
      await expect(new QbDriver(cfg(s.baseUrl, { password: "bad" }), { ...timers, log }).poll()).rejects.toThrow(
        AuthError,
      );
    } finally {
      await s.close();
    }
  });

  it("uses the API key as bearer token instead of logging in", async () => {
    const s = await qbServer();
    try {
      await new QbDriver(cfg(s.baseUrl, { apiKey: "qbt_key", username: "", password: "" }), { ...timers, log }).poll();
      expect(s.calls.some(c => c.path === "/api/v2/auth/login")).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("adds a download stopped while the adapter holds the program paused", async () => {
    const s = await qbServer();
    try {
      const d = new QbDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      await d.command({ kind: "add", url: "magnet:?xt=urn:btih:abc" });
      const add = s.calls.find(c => c.path === "/api/v2/torrents/add");
      expect(add?.body).toContain('name="stopped"');
    } finally {
      await s.close();
    }
  });

  it("sends recheck and force start for a download", async () => {
    const s = await qbServer();
    try {
      const d = new QbDriver(cfg(s.baseUrl), { ...timers, log });
      const key = (await d.poll()).items[0].key;
      await d.command({ kind: "extra", name: "recheck", key });
      await d.command({ kind: "extra", name: "forceStart", key, value: true });
      const recheck = s.calls.find(c => c.path === "/api/v2/torrents/recheck");
      const force = s.calls.find(c => c.path === "/api/v2/torrents/setForceStart");
      expect(recheck?.body).toBe(`hashes=${key}`);
      expect(force?.body).toBe(`hashes=${key}&value=true`);
    } finally {
      await s.close();
    }
  });

  it("asks the default port 8080 and puts a leading slash in front of a bare path", async () => {
    const url = await firstUrl(() =>
      new QbDriver(cfg("http://nas:1", { port: 0, path: "qb/" }), { ...timers, log }).poll(),
    );
    expect(url).toBe("http://nas:8080/qb/api/v2/auth/login");
  });

  it("does not log in when the API key is refused, and fails when a fresh login is refused too", async () => {
    const s = await startFixtureServer(() => ({ status: 403, body: "Forbidden" }));
    try {
      const keyed = new QbDriver(cfg(s.baseUrl, { apiKey: "k", username: "", password: "" }), { ...timers, log });
      await expect(keyed.poll()).rejects.toThrow(/API key was refused/);
      expect(s.calls.some(c => c.path === "/api/v2/auth/login")).toBe(false);
    } finally {
      await s.close();
    }
    const t = await startFixtureServer(call =>
      call.path === "/api/v2/auth/login"
        ? { body: "Ok.", headers: { "set-cookie": "SID=abc" } }
        : { status: 403, body: "Forbidden" },
    );
    try {
      await expect(new QbDriver(cfg(t.baseUrl), { ...timers, log }).poll()).rejects.toThrow(AuthError);
    } finally {
      await t.close();
    }
  });

  it("calls a 4xx answer and a login without cookie or Ok. a protocol error", async () => {
    const s = await startFixtureServer(call =>
      call.path === "/api/v2/auth/login"
        ? { body: "Ok.", headers: { "set-cookie": "SID=abc" } }
        : { status: 404, body: "Not Found" },
    );
    try {
      await expect(new QbDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(ProtocolError);
      await expect(
        new QbDriver(cfg(s.baseUrl), { ...timers, log }).command({ kind: "remove", key: "h" }),
      ).rejects.toThrow(/HTTP 404/);
    } finally {
      await s.close();
    }
    const t = await startFixtureServer(() => ({ body: "" }));
    try {
      await expect(new QbDriver(cfg(t.baseUrl), { ...timers, log }).poll()).rejects.toThrow(/unexpected login answer/);
    } finally {
      await t.close();
    }
  });

  it("starts the sync over after a login that failed in between", async () => {
    const s = await qbServer();
    try {
      const d = new QbDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      s.expireSession?.();
      s.failNextLogin();
      await expect(d.poll()).rejects.toThrow(AuthError);
      await d.poll();
      const syncs = s.calls.filter(c => c.path === "/api/v2/sync/maindata");
      expect(syncs.at(-1)?.query).toBe("rid=0");
    } finally {
      await s.close();
    }
  });

  it("uses the real session pause of 5.3 for reading, pausing and resuming", async () => {
    const s = await qb53(true);
    try {
      const d = new QbDriver(cfg(s.baseUrl), { ...timers, log });
      expect((await d.poll()).status.paused).toBe(true);
      await d.command({ kind: "resumeAll" });
      await d.command({ kind: "pauseAll" });
      const paths = s.calls.map(c => c.path);
      expect(paths).toContain("/api/v2/transfer/resumeSession");
      expect(paths).toContain("/api/v2/transfer/pauseSession");
    } finally {
      await s.close();
    }
  });

  it("adds a download paused on 4.x while the adapter holds the program paused", async () => {
    const s = await qbServer("4.6.7");
    try {
      const d = new QbDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      await d.command({ kind: "add", url: "magnet:?xt=urn:btih:abc" });
      expect(s.calls.find(c => c.path === "/api/v2/torrents/add")?.body).toContain('name="paused"');
    } finally {
      await s.close();
    }
  });

  it("switches alternative speed and force start off as well", async () => {
    const s = await qbServer();
    try {
      const d = new QbDriver(cfg(s.baseUrl), { ...timers, log });
      const key = (await d.poll()).items[0].key;
      await d.command({ kind: "setAltSpeed", on: false });
      await d.command({ kind: "extra", name: "forceStart", key, value: false });
      expect(s.calls.find(c => c.path === "/api/v2/transfer/setSpeedLimitsMode")?.body).toBe("mode=0");
      expect(s.calls.find(c => c.path === "/api/v2/torrents/setForceStart")?.body).toBe(`hashes=${key}&value=false`);
    } finally {
      await s.close();
    }
  });
});
