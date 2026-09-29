import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { UnreachableError } from "../../core/errors";
import type { ProgramConfig } from "../registry";
import { DlDriver } from "./driver";
import { mapDlStatus, statusTable } from "./map";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const cfg = (base: string, password = "deluge"): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "deluge",
    key: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "",
    username: "",
    password,
    apiKey: "",
    device: "",
  };
};

/**
 * deluge-web from the recordings: password login with cookie, "not authenticated" (code 1) without.
 *
 * @param version recorded version
 */
async function dlServer(version = "2.2.0"): Promise<ContractServer> {
  let expire = false;
  const f = (state: string, name: string): unknown => loadFixture("deluge", version, state, name).body;
  const READS: Record<string, [string, string]> = {
    "web.get_hosts": ["auth", "get-hosts"],
    "web.get_host_status": ["auth", "get-host-status"],
    "web.update_ui": ["running", "update-ui"],
    "core.get_config_values": ["running", "config-values"],
    "core.is_session_paused": ["running", "is-session-paused"],
  };
  const s = await startFixtureServer(call => {
    const { method, params } = JSON.parse(call.body) as { method: string; params: unknown[] };
    if (method === "auth.login") {
      return params[0] === "deluge"
        ? { body: f("auth", "login-ok"), headers: { "set-cookie": "_session_id=abc; Path=/json" } }
        : { body: f("auth", "login-wrong") };
    }
    if (call.headers.cookie !== "_session_id=abc" || expire) {
      expire = false;
      return { body: f("auth", "session-missing") };
    }
    if (method === "web.connected") {
      return { body: { result: true, error: null, id: 1 } };
    }
    const read = READS[method];
    return { body: read ? f(read[0], read[1]) : { result: null, error: null, id: 1 } };
  });
  return {
    ...s,
    expireSession: () => {
      expire = true;
    },
  };
}

runDriverContract({
  type: "deluge",
  server: () => dlServer(),
  makeDriver: (base, creds) => new DlDriver(cfg(base, creds.good ? "deluge" : "wrong"), { ...timers, log }),
  mapStatus: mapDlStatus,
  statusTable,
  unknownStatus: "Unknown",
  commandCalls: {
    pauseAll: { method: "POST", path: "/json", bodyContains: '"core.pause_session"' },
    resumeAll: { method: "POST", path: "/json", bodyContains: '"core.resume_session"' },
    pause: { method: "POST", path: "/json", bodyContains: '"core.pause_torrent"' },
    resume: { method: "POST", path: "/json", bodyContains: '"core.resume_torrent"' },
    remove: { method: "POST", path: "/json", bodyContains: '"core.remove_torrent"' },
    add: { method: "POST", path: "/json", bodyContains: '"core.add_torrent_magnet"' },
    setSpeedLimit: { method: "POST", path: "/json", bodyContains: '"max_download_speed":1953.125' },
    setUploadLimit: { method: "POST", path: "/json", bodyContains: '"max_upload_speed":1953.125' },
  },
  isLoginCall: call => call.body.includes('"auth.login"'),
});

describe("Deluge driver", () => {
  it("reads the daemon version from the host status and keeps files on remove", async () => {
    const s = await dlServer("2.1.1");
    try {
      const d = new DlDriver(cfg(s.baseUrl), { ...timers, log });
      const snap = await d.poll();
      expect(snap.status.version).toBe("2.1.1");
      await d.command({ kind: "remove", key: snap.items[0].key });
      expect(s.calls.at(-1)?.body).toContain(`"params":["${snap.items[0].key}",false]`);
      await d.command({ kind: "setSpeedLimit", bps: 0 });
      expect(s.calls.at(-1)?.body).toContain('"max_download_speed":-1');
    } finally {
      await s.close();
    }
  });
});

/**
 * deluge-web whose results the test sets per method (login always accepted).
 *
 * @param results result per method
 * @param status HTTP status of every non-login answer
 * @returns the running server
 */
async function dlSynth(
  results: Record<string, unknown>,
  status = 200,
): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  return startFixtureServer(call => {
    const { method, id } = JSON.parse(call.body) as { method: string; id: number };
    if (method === "auth.login") {
      return { body: { result: true, error: null, id }, headers: { "set-cookie": "_session_id=abc" } };
    }
    return { status, body: { result: method in results ? results[method] : null, error: null, id } };
  });
}
const HOST = {
  "web.get_hosts": [["h1", "127.0.0.1", 58846, "Online"]],
  "web.get_host_status": ["h1", "Online", "2.2.0"],
  "web.update_ui": { connected: true, torrents: {}, stats: {} },
};

describe("Deluge connection", () => {
  it("asks the default port and logs in first", async () => {
    const d = new DlDriver({ ...cfg("http://nas:1"), port: 0 }, { ...timers, log });
    expect(await firstUrl(() => d.poll())).toBe("http://nas:8112/json");
    const s = await dlSynth({ ...HOST, "web.connected": true });
    try {
      await new DlDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      expect(s.calls[0].body).toContain('"auth.login"');
    } finally {
      await s.close();
    }
  });

  it("connects the web UI to the daemon when it is not connected yet", async () => {
    const s = await dlSynth({ ...HOST, "web.connected": false });
    try {
      await new DlDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      expect(s.calls.some(c => c.body.includes('"web.connect"'))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("names an empty connection manager, an offline daemon and a 4xx answer", async () => {
    const cases: [Record<string, unknown>, number, RegExp | (new (message: string) => Error)][] = [
      [{ "web.get_hosts": [] }, 200, /knows no daemon/],
      [{ ...HOST, "web.get_host_status": ["h1", "Offline", ""] }, 200, UnreachableError],
      [HOST, 404, /HTTP 404/],
    ];
    for (const [results, status, err] of cases) {
      const s = await dlSynth(results, status);
      try {
        await expect(new DlDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(err);
      } finally {
        await s.close();
      }
    }
  });

  it("reads an unknown session pause as not paused", async () => {
    const s = await dlSynth({
      ...HOST,
      "web.connected": true,
      "web.update_ui": { connected: true, torrents: {}, stats: {} },
    });
    try {
      expect((await new DlDriver(cfg(s.baseUrl), { ...timers, log }).poll()).status.paused).toBe(false);
    } finally {
      await s.close();
    }
  });
});

describe("Deluge daemon disconnect (final review C1)", () => {
  it("keeps the channels when the daemon is gone and connects the web UI again once it is back", async () => {
    const results: Record<string, unknown> = {
      ...HOST,
      "web.connected": true,
      "web.update_ui": { connected: false, stats: { max_download: -1 } },
    };
    const s = await dlSynth(results);
    try {
      const d = new DlDriver(cfg(s.baseUrl), { ...timers, log });
      await expect(d.poll()).rejects.toThrow(UnreachableError);
      results["web.update_ui"] = { connected: true, torrents: {}, stats: {} };
      await d.poll();
      expect(s.calls.filter(c => c.body.includes('"auth.login"'))).toHaveLength(2);
    } finally {
      await s.close();
    }
  });
});
