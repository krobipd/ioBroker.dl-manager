import { runDriverContract } from "../../../../test/helpers/contract";
import { startFixtureServer, type FixtureAnswer, type RecordedCall } from "../../../../test/helpers/fixture-server";
import { firstUrl } from "../../../../test/helpers/first-url";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { memoryPauseStore, type PauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { ProgramConfig } from "../../core/model";
import { reasonOf } from "./client";
import { TblDriver } from "./driver";
import { mapTblStatus, statusTable } from "./map";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const cfg = (base: string, key = "good"): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "tribler",
    deviceId: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "",
    username: "",
    password: "",
    apiKey: key,
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
  const f = loadFixture("tribler", version, state, name);
  return { status: f.status, body: f.body, headers: f.headers };
};

/**
 * @param version recorded version
 * @param state state folder
 * @returns the recorded downloads
 */
const downloadsOf = (version: string, state: string): { name: string; infohash: string; status: string }[] =>
  (loadFixture("tribler", version, state, "downloads").body as { downloads: [] }).downloads;

/**
 * @param version recorded version
 * @param name torrent of the recorder
 * @returns its info hash
 */
const hashOf = (version: string, name: string): string => {
  const d = downloadsOf(version, "added").find(x => x.name === name);
  if (!d) {
    throw new Error(`no ${name} in ${version}`);
  }
  return d.infohash;
};

/** What the recorded Tribler answers; the test changes it between calls. */
interface TblState {
  /** State folder of `GET /api/downloads`. */
  downloads: string;
  /** State folder of `GET /api/settings`, default the one of the downloads. */
  settings?: string;
  /** The answer of `PUT /api/downloads`, default the recorded add of a magnet. */
  add?: FixtureAnswer;
}

/** Requests Tribler answered with 401 — the key goes with every request. */
const rejected = new Set<RecordedCall>();

/**
 * Tribler from the recordings: the key in X-Api-Key on every request, reads by route, commands on a listed download
 * answered as recorded, on any other as Tribler answers an unknown one.
 *
 * @param version recorded version
 * @param state the answers, read at every request
 * @returns the running server
 */
async function tblServer(version: string, state: TblState): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  return startFixtureServer(call => {
    if (call.headers["x-api-key"] !== "good") {
      rejected.add(call);
      return recorded(version, "auth", call.headers["x-api-key"] ? "downloads-wrong-key" : "downloads-no-key");
    }
    const listed = (h: string): boolean => downloadsOf(version, state.downloads).some(d => d.infohash === h);
    const one = /^\/api\/downloads\/([0-9a-f]{40})$/.exec(call.path);
    switch (`${call.method} ${one ? "/api/downloads/<hash>" : call.path}`) {
      case "GET /api/versioning/versions/current":
        return recorded(version, "auth", "version");
      case "GET /api/downloads":
        return recorded(version, state.downloads, "downloads");
      case "GET /api/settings":
        return recorded(version, state.settings ?? state.downloads, "settings");
      case "PUT /api/downloads":
        return call.body.includes('"uri"')
          ? (state.add ?? recorded(version, "commands", "put-uri"))
          : recorded(version, "commands", "put-no-uri");
      case "PATCH /api/downloads/<hash>":
        return listed(one?.[1] ?? "")
          ? recorded(version, "commands", "patch-resume")
          : recorded(version, "commands", "patch-unknown");
      case "DELETE /api/downloads/<hash>":
        return listed(one?.[1] ?? "")
          ? recorded(version, "commands", "delete")
          : recorded(version, "commands", "delete-unknown");
      case "POST /api/settings":
        return recorded(version, "commands", "settings-limits");
      default:
        return { status: 404, body: "" };
    }
  });
}

/** The first download of the 8.4.2 `running` recording — the contract pauses it, and the global pause stops it first. */
const FIRST = downloadsOf("8.4.2", "running")[0].infohash;

runDriverContract({
  type: "tribler",
  server: () => tblServer("8.4.2", { downloads: "running" }),
  makeDriver: (base, creds) => new TblDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }),
  mapStatus: mapTblStatus,
  statusTable,
  unknownStatus: "FROZEN",
  commandCalls: {
    pauseAll: { method: "PATCH", path: `/api/downloads/${FIRST}`, bodyContains: '"state":"stop"' },
    resumeAll: { method: "PATCH", path: `/api/downloads/${FIRST}`, bodyContains: '"state":"resume"' },
    pause: { method: "PATCH", path: `/api/downloads/${FIRST}`, bodyContains: '"state":"stop"' },
    resume: { method: "PATCH", path: `/api/downloads/${FIRST}`, bodyContains: '"state":"resume"' },
    remove: { method: "DELETE", path: `/api/downloads/${FIRST}`, bodyContains: '"remove_data":false' },
    add: { method: "PUT", path: "/api/downloads", bodyContains: '{"uri":"magnet:?xt=urn:btih:' },
    setSpeedLimit: { method: "POST", path: "/api/settings", bodyContains: '"max_download_rate":2000000' },
    setUploadLimit: { method: "POST", path: "/api/settings", bodyContains: '"max_upload_rate":2000000' },
  },
  removeWithFiles: { method: "DELETE", path: `/api/downloads/${FIRST}`, bodyContains: '"remove_data":true' },
  isLoginCall: call => rejected.has(call),
});

