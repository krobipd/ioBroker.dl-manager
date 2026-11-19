import { runDriverContract } from "../../../../test/helpers/contract";
import {
  startFixtureServer,
  type FixtureAnswer,
  type FixtureServer,
  type RecordedCall,
} from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore } from "../../core/emulated-pause";
import { AuthError, ProtocolError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { RtDriver } from "./driver";
import { FIELDS, mapRtStatus, statusTable } from "./map";
import { methodCall, parseResponse, type RpcParam } from "./xmlrpc";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const cfg = (base: string, pass = "good"): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "rtorrent",
    deviceId: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "/RPC2",
    username: "admin",
    password: pass,
    apiKey: "",
    device: "",
  };
};

/**
 * @param version recorded version
 * @param state state folder
 * @param name file name
 * @returns the recording as the fixture server's answer
 */
const recorded = (version: string, state: string, name: string): FixtureAnswer => {
  const f = loadFixture("rtorrent", version, state, name);
  return { status: f.status, body: f.body, headers: f.headers };
};

/**
 * @param value the result
 * @returns a methodResponse carrying it, written by the driver's own encoder
 */
const answer = (value: RpcParam): FixtureAnswer => ({
  headers: { "content-type": "text/xml" },
  body: methodCall("", [value])
    .replace("<methodCall><methodName></methodName>", "<methodResponse>")
    .replace("</methodCall>", "</methodResponse>"),
});

/**
 * @param call a request
 * @returns its method and the text parameters of the call (the hash of a d.* command)
 */
function rpcOf(call: RecordedCall): { method: string; strings: string[]; inner: string[] } {
  const method = /<methodName>([^<]*)<\/methodName>/.exec(call.body)?.[1] ?? "";
  const strings = [...call.body.matchAll(/<value><string>([^<]*)<\/string><\/value>/g)].map(m => m[1]);
  const inner = [...call.body.matchAll(/<name>methodName<\/name><value><string>([^<]*)<\/string>/g)].map(m => m[1]);
  return { method, strings, inner };
}

/**
 * @param s a fixture server
 * @returns every call after the version and the poll, as `method args`
 */
const sent = (s: FixtureServer): string[] =>
  s.calls
    .map(rpcOf)
    .filter(c => c.method !== "system.client_version" && !c.inner.includes("d.multicall2"))
    .map(c =>
      c.method === "system.multicall" ? `multicall ${c.strings.join(" ")}` : `${c.method} ${c.strings.join(" ")}`,
    );

/**
 * @param version recorded version
 * @param state state folder
 * @returns hash and name of every torrent of that poll
 */
const hashesOf = (version: string, state: string): [string, string][] =>
  (
    (parseResponse(loadFixture("rtorrent", version, state, "poll").body as string) as unknown[][])[4][0] as unknown[][]
  ).map(r => [r[0] as string, r[1] as string]);
/**
 * @param version recorded version
 * @param state state folder
 * @param prefix start of the torrent's name
 * @returns the hash of the first torrent whose name starts so
 */
const hashOf = (version: string, state: string, prefix: string): string =>
  hashesOf(version, state).find(([, n]) => n.startsWith(prefix))?.[0] ?? "";
/** The torrents of the 0.16.25 running recording. */
const RUNNING = hashesOf("0.16.25", "running").map(([h]) => h);
/** The first torrent of the list — started and active, the contract pauses it and the global pause stops it first. */
const FIRST = RUNNING[0];

/** Requests answered with 401 — rTorrent's "login" is the web server's basic auth on every request. */
const rejected = new Set<RecordedCall>();

/**
 * rTorrent from the recordings: basic auth on every request, every call by its method name.
 *
 * @param version recorded version
 * @param state the state folder whose poll every poll answers
 * @returns the running server
 */
