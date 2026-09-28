import type { DownloadItem, ProgramSnapshot, Status } from "./model";
import { computeSummary } from "./summary";

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
  it("counts only reachable programs and adds their speeds in bytes before converting", () => {
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
      "summary.active": 2,
      "summary.queued": 1,
      "summary.downloadSpeed": 2.5,
      "summary.uploadSpeed": 0.25,
      "summary.pauseAll": false,
    });
  });

  it("reports pauseAll only when every reachable program that can pause is paused", () => {
    const paused = { paused: true };
    const s = computeSummary([
      { online: true, canPause: true, snapshot: snap(0, [], paused) },
      { online: true, canPause: false, snapshot: snap(0, []) },
      { online: false, canPause: true, snapshot: null },
    ]);
    expect(s["summary.pauseAll"]).toBe(true);
  });

  it("says unknown (null) for speeds nobody reports, and never 'all online' without programs", () => {
    const s = computeSummary([]);
    expect(s["info.connection"]).toBe(false);
    expect(s["info.programsAllOnline"]).toBe(false);
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
    expect(s["summary.downloadSpeed"]).toBeNull();
  });
});
