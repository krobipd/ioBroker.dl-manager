import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import type { ProgramConfig } from "../../core/model";
import type { MiniSocket } from "./client";
import { AriaDriver } from "./driver";
import { mapAriaStatus, statusTable } from "./map";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const cfg = (base: string, secret = "good"): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "aria2",
    deviceId: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "",
    username: "",
    password: "",
    apiKey: secret,
    device: "",
  };
};
const noSocket = (): MiniSocket => ({ addEventListener: () => undefined, close: () => undefined });

/** aria2 from the recordings: the token decides; multicall answers from the running snapshot. */
async function ariaServer(): Promise<ContractServer> {
  const r = (state: string, name: string): unknown =>
    (loadFixture("aria2", "1.37.0", state, name).body as { result: unknown }).result;
  const FILES: Record<string, string> = {
    "aria2.tellActive": "tell-active",
    "aria2.tellWaiting": "tell-waiting",
    "aria2.tellStopped": "tell-stopped",
    "aria2.getGlobalStat": "global-stat",
    "aria2.getGlobalOption": "global-option",
  };
  const unauthorized = { code: 1, message: "Unauthorized" };
  return startFixtureServer(call => {
    const { method, params, id } = JSON.parse(call.body) as { method: string; params: unknown[]; id: string };
    if (method === "system.multicall") {
      const subs = params[0] as { methodName: string; params: unknown[] }[];
      const read = (name: string): unknown =>
        name === "aria2.getVersion" ? r("auth", "version") : r("running", FILES[name]);
      const result = subs.map(s => (s.params[0] === "token:good" ? [read(s.methodName)] : unauthorized));
      return { body: { jsonrpc: "2.0", id, result } };
    }
    if (params[0] !== "token:good") {
      return { status: 400, body: { jsonrpc: "2.0", id, error: unauthorized } };
    }
    if (method === "aria2.getVersion") {
      return { body: { jsonrpc: "2.0", id, result: r("auth", "version") } };
    }
    return { body: { jsonrpc: "2.0", id, result: "OK" } };
  });
}

runDriverContract({
  type: "aria2",
  server: ariaServer,
  makeDriver: (base, creds) => new AriaDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }, noSocket),
  mapStatus: mapAriaStatus,
  statusTable,
  unknownStatus: "unknown",
  commandCalls: {
    pauseAll: { method: "POST", path: "/jsonrpc", bodyContains: '"method":"aria2.pause"' },
    resumeAll: { method: "POST", path: "/jsonrpc", bodyContains: '"method":"aria2.unpause"' },
    pause: { method: "POST", path: "/jsonrpc", bodyContains: '"method":"aria2.pause"' },
    resume: { method: "POST", path: "/jsonrpc", bodyContains: '"method":"aria2.unpause"' },
    remove: { method: "POST", path: "/jsonrpc", bodyContains: '"method":"aria2.remove' },
    add: { method: "POST", path: "/jsonrpc", bodyContains: '"method":"aria2.addUri"' },
    setSpeedLimit: { method: "POST", path: "/jsonrpc", bodyContains: '"max-overall-download-limit":"2000000"' },
    setUploadLimit: { method: "POST", path: "/jsonrpc", bodyContains: '"max-overall-upload-limit":"2000000"' },
  },
  isLoginCall: call => call.body.includes("token:bad"),
});

