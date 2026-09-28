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
