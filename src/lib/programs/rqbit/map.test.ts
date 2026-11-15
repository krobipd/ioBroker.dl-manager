import { loadFixture } from "../../../../test/helpers/fixtures";
import { limitBps, mapRqStatus, rawStatus, speedBps, statusTable, toSnapshot } from "./map";

/**
 * @param version recorded version
 * @param state state folder
 * @param name file name
 * @returns the answer's body as a record
 */
const body = (version: string, state: string, name: string): Record<string, unknown> =>
  loadFixture("rqbit", version, state, name).body as Record<string, unknown>;

describe("rqbit status", () => {
  it("maps every row of the status table", () => {
    for (const [raw, expected] of statusTable) {
      expect([raw, mapRqStatus(raw, () => undefined)]).toEqual([raw, expected]);
    }
  });

  it("names an unknown state in a debug line", () => {
    const lines: string[] = [];
    expect(mapRqStatus("frozen:left", m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("frozen:left");
  });

  it("calls a live torrent without peer and without incoming bytes stalled, never a finished or a loading one", () => {
    const live = (peers: number, mbps: number): Record<string, unknown> => ({
      snapshot: { peer_stats: { live: peers } },
      download_speed: { mbps },
    });
    expect(rawStatus({ state: "live", finished: false, live: live(0, 0) })).toBe("live:stalled");
    expect(rawStatus({ state: "live", finished: false, live: live(0, 0.5) })).toBe("live:left");
    expect(rawStatus({ state: "live", finished: false, live: live(2, 0) })).toBe("live:left");
    expect(rawStatus({ state: "live", finished: true, live: live(0, 0) })).toBe("live:done");
    // without its live block nothing tells the peers — a live torrent is then loading
    expect(rawStatus({ state: "live", finished: false, live: null })).toBe("live:left");
    expect(rawStatus({ state: "paused", finished: false })).toBe("paused:left");
  });

  it("reads a speed in MiB/s and a limit in bytes per second, null = unlimited, unknown when not served", () => {
    expect(speedBps({ mbps: 1, human_readable: "1.00 MiB/s" })).toBe(1048576);
    expect(speedBps({})).toBeNull();
    expect(limitBps({ download_bps: 2048000, upload_bps: null }, "download_bps")).toBe(2048000);
    expect(limitBps({ download_bps: 2048000, upload_bps: null }, "upload_bps")).toBe(0);
    expect(limitBps(null, "download_bps")).toBeNull();
  });
});

describe("rqbit snapshot from the recorded answers", () => {
  for (const version of ["8.1.1", "9.1.0"]) {
    const limitsServed = version.startsWith("9");
    const snap = (state: string, paused = false): ReturnType<typeof toSnapshot> =>
      toSnapshot(
        version,
        body(version, state, "torrents").torrents as Record<string, unknown>[],
        body(version, state, "stats"),
        limitsServed ? body(version, state, "limits") : null,
        paused,
        () => undefined,
      );
    const byName = (state: string): Record<string, ReturnType<typeof toSnapshot>["items"][number]> =>
      Object.fromEntries(snap(state).items.map(i => [i.name, i]));

    it(`maps the running torrents of ${version}`, () => {
      const s = byName("running");
      expect(s["big.bin"]).toMatchObject({ status: "downloading", key: "885bd0670addf14ec2c3014998ab3ef2f810fabf" });
      expect(s["big.bin"].speedBps).toBeGreaterThan(0);
      expect(s["big.bin"].etaSeconds).toBeGreaterThanOrEqual(0);
      expect(s["stopped.bin"]).toMatchObject({ status: "paused", speedBps: null, etaSeconds: null });
      expect(s["done.bin"]).toMatchObject({
        status: "seeding",
        doneBytes: 2097152,
        sizeBytes: 2097152,
        etaSeconds: null,
      });
    });

    it(`maps checking, a torrent without peers and a paused finished one of ${version}`, () => {
      expect(byName("checking")["check.bin"].status).toBe("checking");
      expect(byName("stalled")["stopped.bin"]).toMatchObject({ status: "waiting", etaSeconds: null });
      expect(byName("completed")["done.bin"].status).toBe("completed");
    });

    it(`reads the limits of ${version} — 8.x cannot tell them`, () => {
      expect(snap("limited").status).toMatchObject(
        limitsServed
          ? { speedLimitBps: 2048000, uploadLimitBps: 512000 }
          : { speedLimitBps: null, uploadLimitBps: null },
      );
      expect(snap("empty").status).toMatchObject({ version, paused: false, downloadBps: 0, uploadBps: 0 });
      expect(snap("empty").items).toEqual([]);
    });
  }
});

describe("rqbit snapshot edge values", () => {
  it("skips a torrent without hash, names one without name by its hash and computes the ratio from what is on disk", () => {
    const s = toSnapshot(
      "9.1.0",
      [
        { name: "x", stats: { state: "live" } },
        {
          info_hash: "h1",
          name: null,
          stats: { state: "live", finished: true, progress_bytes: 200, uploaded_bytes: 100, total_bytes: 200 },
        },
        { info_hash: "h2", name: "", stats: { state: "error", error: "disk full", progress_bytes: 0 } },
      ],
      {},
      { download_bps: null, upload_bps: null },
      true,
      () => undefined,
    );
    expect(s.items.map(i => [i.key, i.name, i.status])).toEqual([
      ["h1", "h1", "seeding"],
      ["h2", "h2", "failed"],
    ]);
    expect(s.items[0].ratio).toBe(0.5);
    expect(s.items[1]).toMatchObject({ ratio: null, error: "disk full" });
    expect(s.status).toMatchObject({ paused: true, downloadBps: null, speedLimitBps: 0, uploadLimitBps: 0 });
  });
});
