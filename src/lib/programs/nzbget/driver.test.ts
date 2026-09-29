import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { NzbClient } from "./client";
import type { ProgramConfig } from "../../core/model";
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

describe("NZBGet connection", () => {
  it("asks the default port with a slash in front of a bare path", async () => {
    const d = new NzbDriver({ ...cfg("http://nas:1"), port: 0, path: "nzb" }, { ...timers, log });
    expect(await firstUrl(() => d.poll())).toBe("http://nas:6789/nzb/jsonrpc");
  });

  it("sends once more when NZBGet closed the kept-alive socket", async () => {
    const closed = new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(closed)
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "26.3" }), { status: 200 }));
    try {
      expect(await new NzbClient(cfg("http://nas:1"), timers).call("version")).toBe("26.3");
    } finally {
      spy.mockRestore();
    }
  });

  it("sends basic auth only with a user, and names 4xx answers and RPC errors", async () => {
    const s = await startFixtureServer(() => ({ body: { result: "26.3" } }));
    try {
      await new NzbClient({ ...cfg(s.baseUrl), username: "", password: "" }, timers).call("version");
      expect(s.calls[0].headers.authorization).toBeUndefined();
    } finally {
      await s.close();
    }
    for (const [answer, err] of [
      [{ status: 404, body: {} }, /HTTP 404/],
      [{ body: { error: { message: "Invalid procedure" } } }, /failed: Invalid procedure/],
    ] as const) {
      const t = await startFixtureServer(() => answer);
      try {
        await expect(new NzbClient(cfg(t.baseUrl), timers).call("version")).rejects.toThrow(err);
      } finally {
        await t.close();
      }
    }
  });
});