/**
 * @param s the server
 * @param s.calls the requests it saw
 * @returns every PATCH as `<hash> <state>`
 */
const patches = (s: { calls: RecordedCall[] }): string[] =>
  s.calls
    .filter(c => c.method === "PATCH")
    .map(c => `${c.path.split("/").pop()} ${(JSON.parse(c.body) as { state: string }).state}`);

describe("Tribler driver — a stop right after the add", () => {
  /**
   * The driver adds while the adapter holds the program paused, then polls the recorded states that followed the
   * recorder's add and stop of stopped.bin.
   *
   * @param version recorded version
   * @param states the states polled one after the other
   * @returns the PATCHes after the add's own stop, the pause after every poll and the store
   */
  async function addWhilePaused(
    version: string,
    states: string[],
  ): Promise<{ later: string[]; paused: boolean[]; store: PauseStore }> {
    const stopped = hashOf(version, "stopped.bin");
    const state: TblState = { downloads: "added", add: { body: { started: true, infohash: stopped } } };
    const s = await tblServer(version, state);
    const store = memoryPauseStore({ paused: true, keys: [] });
    try {
      const d = new TblDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.command({ kind: "add", url: "magnet:?xt=urn:btih:stopped" });
      expect(patches(s)).toEqual([`${stopped} stop`]);
      const from = patches(s).length;
      const paused: boolean[] = [];
      for (const st of states) {
        state.downloads = st;
        paused.push((await d.poll()).status.paused);
      }
      return { later: patches(s).slice(from), paused, store };
    } finally {
      await s.close();
    }
  }

  /**
   * @param version recorded version
   * @param state state folder
   * @returns the status of stopped.bin in that recording
   */
  const stoppedBin = (version: string, state: string): string | undefined =>
    downloadsOf(version, state).find(d => d.name === "stopped.bin")?.status;

  it("holds the download and stops it again when the first stop did not reach it", async () => {
    // the `lost-*` recordings of 8.4.2: the same add and stop, from a run where the stop came before the handle and
    // Tribler started the download anyway
    expect(["lost-added", "lost-early-stop", "lost-running"].map(st => stoppedBin("8.4.2", st))).toEqual([
      "STOPPED",
      "DOWNLOADING",
      "STOPPED",
    ]);
    const stopped = hashOf("8.4.2", "stopped.bin");
    const { later, paused, store } = await addWhilePaused("8.4.2", ["lost-added", "lost-early-stop", "lost-running"]);
    // `lost-added`: stopped — nothing to do; `lost-early-stop`: running with its handle — stopped again;
    // `lost-running`: stopped, the pause holds on
    expect(later).toEqual([`${stopped} stop`]);
    expect(paused).toEqual([true, true, true]);
    expect(await store.load()).toEqual({ paused: true, keys: [stopped] });
  });

  it("leaves a download alone whose first stop held, and keeps the pause", async () => {
    for (const v of ["8.0.7", "8.4.2"]) {
      expect([v, ...["added", "early-stop", "running"].map(st => stoppedBin(v, st))]).toEqual([
        v,
        "STOPPED",
        "STOPPED",
        "STOPPED",
      ]);
      const { later, paused } = await addWhilePaused(v, ["added", "early-stop", "running"]);
      expect(later).toEqual([]);
      expect(paused).toEqual([true, true, true]);
    }
  });

  it("ends the pause when the user starts the download himself after it was stopped again", async () => {
    // after the second stop the download runs once more: that is the user's start now
    const { later, paused, store } = await addWhilePaused("8.4.2", [
      "lost-early-stop",
      "lost-running",
      "lost-early-stop",
    ]);
    expect(later).toHaveLength(1);
    expect(paused).toEqual([true, true, false]);
    expect(await store.load()).toEqual({ paused: false, keys: [] });
  });
});

/**
 * @param infohash the key
 * @param status Tribler's status name
 * @param progress 0…1
 * @returns a download in the shape of `GET /api/downloads`
 */
const row = (infohash: string, status: string, progress = 0.5): Record<string, unknown> => ({
  infohash,
  name: infohash,
  status,
  progress,
  size: 1000,
  speed_down: status === "DOWNLOADING" ? 100 : 0,
});