async function rtServer(
  version = "0.16.25",
  state = "running",
): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  const good = `Basic ${Buffer.from("admin:good").toString("base64")}`;
  const known = new Set(hashesOf(version, state).map(([h]) => h));
  return startFixtureServer(call => {
    if (call.headers.authorization !== good) {
      rejected.add(call);
      return recorded(version, "auth", call.headers.authorization ? "wrong" : "no-auth");
    }
    const { method, strings, inner } = rpcOf(call);
    switch (method) {
      case "system.client_version":
        return recorded(version, "auth", "version");
      case "system.multicall":
        return inner.includes("d.multicall2") ? recorded(version, state, "poll") : answer(inner.map(() => [0]));
      case "d.stop":
      case "d.start":
      case "d.resume":
      case "d.erase":
        return known.has(strings[0])
          ? recorded(version, "commands", "d-stop")
          : recorded(version, "commands", "d-unknown");
      case "load.start":
      case "load.normal":
        return recorded(version, "commands", "load-start");
      case "throttle.global_down.max_rate.set":
      case "throttle.global_up.max_rate.set":
        return recorded(version, "commands", "limit-down-set");
      default:
        return { status: 404, body: "" };
    }
  });
}

/**
 * @param method the method
 * @param args its arguments
 * @returns the request text a call carries
 */
const callText = (method: string, ...args: RpcParam[]): string =>
  methodCall(method, args).replace('<?xml version="1.0"?><methodCall>', "").replace("</params></methodCall>", "");

runDriverContract({
  type: "rtorrent",
  server: () => rtServer(),
  makeDriver: (base, creds) => new RtDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }),
  mapStatus: mapRtStatus,
  statusTable,
  unknownStatus: "frozen:left",
  commandCalls: {
    pauseAll: { method: "POST", path: "/RPC2", bodyContains: callText("d.stop", FIRST) },
    resumeAll: { method: "POST", path: "/RPC2", bodyContains: callText("d.start", FIRST) },
    pause: { method: "POST", path: "/RPC2", bodyContains: callText("d.stop", FIRST) },
    resume: { method: "POST", path: "/RPC2", bodyContains: callText("d.start", FIRST) },
    remove: { method: "POST", path: "/RPC2", bodyContains: callText("d.erase", FIRST) },
    add: {
      method: "POST",
      path: "/RPC2",
      bodyContains: callText("load.start", "", "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"),
    },
    setSpeedLimit: {
      method: "POST",
      path: "/RPC2",
      bodyContains: callText("throttle.global_down.max_rate.set", "", 2e6),
    },
    setUploadLimit: {
      method: "POST",
      path: "/RPC2",
      bodyContains: callText("throttle.global_up.max_rate.set", "", 2e6),
    },
  },
  isLoginCall: call => rejected.has(call),
});

/** One torrent of a synthetic poll. */
interface Row {
  hash: string;
  state?: number;
  open?: number;
  active?: number;
  /** `d.hashing` — non-zero while a hash check waits or runs. */
  hashing?: number;
  held?: string;
}

/**
 * @param r the torrent
 * @returns its row in the order of FIELDS
 */
const rowOf = (r: Row): RpcParam[] => [
  r.hash,
  r.hash,
  r.state ?? 1,
  r.open ?? 1,
  r.active ?? 1,
  0,
  r.hashing ?? 0,
  r.hashing ? 1 : 0,
  1000,
  500,
  10,
  0,
  0,
  0,
  1,
  "",
  "",
  1794710818,
  0,
  r.held ?? "",
];

/** What a synthetic rTorrent answers; the test changes it between calls. */
interface RtState {
  rows: Row[];
  /** The answer to a multicall that is no poll. */
  other?: FixtureAnswer;
  /** The answer to the poll in place of the rows. */
  poll?: FixtureAnswer;
}

/**
 * @param state the answers, read at every request
 * @returns the running server
 */
