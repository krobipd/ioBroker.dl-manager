import type { DownloadItem, ProgramSnapshot, Status } from "./model";
import { computeSummary, idleSummary } from "./summary";

const item = (key: string, status: Status): DownloadItem => ({
  key,
  name: key,
  status,
  sizeBytes: null,
  doneBytes: null,
  speedBps: null,
  etaSeconds: null,
  error: "",
});

const snap = (
  downloadBps: number | null,
  items: DownloadItem[],
  extra: Partial<ProgramSnapshot["status"]> = {},
): ProgramSnapshot => ({
  status: { version: "1", paused: false, downloadBps, ...extra },
  items,
  complete: true,
});

describe("computeSummary", () => {
  it("counts reachability over the reachable programs, the sums over every program's last poll (fleet outage suite)", () => {
    const s = computeSummary([
      {
        online: true,
        canPause: true,
        snapshot: snap(1_500_000, [item("a", "downloading"), item("b", "queued")], { uploadBps: 250_000 }),
      },
      { online: false, canPause: true, snapshot: snap(9_000_000, [item("c", "downloading")]) },
      { online: true, canPause: false, snapshot: snap(1_000_000, [item("d", "postprocessing")]) },
    ]);
    expect(s).toEqual({
      "info.connection": true,
      "info.programsTotal": 3,
      "info.programsOnline": 2,
      "info.programsAllOnline": false,
      "summary.downloading": true,
      "summary.active": 3,
      "summary.queued": 1,
      "summary.downloadSpeed": 11.5,
      "summary.uploadSpeed": 0.25,
      "summary.pauseAll": false,
    });
  });

  it("reports pauseAll only when every program that can pause was read paused", () => {
    const paused = { paused: true };
    const s = computeSummary([
      { online: true, canPause: true, snapshot: snap(0, [], paused) },
      { online: true, canPause: false, snapshot: snap(0, []) },
      { online: false, canPause: true, snapshot: null },
    ]);
    expect(s["summary.pauseAll"]).toBe(true);
  });

  it("keeps pauseAll false while one of two pausable programs still runs", () => {
    const s = computeSummary([
      { online: true, canPause: true, snapshot: snap(0, [], { paused: true }) },
      { online: true, canPause: true, snapshot: snap(0, [], { paused: false }) },
    ]);
    expect(s["summary.pauseAll"]).toBe(false);
  });

  it("does not count a program as online before its first snapshot", () => {
    const s = computeSummary([{ online: true, canPause: true, snapshot: null }]);
    expect(s["info.programsOnline"]).toBe(0);
    expect(s["info.connection"]).toBe(false);
  });

  it("writes no sum before the first poll, so the sums keep what they had", () => {
    const s = computeSummary([
      { online: false, canPause: true, snapshot: null },
      { online: false, canPause: false, snapshot: null },
    ]);
    expect(Object.keys(s).filter(id => id.startsWith("summary."))).toEqual([]);
    expect(s["info.programsTotal"]).toBe(2);
  });

  it("says unknown (null) for speeds before the first poll and after the stop, and never 'all online' without programs", () => {
    expect(computeSummary([])["info.programsAllOnline"]).toBe(false);
    const s = idleSummary(2);
    expect(s["info.connection"]).toBe(false);
    expect(s["info.programsTotal"]).toBe(2);
    expect(s["info.programsOnline"]).toBe(0);
    expect(s["info.programsAllOnline"]).toBe(false);
    expect(s["summary.active"]).toBe(0);
    expect(s["summary.downloadSpeed"]).toBeNull();
    expect(s["summary.uploadSpeed"]).toBeNull();
    expect(s["summary.pauseAll"]).toBe(false);
    expect(s["summary.downloading"]).toBe(false);
  });

  it("is all online when every configured program is reachable", () => {
    const s = computeSummary([
      { online: true, canPause: false, snapshot: snap(null, []) },
      { online: true, canPause: false, snapshot: snap(null, []) },
    ]);
    expect(s["info.programsAllOnline"]).toBe(true);
  });

  it("keeps the last speed sums when no program reported a readable speed — only stop and start empty them (D6, C26b)", () => {
    const s = computeSummary([
      { online: true, canPause: false, snapshot: snap(null, [item("a", "downloading")]) },
      { online: true, canPause: false, snapshot: snap(null, []) },
    ]);
    expect(s).not.toHaveProperty("summary.downloadSpeed");
    expect(s).not.toHaveProperty("summary.uploadSpeed");
    expect(s["summary.active"]).toBe(1);
    expect(
      computeSummary([{ online: true, canPause: false, snapshot: snap(2_000_000, []) }])["summary.downloadSpeed"],
    ).toBe(2);
  });
});
