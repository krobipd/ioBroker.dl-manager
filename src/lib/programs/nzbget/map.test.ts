import { loadFixture } from "../../../../test/helpers/fixtures";
import { mapNzbStatus, statusTable, toSnapshot } from "./map";

const result = (version: string, state: string, name: string): unknown =>
  (loadFixture("nzbget", version, state, name).body as { result: unknown }).result;

describe("NZBGet status", () => {
  it("maps every row of the status table", () => {
    for (const [raw, expected] of statusTable) {
      expect([raw, mapNzbStatus(raw, () => undefined)]).toEqual([raw, expected]);
    }
  });

  it("names an unknown status in a debug line", () => {
    const lines: string[] = [];
    expect(mapNzbStatus("q:SOMETHING_NEW", m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("SOMETHING_NEW");
  });
});

describe("NZBGet snapshot from the recorded answers", () => {
  for (const version of ["24.8", "26.3"]) {
    const snap = (state: string): ReturnType<typeof toSnapshot> =>
      toSnapshot(
        version,
        result(version, state, "status"),
        result(version, state, "listgroups"),
        result(version, state, "history"),
        () => undefined,
      );

    it(`maps queue and history of ${version}`, () => {
      const s = snap("running");
      const byName = Object.fromEntries(s.items.map(i => [i.name, i]));
      expect(byName.big).toMatchObject({ key: "4", status: "downloading", sizeBytes: 32 * 1024 * 1024 });
      expect(byName.queued.status).toBe("queued");
      expect(byName.stopped.status).toBe("paused");
      expect(byName.small).toMatchObject({ status: "completed", sizeBytes: 2097152 });
      expect(byName.small.finishedMs).toBeGreaterThan(1e12);
      expect(byName.broken).toMatchObject({ status: "failed", error: "FAILURE/HEALTH" });
      expect(byName.missing).toMatchObject({ status: "failed", error: "FAILURE/FETCH" });
      expect(s.status).toMatchObject({ version, paused: false, speedLimitBps: 1048576 });
      expect(s.status.freeSpaceBytes).toBeGreaterThan(21 * 2 ** 32);
    });

    it(`shows queue entries paused during the global pause and post-processing stages, ${version}`, () => {
      const p = snap("paused-global");
      expect(p.status.paused).toBe(true);
      expect(p.items.filter(i => ["big", "queued"].includes(i.name)).every(i => i.status === "paused")).toBe(true);
      expect(snap("postprocessing").items.find(i => i.name === "small")?.status).toBe("postprocessing");
    });

    it(`hides a deleted job, ${version}`, () => {
      expect(snap("removed").items.some(i => i.name === "stopped")).toBe(false);
    });
  }
});

describe("NZBGet status (written out, not taken from map.ts)", () => {
  const map = (raw: string): string => mapNzbStatus(raw, () => undefined);

  it("maps every post-processing stage of the queue", () => {
    for (const stage of [
      "PP_QUEUED",
      "LOADING_PARS",
      "VERIFYING_SOURCES",
      "REPAIRING",
      "VERIFYING_REPAIRED",
      "RENAMING",
      "UNPACKING",
      "MOVING",
      "POST_UNPACK_RENAMING",
      "POST_DOWNLOAD_RENAMING",
      "EXECUTING_SCRIPT",
      "PP_FINISHED",
      "QS_QUEUED",
      "QS_EXECUTING",
    ]) {
      expect([stage, map(`q:${stage}`)]).toEqual([stage, "postprocessing"]);
    }
  });

  it("counts a script warning as success and reads unknown history texts by their prefix", () => {
    expect(map("h:WARNING/SCRIPT")).toBe("completed");
    expect(map("h:SUCCESS/NEWKIND")).toBe("completed");
    expect(map("h:WARNING/NEWKIND")).toBe("failed");
    expect(map("h:FAILURE/NEWKIND")).toBe("failed");
    expect(map("h:SOMETHING")).toBe("queued");
  });

  it("does not hide post-processing behind the global pause", () => {
    expect(map("q:UNPACKING:globalPause")).toBe("postprocessing");
    expect(map("q:QUEUED:globalPause")).toBe("paused");
  });
});

describe("NZBGet edge values", () => {
  it("skips groups without id, reads 64-bit rates and keeps special values unknown", () => {
    const snap = toSnapshot(
      "26.3",
      { DownloadRateHi: 1, DownloadRateLo: 0, DownloadRate: 5 },
      [
        { Status: "QUEUED" },
        { NZBID: 1, Status: "QUEUED", FileSizeHi: 0, FileSizeLo: 100, RemainingSizeHi: 0, RemainingSizeLo: 150 },
      ],
      [{ NZBID: 2, Status: "SUCCESS/ALL", HistoryTime: 0 }],
      () => undefined,
    );
    expect(snap.items.map(i => i.key)).toEqual(["1", "2"]);
    expect(snap.items[0].doneBytes).toBe(0);
    expect(snap.items[1]).toMatchObject({ finishedMs: null, error: "" });
    expect(snap.status.downloadBps).toBe(4294967296);
  });
});

describe("mapNzbStatus — API boundary", () => {
  it("reads an inherited name like constructor as an unknown status, not as a table entry", () => {
    const lines: string[] = [];
    for (const raw of ["q:constructor", "h:toString", "q:__proto__"]) {
      expect([raw, mapNzbStatus(raw, m => lines.push(m))]).toEqual([raw, "queued"]);
    }
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("nzbget");
  });
});

describe("mapNzbStatus — every NZBGet queue status", () => {
  it("maps the queue statuses as documented (api-usenet-aria2-pyload.md)", () => {
    const expected: [string, string][] = [
      ["q:QUEUED", "queued"],
      ["q:PAUSED", "paused"],
      ["q:DOWNLOADING", "downloading"],
      ["q:FETCHING", "downloading"],
      ["q:DOWNLOADING:globalPause", "paused"],
    ];
    expect(expected.map(([raw]) => [raw, mapNzbStatus(raw, () => undefined)])).toEqual(expected);
  });
});
