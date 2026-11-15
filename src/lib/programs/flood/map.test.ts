import { loadFixture } from "../../../../test/helpers/fixtures";
import {
  isLoading,
  isRunning,
  limitBps,
  mapFloodStatus,
  rawStatus,
  statusTable,
  toSnapshot,
  type FloodTorrent,
} from "./map";

/** Every recorded Flood version and backend (test/fixtures/flood). */
const VERSIONS = [
  "4.11.0-transmission",
  "4.16.4-deluge",
  "4.16.4-qbittorrent",
  "4.16.4-rtorrent",
  "4.16.4-transmission",
] as const;

/**
 * @param version recorded version
 * @param state state folder
 * @returns the recorded torrents by hash
 */
const torrentsOf = (version: string, state: string): [string, FloodTorrent][] =>
  Object.entries(
    (loadFixture("flood", version, state, "torrents").body as { torrents: Record<string, FloodTorrent> }).torrents,
  );

/**
 * @param version recorded version
 * @param state state folder
 * @returns the recorded torrents by name
 */
const byName = (version: string, state: string): Record<string, FloodTorrent> =>
  Object.fromEntries(torrentsOf(version, state).map(([, t]) => [String(t.name), t]));

/**
 * @param version recorded version
 * @param state state folder
 * @returns the snapshot of that state
 */
const snap = (version: string, state: string): ReturnType<typeof toSnapshot> =>
  toSnapshot(
    version,
    torrentsOf(version, state),
    loadFixture("flood", version, state, "settings").body as Record<string, unknown>,
    false,
    () => undefined,
  );

/**
 * @param version recorded version
 * @param state state folder
 * @returns name → status of that state
 */
const statuses = (version: string, state: string): Record<string, string> =>
  Object.fromEntries(snap(version, state).items.map(i => [i.name, i.status]));