describe("aria2 driver", () => {
  it("reads the version with every query — an updated aria2 shows its new one", async () => {
    let version: string | undefined = "1.36.0";
    const s = await startFixtureServer(call => {
      const { method, params, id } = JSON.parse(call.body) as { method: string; params: unknown[]; id: string };
      const answer = (m: string): unknown =>
        m === "aria2.getVersion" ? { version } : m.startsWith("aria2.tell") ? [] : {};
      if (method === "system.multicall") {
        const subs = params[0] as { methodName: string }[];
        return { body: { jsonrpc: "2.0", id, result: subs.map(x => [answer(x.methodName)]) } };
      }
      return { body: { jsonrpc: "2.0", id, result: answer(method) } };
    });
    try {
      const d = new AriaDriver(cfg(s.baseUrl), { ...timers, log }, noSocket);
      expect((await d.poll()).status.version).toBe("1.36.0");
      version = "1.37.0";
      expect((await d.poll()).status.version).toBe("1.37.0");
      version = undefined;
      expect((await d.poll()).status.version).toBe("");
    } finally {
      await s.close();
    }
  });

  it("drops a finished result from the list, removes a running download, and adds paused while held", async () => {
    const s = await ariaServer();
    try {
      const d = new AriaDriver(cfg(s.baseUrl), { ...timers, log }, noSocket);
      const snap = await d.poll();
      const done = snap.items.find(i => i.status === "completed");
      const queued = snap.items.find(i => i.status === "queued");
      await d.command({ kind: "remove", key: String(done?.key) });
      expect(s.calls.at(-1)?.body).toContain('"aria2.removeDownloadResult"');
      await d.command({ kind: "remove", key: String(queued?.key) });
      expect(s.calls.at(-1)?.body).toContain('"method":"aria2.remove"');
      await d.command({ kind: "pauseAll" });
      await d.command({ kind: "add", url: "http://x/y.bin" });
      expect(s.calls.at(-1)?.body).toContain('{"pause":"true"}');
    } finally {
      await s.close();
    }
  });

  it("turns aria2 notifications into poll triggers and reconnects a closed channel", () => {
    const listeners: Record<string, (ev: { data?: unknown }) => void> = {};
    let opened = 0;
    let closed = false;
    const later: (() => void)[] = [];
    const d = new AriaDriver(
      cfg("http://127.0.0.1:6800"),
      {
        setTimeout: cb => {
          later.push(cb);
          return undefined;
        },
        clearTimeout: () => undefined,
        log,
      },
      () => {
        opened++;
        return {
          addEventListener: (type, fn) => {
            listeners[type] = fn;
          },
          close: () => {
            closed = true;
          },
        };
      },
    );
    let pushes = 0;
    const stop = d.subscribe(() => pushes++);
    listeners.message({ data: '{"jsonrpc":"2.0","method":"aria2.onDownloadComplete","params":[{"gid":"a"}]}' });
    listeners.message({ data: '{"jsonrpc":"2.0","id":"1","result":"OK"}' });
    expect(pushes).toBe(1);
    listeners.close({});
    later.shift()?.();
    expect(opened).toBe(2);
    stop();
    expect(closed).toBe(true);
  });
});

/**
 * aria2 whose lists the test sets; every other call answers OK.
 *
 * @param lists result per multicall method
 * @returns the running server
 */
async function ariaSynth(lists: Record<string, unknown>): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  return startFixtureServer(call => {
    const { method, params, id } = JSON.parse(call.body) as { method: string; params: unknown[]; id: string };
    if (method === "system.multicall") {
      const subs = params[0] as { methodName: string }[];
      const answer = (name: string): unknown =>
        lists[name] ?? (name === "aria2.getVersion" ? { version: "1.37.0" } : []);
      return { body: { jsonrpc: "2.0", id, result: subs.map(x => [answer(x.methodName)]) } };
    }
    return { body: { jsonrpc: "2.0", id, result: method === "aria2.getVersion" ? { version: "1.37.0" } : "OK" } };
  });
}

