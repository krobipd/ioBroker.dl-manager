import { loadFixture } from "../../../../test/helpers/fixtures";
import { MaindataState, mapQbState, parseQbVersion, qbRunning, statusTable, toSnapshot } from "./map";

const maindata = (version: string, state: string): Record<string, unknown> =>
  loadFixture("qbittorrent", version, state, "maindata").body as Record<string, unknown>;

describe("qBittorrent status", () => {
  it("maps every state of the status table", () => {
    for (const [raw, expected] of statusTable) {
      expect([raw, mapQbState(raw, () => undefined)]).toEqual([raw, expected]);
    }
  });

  it("names an unknown state in a debug line", () => {
    const lines: string[] = [];
    expect(mapQbState("somethingNew", m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("somethingNew");
  });

  it("reads the version with and without its leading v", () => {
    expect(parseQbVersion("v5.2.3")).toEqual([5, 2, 3]);
    expect(parseQbVersion("4.6.7")).toEqual([4, 6, 7]);
    expect(parseQbVersion("garbage")).toEqual([0, 0, 0]);
  });
});

describe("qBittorrent sync/maindata", () => {
  it("replaces on a full update, merges changed fields and drops removed torrents", () => {
    const m = new MaindataState();
    m.apply({
      rid: 1,
      full_update: true,
      torrents: { a: { name: "A", state: "downloading" }, b: { name: "B" } },
      server_state: { dl_info_speed: 5 },
    });
    m.apply({
      rid: 2,
      torrents: { a: { state: "stalledUP" } },
      torrents_removed: ["b"],
      server_state: { up_info_speed: 3 },
    });
    expect(m.rid).toBe(2);
    expect(m.torrents).toEqual({ a: { name: "A", state: "stalledUP" } });
    expect(m.serverState).toEqual({ dl_info_speed: 5, up_info_speed: 3 });
    m.apply({ rid: 7, full_update: true, torrents: { c: { name: "C" } } });
    expect(Object.keys(m.torrents)).toEqual(["c"]);
  });

  it("ignores garbage", () => {
    const m = new MaindataState();
    m.apply(null);
    m.apply({ torrents: "x" });
    expect(m.torrents).toEqual({});
  });
});

describe("qBittorrent snapshot from the recorded answers", () => {
  for (const version of ["4.6.7", "5.1.4", "5.2.3"]) {
    it(`maps the running torrents of ${version}`, () => {
      const m = new MaindataState();
      m.apply(maindata(version, "running"));
      const s = toSnapshot(`v${version}`, m, false, () => undefined);
      const byName = Object.fromEntries(s.items.map(i => [i.name, i]));
      expect(byName["big.bin"]).toMatchObject({ status: "downloading", sizeBytes: 33554432 });
      expect(byName["big.bin"].speedBps).toBeGreaterThan(0);
      expect(byName["big.bin"].etaSeconds).toBeGreaterThan(0);
      expect(byName["queued.bin"]).toMatchObject({ status: "queued", etaSeconds: null, finishedMs: null });
      expect(byName["stopped.bin"].status).toBe("paused");
      expect(byName["done.bin"]).toMatchObject({ status: "seeding", doneBytes: 2097152 });
      expect(byName["done.bin"].finishedMs).toBeGreaterThan(1e12);
      expect(byName["nobody-seeds-this"].status).toBe("queued");
      expect(byName["big.bin"].extra).toEqual({ forceStart: false });
      expect(s.status).toMatchObject({ version, paused: false, speedLimitBps: 0, altSpeed: false });
      expect(s.status.freeSpaceBytes).toBeGreaterThan(0);
    });

    it(`maps checking, metadata, failed and completed of ${version}`, () => {
      const states = (state: string): string[] => {
        const m = new MaindataState();
        m.apply(maindata(version, state));
        return toSnapshot(version, m, false, () => undefined).items.map(i => i.status);
      };
      expect(states("checking")).toContain("checking");
      expect(states("metadata")).toContain("checking");
      expect(states("missing")).toContain("failed");
      expect(states("completed")).toContain("completed");
    });

    it(`gives a failed torrent a reason and reads the alternative limits of ${version}`, () => {
      const m = new MaindataState();
      m.apply(maindata(version, "missing"));
      const failed = toSnapshot(version, m, false, () => undefined).items.find(i => i.status === "failed");
      expect(failed?.error).not.toBe("");
      const l = new MaindataState();
      l.apply(maindata(version, "limited"));
      expect(toSnapshot(version, l, false, () => undefined).status).toMatchObject({
        altSpeed: true,
        speedLimitBps: 10240,
      });
    });
  }

  it("counts running torrents for the adapter-made global pause", () => {
    const m = new MaindataState();
    m.apply(maindata("5.2.3", "running"));
    const running = qbRunning(m);
    expect(running.size).toBeGreaterThan(0);
    const stopped = Object.entries(m.torrents).find(([, t]) => t.state === "stoppedDL")?.[0];
    expect(running.has(String(stopped))).toBe(false);
  });
});