describe("Flood status", () => {
  it("maps every row of the status table", () => {
    for (const [key, expected] of statusTable) {
      expect([key, mapFloodStatus(key, () => undefined)]).toEqual([key, expected]);
    }
  });

  it("names unknown flags in a debug line", () => {
    const lines: string[] = [];
    expect(mapFloodStatus(rawStatus({ status: ["warning"] }), m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("warning");
  });

  it("maps every recorded torrent to a status of the table, never to an unknown one", () => {
    const known = new Set<string>(statusTable.map(([k]) => k));
    for (const v of VERSIONS) {
      for (const state of ["added-stopped", "all-stopped", "checking", "missing", "resumed", "throttled"]) {
        for (const [, t] of torrentsOf(v, state)) {
          expect([v, state, t.name, known.has(rawStatus(t))]).toEqual([v, state, t.name, true]);
        }
      }
    }
  });

  it("reads qBittorrent's states behind Flood: queued and stalled wait, a missing file failed, a check", () => {
    expect(statuses("4.16.4-qbittorrent", "added-stopped")).toEqual({
      "big.bin": "seeding",
      "check.bin": "seeding",
      "done.bin": "seeding",
      "gone.bin": "failed",
      "late.bin": "checking",
      "nobody-seeds-this": "waiting",
      "queued.bin": "waiting",
      "stopped.bin": "paused",
    });
    expect(statuses("4.16.4-qbittorrent", "checking")["check.bin"]).toBe("checking");
    expect(statuses("4.16.4-qbittorrent", "running")["big.bin"]).toBe("downloading");
  });

  it("tells a finished stopped torrent by its bytes — Transmission's flag `complete` on a magnet without metadata", () => {
    // the recorded proof: the magnet carries `complete` with 0 of 0 bytes
    const magnet = byName("4.16.4-transmission", "all-stopped")["nobody-seeds-this"];
    expect([magnet.status, magnet.percentComplete]).toEqual([["stopped", "inactive", "complete"], null]);
    for (const v of VERSIONS) {
      const s = statuses(v, "all-stopped");
      // rTorrent names a magnet without metadata `<HASH>.meta`
      const magnetOf = Object.keys(s).find(n => n === "nobody-seeds-this" || n.endsWith(".meta")) ?? "";
      expect([v, s[magnetOf], s["stopped.bin"], s["done.bin"], s["big.bin"]]).toEqual([
        v,
        "paused",
        "paused",
        "completed",
        "completed",
      ]);
    }
  });

  it("takes rTorrent's tracker answers for messages, an error that stopped a torrent for failed", () => {
    const rt = byName("4.16.4-rtorrent", "all-stopped");
    expect(rt["check.bin"].message).toBe("Tracker: [No DHT nodes available for peer search.]");
    expect(rt["check.bin"].status).toEqual(["stopped", "complete", "error", "inactive"]);
    expect(statuses("4.16.4-rtorrent", "all-stopped")["check.bin"]).toBe("completed");
    const missing = Object.fromEntries(snap("4.16.4-rtorrent", "missing").items.map(i => [i.name, i]));
    expect([missing["gone.bin"].status, missing["gone.bin"].error]).toEqual([
      "failed",
      "Download registered as completed, but hash check returned unfinished chunks.",
    ]);
    // a running torrent shows rTorrent's message as its error, as the rTorrent driver does
    expect(missing["check.bin"]).toMatchObject({
      status: "seeding",
      error: "Tracker: [No DHT nodes available for peer search.]",
    });
  });

  it("shows no error for Deluge's `OK`, and a missing payload as Transmission and Deluge report it", () => {
    for (const i of snap("4.16.4-deluge", "added-stopped").items) {
      expect([i.name, i.error]).toEqual([i.name, ""]);
    }
    expect(byName("4.16.4-deluge", "added-stopped")["done.bin"].message).toBe("OK");
    // neither program marks a missing payload as an error: it loads again
    expect(statuses("4.16.4-deluge", "missing")["gone.bin"]).toBe("waiting");
    expect(statuses("4.16.4-transmission", "missing")["gone.bin"]).toBe("waiting");
    expect(statuses("4.16.4-qbittorrent", "missing")["gone.bin"]).toBe("failed");
  });
});

describe("Flood snapshot", () => {
  it("has no rate for a torrent that does not load — stopped and finished ones keep their last", () => {
    expect(byName("4.16.4-transmission", "all-stopped")["big.bin"].downRate).toBeGreaterThan(0);
    expect(byName("4.16.4-qbittorrent", "finished")["big.bin"].downRate).toBeGreaterThan(0);
    for (const v of VERSIONS) {
      const s = snap(v, "all-stopped");
      expect([v, s.status.downloadBps, s.status.uploadBps]).toEqual([v, 0, 0]);
    }
    expect(snap("4.16.4-qbittorrent", "finished").items.find(i => i.name === "big.bin")?.speedBps).toBe(0);
    const raw = byName("4.16.4-transmission", "running")["big.bin"];
    const big = snap("4.16.4-transmission", "running").items.find(i => i.name === "big.bin");
    expect(big).toMatchObject({ status: "downloading", speedBps: raw.downRate, etaSeconds: raw.eta });
    expect(big?.speedBps).toBeGreaterThan(0);
  });

  it("reads the size of the selected files, the whole torrent before 4.12, and none for a magnet", () => {
    const q = Object.fromEntries(snap("4.16.4-qbittorrent", "running").items.map(i => [i.name, i]));
    expect(q["big.bin"].sizeBytes).toBe(33554432);
    // qBittorrent: -1 of 0 bytes
    expect(q["nobody-seeds-this"].sizeBytes).toBeNull();
    const old = snap("4.11.0-transmission", "running").items.find(i => i.name === "big.bin");
    expect(byName("4.11.0-transmission", "running")["big.bin"].selectedSizeBytes).toBeUndefined();
    expect(old?.sizeBytes).toBe(33554432);
  });

  it("keeps the times only once there is one, the ratio only from 0 up", () => {
    const q = Object.fromEntries(snap("4.16.4-qbittorrent", "running").items.map(i => [i.name, i]));
    // qBittorrent -1 before finishing, Transmission and Deluge 0
    expect(q["queued.bin"].finishedMs).toBeNull();
    expect(q["done.bin"].finishedMs).toBe(
      Number(byName("4.16.4-qbittorrent", "running")["done.bin"].dateFinished) * 1000,
    );
    const t = Object.fromEntries(snap("4.16.4-transmission", "running").items.map(i => [i.name, i]));
    expect([t["queued.bin"].finishedMs, t["nobody-seeds-this"].ratio]).toEqual([null, null]);
    const d = Object.fromEntries(snap("4.16.4-deluge", "running").items.map(i => [i.name, i]));
    expect(d["stopped.bin"].ratio).toBeNull();
  });

  it("reads the limits in bytes per second, 0 = unlimited — Deluge's KiB/s and -1, ruTorrent's maximum too", () => {
    for (const v of VERSIONS) {
      // Flood wrote 102400 and 51200; Deluge keeps them as KiB/s, its gateway passes them on unchanged
      const unit = v.endsWith("-deluge") ? 1024 : 1;
      expect([v, snap(v, "limited").status.speedLimitBps, snap(v, "limited").status.uploadLimitBps]).toEqual([
        v,
        102400 * unit,
        51200 * unit,
      ]);
    }
    expect(loadFixture("flood", "4.16.4-deluge", "empty", "settings").body).toMatchObject({
      throttleGlobalDownSpeed: -1,
    });
    expect(snap("4.16.4-deluge", "empty").status.speedLimitBps).toBe(0);
    // rTorrent behind Flood reported ruTorrent's maximum in run 43677990506 (4.16.4-rtorrent from `finished` on)
    expect([limitBps(335488000, false), limitBps(335487999, false), limitBps(-1, false)]).toEqual([0, 335487999, 0]);
    expect([limitBps(undefined, false), limitBps("x", false), limitBps(1.6, false)]).toEqual([null, null, 2]);
    // KiB/s as Deluge keeps them: a float, -1 = off; ruTorrent's maximum means nothing there
    expect([limitBps(97.65625, true), limitBps(-1, true), limitBps(335488000, true), limitBps("x", true)]).toEqual([
      100000,
      0,
      335488000 * 1024,
      null,
    ]);
  });

  it("has no limits when Flood refused the settings", () => {
    const s = toSnapshot("", [], null, false, () => undefined);
    expect([s.status.speedLimitBps, s.status.uploadLimitBps]).toEqual([null, null]);
  });
});

describe("Flood and the emulated pause", () => {
  it("stops a check too, but takes only a loading or seeding torrent as the user's start", () => {
    // qBittorrent lists a torrent added stopped as `checking` first
    const late = byName("4.16.4-qbittorrent", "added-stopped")["late.bin"];
    expect(late.status).toEqual(["checking"]);
    expect([isRunning(late), isLoading(late)]).toEqual([true, false]);
    const q = byName("4.16.4-qbittorrent", "added-stopped");
    expect([isRunning(q["gone.bin"]), isRunning(q["stopped.bin"]), isRunning(q["queued.bin"])]).toEqual([
      false,
      false,
      true,
    ]);
    expect([isLoading(q["queued.bin"]), isLoading(q["done.bin"])]).toEqual([true, true]);
    // an error that stopped the torrent is never one to stop and resume
    const rt = byName("4.16.4-rtorrent", "missing");
    expect([isRunning(rt["gone.bin"]), isRunning(rt["check.bin"])]).toEqual([false, true]);
  });
});
