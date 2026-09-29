import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import type { ProgramConfig } from "../../core/model";
import { SabDriver } from "./driver";
import { mapSabStatus, statusTable } from "./map";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const cfg = (base: string, apiKey = "good"): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "sabnzbd",
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
 * SABnzbd from the recordings: 403 with the wrong key; `history: false` when last_history_update is current.
 *
 * @param version recorded version
 */
async function sabServer(version = "5.1.3"): Promise<ContractServer> {
  const f = (state: string, name: string): { status: number; body: unknown } => {
    const r = loadFixture("sabnzbd", version, state, name);
    return { status: r.status, body: r.body };
  };
  const s = await startFixtureServer(call => {
    const q = new URLSearchParams(call.query);
    if (q.get("apikey") !== "good") {
      return f("auth", "key-wrong");
    }
    if (q.get("mode") === "queue" && !q.get("name")) {
      return f("running", "queue");
    }
    if (q.get("mode") === "history" && !q.get("name")) {
      const h = f("running", "history");
      const current = String((h.body as { history: { last_history_update: unknown } }).history.last_history_update);
      return q.get("last_history_update") === current ? { body: { history: false } } : h;
    }
    return { body: { status: true } };
  });
  return s;
}

runDriverContract({
  type: "sabnzbd",
  server: () => sabServer(),
  makeDriver: (base, creds) => new SabDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }),
  mapStatus: mapSabStatus,
  statusTable,
  unknownStatus: "q:SomethingNew",
  commandCalls: {
    pauseAll: { method: "GET", path: "/api", bodyContains: "mode=pause" },
    resumeAll: { method: "GET", path: "/api", bodyContains: "mode=resume" },
    pause: { method: "GET", path: "/api", bodyContains: "mode=queue&name=pause" },
    resume: { method: "GET", path: "/api", bodyContains: "mode=queue&name=resume" },
    remove: { method: "GET", path: "/api", bodyContains: "name=delete" },
    add: { method: "GET", path: "/api", bodyContains: "mode=addurl" },
    setSpeedLimit: { method: "GET", path: "/api", bodyContains: "value=1953K" },
  },
  isLoginCall: call => call.query.includes("apikey=bad"),
});

describe("SABnzbd driver", () => {
  it("tests the key quietly with mode=auth — a wrong key leaves no warning in SABnzbd", async () => {
    const s = await startFixtureServer(call => {
      const q = new URLSearchParams(call.query);
      if (q.get("mode") === "auth") {
        return { body: { auth: q.get("key") === "good" ? "apikey" : "badkey" } };
      }
      return { body: { version: "5.1.3" } };
    });
    try {
      expect(await new SabDriver(cfg(s.baseUrl), { ...timers, log }).test()).toBe("5.1.3");
      await expect(new SabDriver(cfg(s.baseUrl, "bad"), { ...timers, log }).test()).rejects.toThrow(/API key/);
      expect(s.calls.every(c => !c.query.includes("apikey=bad"))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("keeps the last history when SABnzbd reports no change", async () => {
    const s = await sabServer();
    try {
      const d = new SabDriver(cfg(s.baseUrl), { ...timers, log });
      const first = await d.poll();
      const second = await d.poll();
      expect(second.items.map(i => i.key)).toEqual(first.items.map(i => i.key));
      const histories = s.calls.filter(c => c.query.includes("mode=history"));
      expect(histories[1].query).toMatch(/last_history_update=[1-9]/);
      expect(histories[0].query).toContain("limit=1000");
    } finally {
      await s.close();
    }
  });

  it("removes a history entry through the history, a queue job through the queue, and refuses to pause history", async () => {
    const s = await sabServer();
    try {
      const d = new SabDriver(cfg(s.baseUrl), { ...timers, log });
      const snap = await d.poll();
      const done = snap.items.find(i => i.status === "completed");
      const queued = snap.items.find(i => i.status === "paused");
      await d.command({ kind: "remove", key: String(done?.key) });
      expect(s.calls.at(-1)?.query).toContain("mode=history&name=delete");
      await d.command({ kind: "remove", key: String(queued?.key) });
      expect(s.calls.at(-1)?.query).toContain("mode=queue&name=delete");
      await expect(d.command({ kind: "pause", key: String(done?.key) })).rejects.toThrow(/queue/);
      await d.command({ kind: "extra", name: "retry", key: String(done?.key) });
      expect(s.calls.at(-1)?.query).toContain("mode=retry");
      await d.command({ kind: "setSpeedLimit", bps: 0 });
      expect(s.calls.at(-1)?.query).toContain("name=speedlimit&value=0");
    } finally {
      await s.close();
    }
  });
});

describe("SABnzbd details", () => {
  it("asks the default port with a slash in front of a bare path", async () => {
    const d = new SabDriver({ ...cfg("http://nas:1"), port: 0, path: "sab" }, { ...timers, log });
    expect((await firstUrl(() => d.poll())).startsWith("http://nas:8080/sab/api?")).toBe(true);
  });

  it("calls a 4xx and status false protocol errors with SABnzbd's reason", async () => {
    for (const [answer, err] of [
      [{ status: 404, body: {} }, /HTTP 404/],
      [{ body: { status: false, error: "not allowed" } }, /not allowed/],
    ] as const) {
      const s = await startFixtureServer(() => answer);
      try {
        await expect(new SabDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(err);
      } finally {
        await s.close();
      }
    }
  });

  it("names the NZB key when it was entered instead of the API key", async () => {
    const s = await startFixtureServer(() => ({ body: { auth: "nzbkey" } }));
    try {
      await expect(new SabDriver(cfg(s.baseUrl), { ...timers, log }).test()).rejects.toThrow(/NZB key/);
    } finally {
      await s.close();
    }
  });

  it("reads the whole history again after a retry or a remove", async () => {
    const s = await sabServer();
    try {
      const d = new SabDriver(cfg(s.baseUrl), { ...timers, log });
      const lastUpdate = (): string | null =>
        new URLSearchParams(
          s.calls.filter(c => new URLSearchParams(c.query).get("mode") === "history").at(-1)?.query,
        ).get("last_history_update");
      const snap = await d.poll();
      await d.poll();
      expect(lastUpdate()).not.toBe("0");
      await d.command({ kind: "extra", name: "retry", key: snap.items[0].key });
      await d.poll();
      expect(lastUpdate()).toBe("0");
      await d.poll();
      await d.command({ kind: "remove", key: snap.items[0].key });
      await d.poll();
      expect(lastUpdate()).toBe("0");
    } finally {
      await s.close();
    }
  });
});

describe("SABnzbd pause for post-processing, from the program (final review M5)", () => {
  it("reads pp_pause_event and keeps the pause switch off", async () => {
    const s = await startFixtureServer(call => {
      const q = new URLSearchParams(call.query);
      if (q.get("mode") === "queue") {
        return { body: { queue: { paused: true, slots: [] } } };
      }
      if (q.get("mode") === "status") {
        return { body: { status: { pp_pause_event: true } } };
      }
      return { body: { history: false } };
    });
    try {
      expect((await new SabDriver(cfg(s.baseUrl), { ...timers, log }).poll()).status.paused).toBe(false);
    } finally {
      await s.close();
    }
  });
});
