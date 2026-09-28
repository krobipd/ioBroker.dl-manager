import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer } from "../../../../test/helpers/fixture-server";
import { loadFixture } from "../../../../test/helpers/fixtures";
import type { ProgramConfig } from "../registry";
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
    key: "",
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
      const result = subs.map(s => (s.params[0] === "token:good" ? [r("running", FILES[s.methodName])] : unauthorized));
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
