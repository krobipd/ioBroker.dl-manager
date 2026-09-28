import { loadFixture } from "../../../../test/helpers/fixtures";
import { mapTrStatus, snakeKeys, statusTable, toSnapshot, trStatus, trTorrentFromRaw } from "./map";

/**
 * The answer's payload in either protocol, keys in snake_case.
 *
 * @param version recorded version
 * @param state state folder
 * @param name file name
 * @returns the payload
 */
const payload = (version: string, state: string, name: string): Record<string, unknown> => {
  const body = loadFixture("transmission", version, state, name).body as Record<string, unknown>;
  return snakeKeys(typeof body.arguments === "object" ? body.arguments : body.result) as Record<string, unknown>;
};

describe("Transmission status", () => {
  it("maps every row of the status table", () => {
    for (const [raw, expected] of statusTable) {
      expect([raw, mapTrStatus(raw, () => undefined)]).toEqual([raw, expected]);
    }
  });

  it("names an unknown status number in a debug line", () => {
    const lines: string[] = [];
    expect(mapTrStatus("9:0:left", m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("9");
  });

  it("never reads is_finished as finished — it means the seed ratio was reached", () => {
    const t = { ...trTorrentFromRaw("0:0:left"), is_finished: true };
    expect(trStatus(t, () => undefined).status).toBe("paused");
  });

  it("keeps a tracker error on a running torrent as text only", () => {
    expect(trStatus({ ...trTorrentFromRaw("4:2:left"), error_string: "tracker down" }, () => undefined)).toEqual({
      status: "downloading",
      error: "tracker down",
    });
  });

  it("converts legacy camelCase and kebab-case keys to snake_case, deep", () => {
    expect(
      snakeKeys({
        hashString: "a",
        "speed-limit-down": 1,
        units: { "speed-bytes": 1000 },
        list: [{ leftUntilDone: 0 }],
      }),
    ).toEqual({
      hash_string: "a",
      speed_limit_down: 1,
      units: { speed_bytes: 1000 },
      list: [{ left_until_done: 0 }],
    });
  });
});

describe("Transmission snapshot from the recorded answers", () => {
  for (const version of ["4.0.6", "4.1.3"]) {
    const snap = (state: string, paused = false): ReturnType<typeof toSnapshot> =>
      toSnapshot(
        version,
        (payload(version, state, "torrent-get").torrents as unknown[]) ?? [],
        payload(version, state, "session-get"),
        payload(version, state, "session-stats"),
        payload(version, state, "free-space"),
        paused,
        () => undefined,
      );

    it(`maps the running torrents of ${version}`, () => {
      const s = snap("running");
      const byName = Object.fromEntries(s.items.map(i => [i.name, i]));
      expect(byName["big.bin"]).toMatchObject({
        status: "downloading",
        key: "885bd0670addf14ec2c3014998ab3ef2f810fabf",
      });
      expect(byName["queued.bin"].status).toBe("queued");
      expect(byName["stopped.bin"]).toMatchObject({ status: "paused", etaSeconds: null });
      expect(byName["done.bin"]).toMatchObject({ status: "seeding", doneBytes: 2097152, sizeBytes: 2097152 });
      expect(byName["done.bin"].finishedMs).toBeGreaterThan(1e12);
      expect(byName["nobody-seeds-this"]).toMatchObject({ status: "downloading", ratio: null });
      expect(s.status).toMatchObject({ version, paused: false, speedLimitBps: 0, altSpeed: false });
      expect(s.status.freeSpaceBytes).toBeGreaterThan(0);
    });

    it(`maps checking, missing data and a stopped magnet without metadata of ${version}`, () => {
      expect(snap("checking").items.find(i => i.name === "check.bin")?.status).toBe("checking");
      const gone = snap("missing").items.find(i => i.name === "gone.bin");
      expect(gone?.status).toBe("failed");
      expect(gone?.error).toMatch(/no data/i);
      const c = snap("completed");
      expect(c.items.find(i => i.name === "done.bin")?.status).toBe("completed");
      expect(c.items.find(i => i.name === "nobody-seeds-this")?.status).toBe("paused");
    });

    it(`reads limits in kB/s times the session's speed unit, and the alternative speed of ${version}`, () => {
      expect(snap("limited").status).toMatchObject({
        speedLimitBps: 2_000_000,
        uploadLimitBps: 500_000,
        altSpeed: true,
      });
    });
  }
});