/** What a synthetic Tribler answers; the test changes it between calls. */
interface SynthState {
  downloads: unknown[];
  settings?: Record<string, unknown>;
  /** Hashes a PATCH is answered for as Tribler answers a download it does not know (recorded `patch-unknown`). */
  unknown?: string[];
}

/**
 * @param state the answers, read at every request
 * @returns the running server
 */
async function tblSynth(state: SynthState): Promise<Awaited<ReturnType<typeof startFixtureServer>>> {
  return startFixtureServer(call => {
    switch (`${call.method} ${call.path.replace(/[0-9a-z]{40}$/, "<hash>")}`) {
      case "GET /api/versioning/versions/current":
        return { body: { version: "8.4.2" } };
      case "GET /api/downloads":
        return { body: { downloads: state.downloads, checkpoints: {} } };
      case "GET /api/settings":
        return { body: { settings: state.settings ?? { libtorrent: { max_download_rate: 0, max_upload_rate: 0 } } } };
      case "PATCH /api/downloads/<hash>":
        return state.unknown?.some(h => call.path.endsWith(h))
          ? recorded("8.4.2", "commands", "patch-unknown")
          : { body: { modified: true } };
      default:
        return { body: { modified: true } };
    }
  });
}

describe("Tribler driver details", () => {
  it("stops every running download, one waiting for its circuits too, which then never ends the pause", async () => {
    const [a, b, c, e] = ["a", "b", "c", "e"].map(x => x.repeat(40));
    const state: SynthState = {
      downloads: [row(a, "DOWNLOADING"), row(b, "STOPPED"), row(c, "EXIT_NODES"), row(e, "STOPPED_ON_ERROR")],
    };
    const s = await tblSynth(state);
    const store = memoryPauseStore();
    try {
      const d = new TblDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      expect(patches(s)).toEqual([`${a} stop`, `${c} stop`]);
      // a stopped; c still without its handle, then running with it: stopped again, the pause holds
      state.downloads = [row(a, "STOPPED"), row(b, "STOPPED"), row(c, "EXIT_NODES"), row(e, "STOPPED_ON_ERROR")];
      expect((await d.poll()).status.paused).toBe(true);
      expect((await d.poll()).status.paused).toBe(true);
      state.downloads = [row(a, "STOPPED"), row(b, "STOPPED"), row(c, "METADATA"), row(e, "STOPPED_ON_ERROR")];
      expect((await d.poll()).status.paused).toBe(true);
      expect(patches(s)).toEqual([`${a} stop`, `${c} stop`, `${c} stop`]);
      await d.command({ kind: "resumeAll" });
      expect(patches(s).slice(3)).toEqual([`${a} resume`, `${c} resume`]);
      expect(await store.load()).toEqual({ paused: false, keys: [] });
    } finally {
      await s.close();
    }
  });

  it("stops the others when Tribler refuses one that ended meanwhile, and resumes exactly those (K4)", async () => {
    const [a, gone, c] = ["a", "b", "c"].map(x => x.repeat(40));
    const state: SynthState = {
      downloads: [row(a, "DOWNLOADING"), row(gone, "DOWNLOADING"), row(c, "DOWNLOADING")],
      unknown: [gone],
    };
    const s = await tblSynth(state);
    const store = memoryPauseStore();
    try {
      const d = new TblDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: store });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      expect(await store.load()).toEqual({ paused: true, keys: [a, c] });
      // one gone before the resume is skipped too — the others still start
      state.unknown = [a];
      await d.command({ kind: "resumeAll" });
      expect(patches(s).filter(p => p.endsWith("resume"))).toEqual([`${a} resume`, `${c} resume`]);
      expect(await store.load()).toEqual({ paused: false, keys: [] });
    } finally {
      await s.close();
    }
  });

  it("stops a download waiting for its circuits again only while the pause holds, and forgets one that is gone", async () => {
    const [a, c, g] = ["a", "c", "g"].map(x => x.repeat(40));
    const state: SynthState = { downloads: [row(a, "DOWNLOADING"), row(c, "EXIT_NODES"), row(g, "CIRCUITS")] };
    const s = await tblSynth(state);
    try {
      const d = new TblDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: memoryPauseStore() });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      expect(patches(s)).toEqual([`${a} stop`, `${c} stop`, `${g} stop`]);
      // g leaves the list while it has no handle: nothing to stop again
      state.downloads = [row(a, "STOPPED"), row(c, "EXIT_NODES")];
      expect((await d.poll()).status.paused).toBe(true);
      // the user starts a himself: the pause ends while c still waits for its circuits
      state.downloads = [row(a, "DOWNLOADING"), row(c, "EXIT_NODES")];
      expect((await d.poll()).status.paused).toBe(false);
      // c runs with its handle now, outside the pause — it is left alone
      state.downloads = [row(a, "DOWNLOADING"), row(c, "DOWNLOADING")];
      expect((await d.poll()).status.paused).toBe(false);
      expect(patches(s)).toHaveLength(3);
    } finally {
      await s.close();
    }
  });

  it("ends the pause when the user starts a download the pause stopped with its handle", async () => {
    const a = "a".repeat(40);
    const state: SynthState = { downloads: [row(a, "SEEDING", 1)] };
    const s = await tblSynth(state);
    try {
      const d = new TblDriver(cfg(s.baseUrl), { ...timers, log, pauseStore: memoryPauseStore() });
      await d.poll();
      await d.command({ kind: "pauseAll" });
      state.downloads = [row(a, "STOPPED", 1)];
      expect((await d.poll()).status.paused).toBe(true);
      state.downloads = [row(a, "SEEDING", 1)];
      expect((await d.poll()).status.paused).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("writes the whole libtorrent section back with one rate changed — 8.0.7 keeps only what the body carries", async () => {
    const settings = loadFixture("tribler", "8.0.7", "empty", "settings").body as {
      settings: { libtorrent: Record<string, unknown> };
    };
    // the recorded proof: a body with one value left 8.0.7 one key of its libtorrent section
    const partial = loadFixture("tribler", "8.0.7", "partial", "settings").body as typeof settings;
    expect(Object.keys(partial.settings.libtorrent)).toEqual(["max_download_rate"]);
    const s = await tblSynth({ downloads: [], settings: settings.settings });
    try {
      const d = new TblDriver(cfg(s.baseUrl), { ...timers, log });
      await d.command({ kind: "setSpeedLimit", bps: 102400 });
      await d.command({ kind: "setUploadLimit", bps: -5 });
      const posts = s.calls.filter(c => c.method === "POST").map(c => JSON.parse(c.body) as typeof settings.settings);
      expect(posts).toEqual([
        { libtorrent: { ...settings.settings.libtorrent, max_download_rate: 102400 } },
        { libtorrent: { ...settings.settings.libtorrent, max_upload_rate: 0 } },
      ]);
    } finally {
      await s.close();
    }
  });

  it("adds the uri alone and reports Tribler's reason when it refuses the add", async () => {
    const s = await tblServer("8.4.2", { downloads: "running", add: recorded("8.4.2", "commands", "put-no-uri") });
    try {
      const d = new TblDriver(cfg(s.baseUrl), { ...timers, log });
      await expect(d.command({ kind: "add", url: "https://example.org/x.torrent" })).rejects.toThrow(
        /HTTP 400 \(uri parameter missing\)/,
      );
      expect(s.calls.find(c => c.method === "PUT")?.body).toBe('{"uri":"https://example.org/x.torrent"}');
    } finally {
      await s.close();
    }
  });

  it("refuses a command on a download Tribler does not know with its text, and keeps the files on remove", async () => {
    const s = await tblServer("8.4.2", { downloads: "running" });
    try {
      const d = new TblDriver(cfg(s.baseUrl), { ...timers, log });
      await expect(d.command({ kind: "pause", key: "0".repeat(40) })).rejects.toThrow(
        /HTTP 404 \(this download does not exist\)/,
      );
      await expect(d.command({ kind: "remove", key: "0".repeat(40) })).rejects.toThrow(ProtocolError);
      expect(s.calls.filter(c => c.method === "DELETE").map(c => c.body)).toEqual(['{"remove_data":false}']);
    } finally {
      await s.close();
    }
  });

  it("refuses a download list with an empty entry or a download without its hash (fleet C26b)", async () => {
    for (const odd of [null, { infohash: 7, status: "SEEDING" }]) {
      const s = await tblSynth({ downloads: [odd, row("h".repeat(40), "SEEDING")] });
      try {
        await expect(new TblDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(ProtocolError);
      } finally {
        await s.close();
      }
    }
  });

  it("asks Sonarr's default port without a path and sends the key in X-Api-Key", async () => {
    expect(await firstUrl(() => new TblDriver({ ...cfg("http://nas:1"), port: 0 }, { ...timers, log }).poll())).toBe(
      "http://nas:20100/api/versioning/versions/current",
    );
    const s = await tblSynth({ downloads: [] });
    try {
      await new TblDriver(cfg(s.baseUrl), { ...timers, log }).poll();
      expect(s.calls.every(c => c.headers["x-api-key"] === "good")).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe("Tribler refusal text", () => {
  it("reads the message of an error object, an error that is plain text as it is, and nothing from a body without JSON", () => {
    expect(reasonOf('{"error": {"handled": true, "message": "uri parameter missing"}}')).toBe("uri parameter missing");
    expect(reasonOf('{"error": "busy"}')).toBe("busy");
    expect(reasonOf("<html>bad gateway</html>")).toBe("");
  });
});
