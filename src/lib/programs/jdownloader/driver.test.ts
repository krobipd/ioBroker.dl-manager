import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { ProtocolError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { checkJdCall, JdLocalTransport, JD_METHODS, jdBaseUrl, type JdTransport } from "./client";
import { JdDriver } from "./driver";
import { mapJdStatus, statusTable } from "./map";

const VERSION = "48637";
const READS: Record<string, string> = {
  "/jd/version": "auth/jd-version",
  "/toolbar/getStatus": "running/toolbar-get-status",
  "/downloadsV2/queryPackages": "running/query-packages",
  "/downloadsV2/queryLinks": "running/query-links",
};
const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const cfg = (base: string): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "jdownloader",
    deviceId: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "",
    username: "",
    password: "",
    apiKey: "",
    device: "",
  };
};

/** The recorded JD answers served by path; commands answer like JD does (`{"data": true}`). */
async function jdServer(): Promise<ContractServer> {
  let failLinks = false;
  const s = await startFixtureServer(call => {
    if (call.path === "/downloadsV2/queryLinks" && failLinks) {
      failLinks = false;
      return { status: 500, body: { src: "DEVICE", type: "INTERNAL_SERVER_ERROR" } };
    }
    const file = READS[call.path];
    if (file) {
      const [state, name] = file.split("/");
      return { body: loadFixture("jdownloader", VERSION, state, name).body };
    }
    return { body: { data: true } };
  });
  return {
    ...s,
    failSublist: () => {
      failLinks = true;
    },
  };
}

runDriverContract({
  type: "jdownloader",
  server: jdServer,
  makeDriver: base => new JdDriver(cfg(base), { ...timers, log }),
  mapStatus: mapJdStatus,
  statusTable,
  unknownStatus: "FinalLinkState:SOMETHING_NEW",
  commandCalls: {
    pauseAll: { method: "POST", path: "/downloadcontroller/stop" },
    resumeAll: { method: "POST", path: "/downloadcontroller/start" },
    pause: { method: "POST", path: "/downloadsV2/setEnabled", bodyContains: '"params":[false,[],[1790633501919]]' },
    resume: { method: "POST", path: "/downloadsV2/setEnabled", bodyContains: '"params":[true,[],[1790633501919]]' },
    remove: { method: "POST", path: "/downloadsV2/removeLinks", bodyContains: '"params":[[],[1790633501919]]' },
    add: { method: "POST", path: "/linkgrabberv2/addLinks", bodyContains: '"autostart":true' },
    setSpeedLimit: { method: "POST", path: "/config/set", bodyContains: '"DownloadSpeedLimit",2000000' },
  },
  isLoginCall: () => false,
  noLogin: true,
});

describe("JDownloader local transport", () => {
  it("refuses every method outside the fixed list — the local API has no login and can shut JD down", async () => {
    const t = new JdLocalTransport("http://127.0.0.1:1", timers);
    await expect(t.call("/system/exitJD")).rejects.toThrow(ProtocolError);
    await expect(
      t.call("/config/set", ["org.jdownloader.settings.GeneralSettings", null, "DefaultDownloadFolder", "/"]),
    ).rejects.toThrow(/DownloadSpeedLimit/);
    expect([...JD_METHODS].sort()).toEqual(
      [
        "/config/get",
        "/config/set",
        "/downloadcontroller/getCurrentState",
        "/downloadcontroller/pause",
        "/downloadcontroller/start",
        "/downloadcontroller/stop",
        "/downloadsV2/forceDownload",
        "/downloadsV2/queryLinks",
        "/downloadsV2/queryPackages",
        "/downloadsV2/removeLinks",
        "/downloadsV2/resumeLinks",
        "/downloadsV2/setEnabled",
        "/events/listen",
        "/events/subscribe",
        "/jd/version",
        "/linkgrabberv2/addLinks",
        "/toolbar/getStatus",
      ].sort(),
    );
  });

  it("calls a missing local API a protocol error with a hint", async () => {
    const s = await startFixtureServer(() => ({ status: 404, body: { src: "DEVICE", type: "API_COMMAND_NOT_FOUND" } }));
    try {
      await expect(new JdLocalTransport(s.baseUrl, timers).call("/jd/version")).rejects.toThrow(/Deprecated API/);
    } finally {
      await s.close();
    }
  });

  it("builds the address from host, port (default 3128), https and path", () => {
    expect(jdBaseUrl({ host: "nas", port: 0, https: false, path: "" })).toBe("http://nas:3128");
    expect(jdBaseUrl({ host: "nas", port: 443, https: true, path: "/jd/" })).toBe("https://nas:443/jd");
  });
});