describe("aria2 details", () => {
  it("asks the default port and path", async () => {
    const d = new AriaDriver({ ...cfg("http://nas:1"), port: 0 }, { ...timers, log }, noSocket);
    expect(await firstUrl(() => d.poll())).toBe("http://nas:6800/jsonrpc");
  });

  it("opens the push channel with TLS when HTTPS is on", () => {
    let url = "";
    const d = new AriaDriver({ ...cfg("http://nas:6800"), https: true }, { ...timers, log }, u => {
      url = u;
      return noSocket();
    });
    d.subscribe(() => undefined)();
    expect(url).toBe("wss://nas:6800/jsonrpc");
  });

  it("retries a push channel that could not open, but not after stop", () => {
    const later: (() => void)[] = [];
    let opened = 0;
    let failFirst = true;
    const listeners: Record<string, (ev: { data?: unknown }) => void> = {};
    const d = new AriaDriver(
      cfg("http://nas:6800"),
      {
        setTimeout: cb => {
          later.push(cb);
          return undefined;
        },
        clearTimeout: () => undefined,
        log,
      },
      () => {
        if (failFirst) {
          failFirst = false;
          throw new Error("refused");
        }
        opened++;
        return {
          addEventListener: (type, fn) => {
            listeners[type] = fn;
          },
          close: () => undefined,
        };
      },
    );
    const stop = d.subscribe(() => undefined);
    expect(later).toHaveLength(1);
    later.shift()?.();
    expect(opened).toBe(1);
    listeners.close({});
    stop();
    later.shift()?.();
    expect(opened).toBe(1);
  });

  it("pauses only running downloads, forgets gone ones", async () => {
    const lists: Record<string, unknown> = {
      "aria2.tellActive": [{ gid: "a", status: "active" }],
      "aria2.tellWaiting": [
        { gid: "w", status: "waiting" },
        { gid: "p", status: "paused" },
      ],
    };
    const s = await ariaSynth(lists);
    const store = memoryPauseStore();
    try {
      const d = new AriaDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store }, noSocket);
      await d.poll();
      await d.command({ kind: "pauseAll" });
      const paused = s.calls
        .map(c => JSON.parse(c.body) as { method: string; params: unknown[] })
        .filter(b => b.method === "aria2.pause")
        .map(b => b.params[1]);
      expect(paused).toEqual(["a", "w"]);
      lists["aria2.tellWaiting"] = [
        { gid: "w", status: "paused" },
        { gid: "p", status: "paused" },
      ];
      lists["aria2.tellActive"] = [];
      await d.poll();
      expect(await store.load()).toEqual({ paused: true, keys: ["w"] });
    } finally {
      await s.close();
    }
  });

  it("names the fault of a single call — a command aria2 refuses fails", async () => {
    const s = await startFixtureServer(call => {
      const { id } = JSON.parse(call.body) as { id: string };
      return { body: { jsonrpc: "2.0", id, error: { code: 1, message: "GID 123 is not found" } } };
    });
    try {
      await expect(
        new AriaDriver(cfg(s.baseUrl), { ...timers, log }, noSocket).command({ kind: "pause", key: "123" }),
      ).rejects.toThrow(/GID 123 is not found/);
    } finally {
      await s.close();
    }
  });

  it("names a short multicall answer, a fault inside it and a 4xx", async () => {
    const answers: [(id: string) => unknown, number, RegExp][] = [
      [id => ({ jsonrpc: "2.0", id, result: [[{ version: "1" }]] }), 200, /unexpected shape/],
      [
        id => ({ jsonrpc: "2.0", id, result: [[{}], [], [], [], { code: 1, message: "boom" }, []] }),
        200,
        /failed: boom/,
      ],
      [id => ({ jsonrpc: "2.0", id }), 404, /HTTP 404/],
    ];
    for (const [body, status, err] of answers) {
      const s = await startFixtureServer(call => {
        const { method, id } = JSON.parse(call.body) as { method: string; id: string };
        if (method === "aria2.getVersion") {
          return { body: { jsonrpc: "2.0", id, result: { version: "1.37.0" } } };
        }
        return { status, body: body(id) };
      });
      try {
        await expect(new AriaDriver(cfg(s.baseUrl), { ...timers, log }, noSocket).poll()).rejects.toThrow(err);
      } finally {
        await s.close();
      }
    }
  });
});
