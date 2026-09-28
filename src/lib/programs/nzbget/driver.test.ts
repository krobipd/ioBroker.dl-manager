import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer } from "../../../../test/helpers/fixture-server";
import { loadFixture } from "../../../../test/helpers/fixtures";
import type { ProgramConfig } from "../registry";
import { NzbDriver } from "./driver";
import { mapNzbStatus, statusTable } from "./map";

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
    type: "nzbget",
    key: "",
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
 * NZBGet from the recordings: basic auth (401 without), reads by method.
 *
 * @param version recorded version
 */
async function nzbServer(version = "26.3"): Promise<ContractServer> {
  const good = `Basic ${Buffer.from("admin:good").toString("base64")}`;
  const READS: Record<string, [string, string]> = {
    version: ["auth", "version"],
    status: ["running", "status"],
    listgroups: ["running", "listgroups"],
    history: ["running", "history"],
  };
  return startFixtureServer(call => {
    if (call.headers.authorization !== good) {
      return { status: 401, body: "" };
    }
    const method = (JSON.parse(call.body) as { method: string }).method;
    const read = READS[method];
    return {
      body: read ? loadFixture("nzbget", version, read[0], read[1]).body : { version: "1.1", id: 1, result: true },
    };
  });
}

runDriverContract({
  type: "nzbget",
  server: () => nzbServer(),
  makeDriver: (base, creds) => new NzbDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }),
  mapStatus: mapNzbStatus,
  statusTable,
  unknownStatus: "q:SOMETHING_NEW",
  commandCalls: {
    pauseAll: { method: "POST", path: "/jsonrpc", bodyContains: '"method":"pausedownload"' },
    resumeAll: { method: "POST", path: "/jsonrpc", bodyContains: '"method":"resumedownload"' },
    pause: { method: "POST", path: "/jsonrpc", bodyContains: '"GroupPause","",[4]' },
    resume: { method: "POST", path: "/jsonrpc", bodyContains: '"GroupResume","",[4]' },
    remove: { method: "POST", path: "/jsonrpc", bodyContains: '"GroupParkDelete","",[4]' },
    add: { method: "POST", path: "/jsonrpc", bodyContains: '"method":"append","params":["","magnet:' },
    setSpeedLimit: { method: "POST", path: "/jsonrpc", bodyContains: '"method":"rate","params":[1953]' },
  },
  isLoginCall: call => call.headers.authorization !== `Basic ${Buffer.from("admin:good").toString("base64")}`,
});

describe("NZBGet driver", () => {
  it("removes a history entry through the history and retries a failed job", async () => {
    const s = await nzbServer("24.8");
    try {
      const d = new NzbDriver(cfg(s.baseUrl), { ...timers, log });
      const snap = await d.poll();
      expect(snap.status.version).toBe("24.8");
      const failed = snap.items.find(i => i.name === "broken");
      await d.command({ kind: "remove", key: String(failed?.key) });
      expect(s.calls.at(-1)?.body).toContain('"HistoryDelete","",[2]');
      await d.command({ kind: "extra", name: "retry", key: String(failed?.key) });
      expect(s.calls.at(-1)?.body).toContain('"HistoryRedownload","",[2]');
      await expect(d.command({ kind: "pause", key: String(failed?.key) })).rejects.toThrow(/queue/);
      await d.command({ kind: "setSpeedLimit", bps: 0 });
      expect(s.calls.at(-1)?.body).toContain('"method":"rate","params":[0]');
    } finally {
      await s.close();
    }
  });
});