async function rtSynth(state: RtState): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  return startFixtureServer(call => {
    const { method, inner } = rpcOf(call);
    if (method === "system.client_version") {
      return answer("0.16.25");
    }
    if (method === "system.multicall" && inner.includes("d.multicall2")) {
      return state.poll ?? answer([[5], [6], [0], [0], [state.rows.map(rowOf)]]);
    }
    if (method === "system.multicall") {
      return state.other ?? answer(inner.map(() => [0]));
    }
    return answer(0);
  });
}

describe("rTorrent driver on 0.9.8", () => {
  it("polls the recorded answers of xmlrpc-c", async () => {
    const s = await rtServer("0.9.8");
    try {
      const snap = await new RtDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      expect(snap.status).toMatchObject({ version: "0.9.8", speedLimitBps: 0, uploadLimitBps: 0 });
      expect(snap.items.find(i => i.name === "big.bin")?.status).toBe("downloading");
    } finally {
      await s.close();
    }
  });
});

describe("rTorrent driver on the recorded pause, hash check and held magnet", () => {
  for (const version of ["0.9.8", "0.16.25"]) {
    it(`releases the torrent ${version} builds anew from a released magnet's metadata — stopped and marked again`, async () => {
      const s = await rtServer(version, "released");
      try {
        await new RtDriver(cfg(s.baseUrl), { ...timers, log }).poll();
        const h = hashOf(version, "released", "queued.bin");
        expect(h).toMatch(/^38B12B1A/);
        expect(sent(s)).toEqual([`multicall d.start ${h} d.custom.set ${h} dlm_held `]);
      } finally {
        await s.close();
      }
    });

    it(`takes the magnet ${version} added stopped and marked into a pause that lasts, without starting it`, async () => {
      const s = await rtServer(version, "held");
      const store = memoryPauseStore();
      await store.save({ paused: true, keys: [] });
      try {
        await new RtDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store }).poll();
        const h = hashOf(version, "held", "38B12B1A");
        expect(sent(s)).toEqual([`multicall d.custom.set ${h} dlm_held `]);
        expect((await store.load()).keys).toEqual([h]);
      } finally {
        await s.close();
      }
    });

    it(`stops the torrent in its hash check with the pause of everything on ${version}`, async () => {
      const s = await rtServer(version, "checking");
      try {
        const d = new RtDriver(cfg(s.baseUrl), { ...timers, log });
        await d.poll();
        await d.command({ kind: "pauseAll" });
        expect(sent(s)).toContain(`d.stop ${hashOf(version, "checking", "check.bin")}`);
      } finally {
        await s.close();
      }
    });

    it(`resumes the torrent d.pause halted on ${version} with d.resume — d.start leaves it inactive`, async () => {
      const s = await rtServer(version, "pausing");
      try {
        const d = new RtDriver(cfg(s.baseUrl), { ...timers, log });
        await d.poll();
        const h = hashOf(version, "pausing", "done.bin");
        await d.command({ kind: "resume", key: h });
        expect(sent(s)).toEqual([`d.resume ${h}`]);
      } finally {
        await s.close();
      }
    });
  }
});

