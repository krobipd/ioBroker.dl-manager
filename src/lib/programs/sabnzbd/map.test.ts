import { loadFixture } from "../../../../test/helpers/fixtures";
import { mapSabStatus, statusTable, toSnapshot } from "./map";

const queue = (version: string, state: string): Record<string, unknown> =>
  (loadFixture("sabnzbd", version, state, "queue").body as { queue: Record<string, unknown> }).queue;
const history = (version: string, state: string): Record<string, unknown> =>
  (loadFixture("sabnzbd", version, state, "history").body as { history: Record<string, unknown> }).history;

describe("SABnzbd status", () => {
  it("maps every row of the status table", () => {
    for (const [raw, expected] of statusTable) {
      expect([raw, mapSabStatus(raw, () => undefined)]).toEqual([raw, expected]);
    }
  });

  it("names an unknown slot status in a debug line", () => {
    const lines: string[] = [];
    expect(mapSabStatus("q:SomethingNew", m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("SomethingNew");
  });
});

describe("SABnzbd snapshot from the recorded answers", () => {
  for (const version of ["4.5.5", "5.1.3"]) {
    const snap = (state: string): ReturnType<typeof toSnapshot> =>
      toSnapshot(queue(version, state), (history(version, state).slots as unknown[]) ?? [], () => undefined);

    it(`maps queue and history of ${version}`, () => {
      const s = snap("running");
      const byName = Object.fromEntries(s.items.map(i => [i.name, i]));
      expect(byName.big).toMatchObject({ status: "downloading", sizeBytes: 32 * 1024 * 1024, category: "" });
      expect(byName.queued.status).toBe("queued");
      expect(byName.stopped.status).toBe("paused");
      expect(byName.small).toMatchObject({ status: "completed", sizeBytes: 2097152, doneBytes: 2097152 });
      expect(byName.small.finishedMs).toBeGreaterThan(1e12);
      expect(byName.broken.status).toBe("failed");
      expect(byName.broken.error).toMatch(/Not on your server/);
      expect(byName["http://seed:8080/missing.nzb"].error).toMatch(/File not on server/);
      expect(s.status).toMatchObject({ version, paused: false, speedLimitBps: 1048576 });
      expect(s.status.freeSpaceBytes).toBeGreaterThan(1e9);
      expect(s.items.every(i => i.speedBps === null && i.etaSeconds === null)).toBe(true);
    });

    it(`shows every slot paused while the queue is paused, ${version}`, () => {
      const s = snap("paused-global");
      expect(s.status.paused).toBe(true);
      expect(s.items.filter(i => ["big", "queued", "stopped"].includes(i.name)).every(i => i.status === "paused")).toBe(
        true,
      );
    });
  }

  it("maps a history job in post-processing", () => {
    const s = snap455("postprocessing");
    expect(s.items.find(i => i.name === "small")?.status).toBe("postprocessing");
  });

  it("lets a history entry win over a queue slot with the same id", () => {
    const s = toSnapshot(
      { paused: false, slots: [{ nzo_id: "x", filename: "a", status: "Downloading", mb: "1", mbleft: "0" }] },
      [{ nzo_id: "x", name: "a", status: "Extracting", bytes: 1 }],
      () => undefined,
    );
    expect(s.items).toHaveLength(1);
    expect(s.items[0].status).toBe("postprocessing");
  });
});

/**
 * @param state state folder of the 4.5.5 recordings
 * @returns the snapshot
 */
function snap455(state: string): ReturnType<typeof toSnapshot> {
  return toSnapshot(queue("4.5.5", state), (history("4.5.5", state).slots as unknown[]) ?? [], () => undefined);
}

describe("SABnzbd edge values", () => {
  it("skips slots without id, reads units in KiB, MiB and GiB, and keeps special values unknown", () => {
    const snap = toSnapshot(
      {
        kbpersec: "1",
        diskspace1: "1",
        slots: [
          { status: "Queued" },
          { nzo_id: "q1", status: "Queued", mb: "1", mbleft: "2", time_added: 0 },
          { nzo_id: "q2", mb: "-1" },
        ],
      },
      [
        { status: "Completed" },
        { nzo_id: "h1", status: "Extracting", completed: 1790000000, bytes: 5 },
        { nzo_id: "h2", status: "Completed", fail_message: "old", bytes: 7 },
      ],
      () => undefined,
    );
    expect(snap.items.map(i => i.key)).toEqual(["q1", "q2", "h1", "h2"]);
    const by = Object.fromEntries(snap.items.map(i => [i.key, i]));
    expect(by.q1).toMatchObject({ sizeBytes: 1048576, doneBytes: 0, addedMs: null });
    expect(by.q2.sizeBytes).toBeNull();
    expect(by.h1).toMatchObject({ finishedMs: null, doneBytes: 5 });
    expect(by.h2).toMatchObject({ error: "", doneBytes: 7 });
    expect(snap.status).toMatchObject({ downloadBps: 1024, freeSpaceBytes: 1073741824 });
  });
});
