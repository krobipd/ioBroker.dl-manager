import { loadFixture } from "../../../../test/helpers/fixtures";
import { dlStatus, dlTorrentFromRaw, mapDlStatus, statusTable, toSnapshot } from "./map";

const result = (version: string, state: string, name: string): unknown =>
  (loadFixture("deluge", version, state, name).body as { result: unknown }).result;

describe("Deluge status", () => {
  it("maps every row of the status table", () => {
    for (const [raw, expected] of statusTable) {
      expect([raw, mapDlStatus(raw, () => undefined)]).toEqual([raw, expected]);
    }
  });

  it("names an unknown state in a debug line", () => {
    const lines: string[] = [];
    expect(mapDlStatus("Unknown", m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("Unknown");
  });

  it("does not call a paused magnet without metadata completed (nothing wanted, nothing done)", () => {
    expect(dlStatus({ state: "Paused", progress: 0, total_wanted: 0, total_done: 0 }, () => undefined).status).toBe(
      "paused",
    );
  });

  it("hands the program's message on for an error", () => {
    expect(dlStatus({ ...dlTorrentFromRaw("Error"), message: "file not found" }, () => undefined)).toEqual({
      status: "failed",
      error: "file not found",
    });
  });
});

describe("Deluge snapshot from the recorded answers", () => {
  for (const version of ["2.1.1", "2.2.0"]) {
    const snap = (state: string): ReturnType<typeof toSnapshot> =>
      toSnapshot(
        version,
        result(version, state, "update-ui"),
        result(version, state, "config-values"),
        result(version, state, "is-session-paused") === true,
        () => undefined,
      );

    it(`maps the running torrents of ${version}`, () => {
      const s = snap("running");
      const byName = Object.fromEntries(s.items.map(i => [i.name, i]));
      expect(byName["queued.bin"]).toMatchObject({ status: "queued", etaSeconds: null, finishedMs: null });
      expect(byName["stopped.bin"].status).toBe("paused");
      expect(byName["done.bin"]).toMatchObject({
        status: "seeding",
        category: "linux",
        sizeBytes: 2097152,
        doneBytes: 2097152,
      });
      expect(byName["done.bin"].finishedMs).toBeGreaterThan(1e12);
      expect(byName["big.bin"]).toMatchObject({ key: "885bd0670addf14ec2c3014998ab3ef2f810fabf", ratio: null });
      expect(s.status).toMatchObject({ version, paused: false, speedLimitBps: 0, uploadLimitBps: 0 });
      expect(s.status.freeSpaceBytes).toBeGreaterThan(0);
    });

    it(`maps checking, completed and the session pause of ${version}`, () => {
      expect(snap("checking").items.find(i => i.name === "check.bin")?.status).toBe("checking");
      expect(snap("completed").items.find(i => i.name === "done.bin")?.status).toBe("completed");
      expect(snap("completed").items.find(i => i.name === "nobody-seeds-this")?.status).toBe("paused");
      expect(snap("session-paused").status.paused).toBe(true);
    });

    it(`reads the limits in KiB/s from the configuration of ${version}`, () => {
      expect(snap("limited").status).toMatchObject({ speedLimitBps: 2000 * 1024, uploadLimitBps: 500 * 1024 });
    });
  }
});