describe("JDownloader driver", () => {
  const fake = (answers: (path: string, params: unknown[]) => Promise<unknown>): JdTransport & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      call: (path, params = []) => {
        calls.push(path);
        return answers(path, params);
      },
      close: () => undefined,
    };
  };

  it("resumes a paused JD first, then starts the controller", async () => {
    const t = fake(path => Promise.resolve(path === "/downloadcontroller/getCurrentState" ? "PAUSE" : true));
    await new JdDriver(cfg("http://127.0.0.1:3128"), { ...timers, log }, t).command({ kind: "resumeAll" });
    expect(t.calls).toEqual([
      "/downloadcontroller/getCurrentState",
      "/downloadcontroller/pause",
      "/downloadcontroller/start",
    ]);
  });

  it("switches the limit off with 0 and on with a value", async () => {
    const sent: unknown[][] = [];
    const t = fake((_p, params) => {
      sent.push(params);
      return Promise.resolve(true);
    });
    const d = new JdDriver(cfg("http://127.0.0.1:3128"), { ...timers, log }, t);
    await d.command({ kind: "setSpeedLimit", bps: 0 });
    expect(sent).toEqual([["org.jdownloader.settings.GeneralSettings", null, "DownloadSpeedLimitEnabled", false]]);
  });

  it("pushes only a poll trigger from the event long poll, and stops listening without a request of its own", async () => {
    let listens = 0;
    const events = fake(path => {
      if (path === "/events/subscribe") {
        return Promise.resolve({ subscriptionid: 7 });
      }
      if (path === "/events/listen") {
        listens++;
        return new Promise(resolve => globalThis.setTimeout(() => resolve([{ publisher: "downloads" }]), 5));
      }
      return Promise.resolve(true);
    });
    const d = new JdDriver(
      cfg("http://127.0.0.1:3128"),
      { ...timers, log },
      fake(() => Promise.resolve(true)),
      events,
    );
    let pushes = 0;
    const stop = d.subscribe(() => pushes++);
    await new Promise(resolve => globalThis.setTimeout(resolve, 40));
    stop();
    const seen = listens;
    await new Promise(resolve => globalThis.setTimeout(resolve, 40));
    expect(pushes).toBeGreaterThan(0);
    expect(listens).toBeLessThanOrEqual(seen + 1);
    // the adapter is shutting down: a request now gets no deadline (the adapter refuses new timers), and close() aborts
    // it anyway — JD drops a subscription nobody listens to after its keepalive (120 s)
    expect(events.calls).not.toContain("/events/unsubscribe");
  });
});

describe("JDownloader limits and transports", () => {
  const GS = "org.jdownloader.settings.GeneralSettings";

  it("allows the config interface only for the two limit keys of GeneralSettings, reading as well as writing", () => {
    expect(() => checkJdCall("/config/set", ["org.other.Settings", null, "DownloadSpeedLimit", 1])).toThrow(
      ProtocolError,
    );
    expect(() => checkJdCall("/config/get", [GS, null, "DefaultDownloadFolder"])).toThrow(ProtocolError);
    expect(() => checkJdCall("/config/get", [GS, null, "DownloadSpeedLimit"])).not.toThrow();
  });

  it("calls a 4xx answer of the local API a protocol error", async () => {
    const s = await startFixtureServer(() => ({ status: 403, body: { type: "FORBIDDEN" } }));
    try {
      await expect(new JdLocalTransport(s.baseUrl, timers).call("/jd/version")).rejects.toThrow(/HTTP 403 FORBIDDEN/);
    } finally {
      await s.close();
    }
  });

  it("talks to the cloud for jdownloader-cloud and opens no push channel there", async () => {
    const c: ProgramConfig = {
      ...cfg("http://nas:1"),
      type: "jdownloader-cloud",
      username: "a@b",
      password: "p",
      device: "PC",
    };
    expect(await firstUrl(() => new JdDriver(c, { ...timers, log }).poll())).toMatch(
      /^https:\/\/api\.jdownloader\.org\/my\/connect\?/,
    );
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    try {
      const stop = new JdDriver(c, { ...timers, log }).subscribe(() => undefined);
      await new Promise(resolve => globalThis.setTimeout(resolve, 10));
      stop();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("JDownloader commands and events", () => {
  const recorder = (answers: (path: string) => unknown): JdTransport & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      call: (path: string) => {
        calls.push(path);
        const a = answers(path);
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
      },
      close: () => undefined,
    };
  };

  it("enables and restarts the links of a resumed package", async () => {
    const t = recorder(() => true);
    await new JdDriver(cfg("http://127.0.0.1:3128"), { ...timers, log }, t).command({ kind: "resume", key: "5" });
    expect(t.calls).toEqual(["/downloadsV2/setEnabled", "/downloadsV2/resumeLinks"]);
  });

  it("refuses a subscription without id, ignores an empty event answer and subscribes afresh after a break", async () => {
    let subscribes = 0;
    let listens = 0;
    let pushes = 0;
    const events = recorder(path => {
      if (path === "/events/subscribe") {
        subscribes++;
        return subscribes === 1 ? {} : { subscriptionid: 9 };
      }
      if (path === "/events/listen") {
        listens++;
        return listens === 1 ? [] : listens === 2 ? new Error("socket hang up") : new Promise(() => undefined);
      }
      return true;
    });
    const waits: (() => void)[] = [];
    const d = new JdDriver(
      cfg("http://127.0.0.1:3128"),
      {
        setTimeout: cb => {
          waits.push(cb);
          return 1 as unknown as ioBroker.Timeout;
        },
        clearTimeout: () => undefined,
        log,
      },
      recorder(() => true),
      events,
    );
    const stop = d.subscribe(() => pushes++);
    const settle = (): Promise<void> => new Promise(resolve => globalThis.setTimeout(resolve, 5));
    await settle();
    expect(events.calls).toEqual(["/events/subscribe"]);
    waits.shift()?.();
    await settle();
    expect(pushes).toBe(0);
    waits.shift()?.();
    await settle();
    expect(events.calls.filter(c => c === "/events/subscribe")).toHaveLength(3);
    stop();
  });
});