describe("rTorrent driver details", () => {
  it("asks for the fields of the recorder in one multicall with the global rates and limits", async () => {
    const s = await rtSynth({ rows: [] });
    try {
      await new RtDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      const pollCall = s.calls.map(rpcOf).find(c => c.inner.includes("d.multicall2"));
      expect(pollCall?.inner).toEqual([
        "throttle.global_down.rate",
        "throttle.global_up.rate",
        "throttle.global_down.max_rate",
        "throttle.global_up.max_rate",
        "d.multicall2",
      ]);
      expect(pollCall?.strings.slice(-FIELDS.length - 1)).toEqual(["main", ...FIELDS]);
    } finally {
      await s.close();
    }
  });

  it("pauses only started torrents that run, adds a link stopped and marked meanwhile and resumes exactly these", async () => {
    const state: RtState = {
      rows: [
        { hash: "A" },
        { hash: "B", state: 0, active: 0 },
        { hash: "C", active: 0 },
        { hash: "D", open: 0, state: 0, active: 0 },
      ],
    };
    const s = await rtSynth(state);
    const store = memoryPauseStore();
    try {
      const d = new RtDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      await d.command({ kind: "add", url: "magnet:?xt=urn:btih:new" });
      state.rows = [{ hash: "A", state: 0, active: 0 }, ...state.rows.slice(1), { hash: "N", state: 0, held: "1" }];
      expect((await d.poll()).status.paused).toBe(true);
      expect(await store.load()).toEqual({ paused: true, keys: ["A", "N"] });
      await d.command({ kind: "resumeAll" });
      expect(sent(s)).toEqual([
        "d.stop A",
        "load.normal  magnet:?xt=urn:btih:new d.custom.set=dlm_held,1",
        "multicall d.custom.set N dlm_held ",
        "d.start A",
        "d.start N",
      ]);
    } finally {
      await s.close();
    }
  });

  it("takes a started torrent in its hash check into the pause — it starts by itself after the check", async () => {
    const s = await rtSynth({
      rows: [
        { hash: "K", active: 0, hashing: 3 },
        { hash: "W", state: 0, active: 0, hashing: 1 },
      ],
    });
    try {
      const d = new RtDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      expect(sent(s)).toEqual(["d.stop K"]);
    } finally {
      await s.close();
    }
  });

  it("resumes a torrent d.pause halted with d.resume, a stopped or closed one with d.start", async () => {
    const s = await rtSynth({
      rows: [
        { hash: "P", active: 0 },
        { hash: "S", state: 0, active: 0 },
        { hash: "C", open: 0, state: 0, active: 0 },
        { hash: "K", active: 0, hashing: 3 },
      ],
    });
    try {
      const d = new RtDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      for (const key of ["P", "S", "C", "K"]) {
        await d.command({ kind: "resume", key });
      }
      expect(sent(s)).toEqual(["d.resume P", "d.start S", "d.start C", "d.start K"]);
    } finally {
      await s.close();
    }
  });

  it("starts a torrent added during a pause that has ended since, and takes the mark off", async () => {
    const s = await rtSynth({ rows: [{ hash: "N", state: 0, active: 0, held: "1" }] });
    try {
      await new RtDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      expect(sent(s)).toEqual(["multicall d.start N d.custom.set N dlm_held "]);
    } finally {
      await s.close();
    }
  });

  it("keeps the poll when taking a mark off fails — the next poll takes it", async () => {
    const lines: string[] = [];
    const s = await rtSynth({
      rows: [{ hash: "N", state: 0, active: 0, held: "1" }],
      other: answer([{ faultCode: -501, faultString: "Could not find info-hash." }, [0]]),
    });
    try {
      const snap = await new RtDriver(cfg(s.baseUrl), {
        ...timers,
        log: { ...log, debug: (m: string) => lines.push(m) },
      }).poll();
      expect(snap.items.map(i => i.key)).toEqual(["N"]);
      expect(lines.join("\n")).toContain("Could not find info-hash.");
    } finally {
      await s.close();
    }
  });

  it("adds a link started while the program is not held, sets a limit and 0 for unlimited", async () => {
    const s = await rtSynth({ rows: [] });
    try {
      const d = new RtDriver(cfg(s.baseUrl), { ...timers, log });
      await d.command({ kind: "add", url: "https://example.org/x.torrent" });
      await d.command({ kind: "setSpeedLimit", bps: 2048000 });
      await d.command({ kind: "setUploadLimit", bps: 0 });
      expect(sent(s)).toEqual([
        "load.start  https://example.org/x.torrent",
        "throttle.global_down.max_rate.set ",
        "throttle.global_up.max_rate.set ",
      ]);
      expect(s.calls[1].body).toContain("<i4>2048000</i4>");
      expect(s.calls[2].body).toContain("<i4>0</i4>");
    } finally {
      await s.close();
    }
  });

  it("refuses a poll whose multicall lost a call, carries a fault, a row or the hash of a row", async () => {
    const shortRow = rowOf({ hash: "A" }).slice(0, -1);
    const noHash = rowOf({ hash: "A" });
    noHash[0] = 7;
    const polls: [FixtureAnswer, RegExp][] = [
      [answer([[5], [6], [0], [0]]), /answered 4 of 5 calls/],
      [answer([[5], [6], [0], [0], { faultCode: -506, faultString: "nope" }]), /d\.multicall2: nope/],
      [answer([[5], [6], [0], [0], [[shortRow]]]), /19 of 20 fields/],
      [answer([[5], [6], [0], [0], [[noHash]]]), /without its d\.hash/],
      [answer([[5], [6], [0], [0], ["x"]]), /torrent list is no list/],
    ];
    for (const [poll, text] of polls) {
      const s = await rtSynth({ rows: [], poll });
      try {
        await expect(new RtDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(text);
      } finally {
        await s.close();
      }
    }
  });

  it("refuses a cut answer and a web page, and calls the web server's 401 a rejected login", async () => {
    const whole = loadFixture("rtorrent", "0.16.25", "running", "poll").body as string;
    const cases: [FixtureAnswer, new (...a: never[]) => Error][] = [
      [{ body: whole.slice(0, whole.length - 40) }, ProtocolError],
      [{ body: "<html><body>ruTorrent</body></html>" }, ProtocolError],
      [recorded("0.16.25", "auth", "wrong"), AuthError],
    ];
    for (const [poll, kind] of cases) {
      const s = await rtSynth({ rows: [], poll });
      try {
        await expect(new RtDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toBeInstanceOf(kind);
      } finally {
        await s.close();
      }
    }
  });

  it("names the HTTP status of the web server in front of rTorrent, and calls its 403 a rejected login", async () => {
    const cases: [FixtureAnswer, RegExp | typeof AuthError][] = [
      [{ status: 500, body: "<html><body>Internal Server Error</body></html>" }, /XML-RPC answered HTTP 500/],
      [{ status: 403, body: "" }, AuthError],
    ];
    for (const [poll, expected] of cases) {
      const s = await rtSynth({ rows: [], poll });
      try {
        await expect(new RtDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(expected);
      } finally {
        await s.close();
      }
    }
  });

  it("names rTorrent's text when it does not know a torrent", async () => {
    const s = await rtServer();
    try {
      await expect(
        new RtDriver(cfg(s.baseUrl), { ...timers, log }).command({ kind: "pause", key: "0".repeat(40) }),
      ).rejects.toThrow(/info-hash not found/);
    } finally {
      await s.close();
    }
  });

  it("reads the version once and again after a failed poll", async () => {
    const state: RtState = { rows: [] };
    const s = await rtSynth(state);
    const versions = (): number => s.calls.filter(c => rpcOf(c).method === "system.client_version").length;
    try {
      const d = new RtDriver(cfg(s.baseUrl), { ...timers, log });
      await d.poll();
      await d.poll();
      expect(versions()).toBe(1);
      state.poll = { body: "<methodResponse>" };
      await expect(d.poll()).rejects.toThrow(ProtocolError);
      state.poll = undefined;
      await d.poll();
      expect(versions()).toBe(2);
    } finally {
      await s.close();
    }
  });

  it("asks the default port and path, sends basic auth only with a user", async () => {
    expect(
      await firstUrl(() => new RtDriver({ ...cfg("http://nas:1"), port: 0, path: "" }, { ...timers, log }).poll()),
    ).toBe("http://nas:8080/RPC2");
    const s = await rtSynth({ rows: [] });
    try {
      await new RtDriver({ ...cfg(s.baseUrl), username: "", password: "" }, { ...timers, log }).poll();
      expect(s.calls.every(c => c.headers.authorization === undefined)).toBe(true);
      expect(s.calls.every(c => c.headers["content-type"] === "text/xml")).toBe(true);
    } finally {
      await s.close();
    }
  });
});
