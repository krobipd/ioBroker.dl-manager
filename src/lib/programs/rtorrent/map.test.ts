import { loadFixture } from "../../../../test/helpers/fixtures";
import { ProtocolError } from "../../core/errors";
import { parseResponse } from "./xmlrpc";
import {
  FIELDS,
  errorOf,
  limitBps,
  mapRtStatus,
  rawStatus,
  statusTable,
  toSnapshot,
  torrentOf,
  UNLIMITED_BPS,
  type RtTorrent,
} from "./map";

/**
 * @param version recorded version
 * @param state state folder
 * @returns the recorded poll: the four global values and the torrents
 */
function poll(version: string, state: string): { global: unknown[]; torrents: RtTorrent[] } {
  const res = parseResponse(loadFixture("rtorrent", version, state, "poll").body as string) as unknown[][];
  return { global: res.slice(0, 4).map(r => r[0]), torrents: (res[4][0] as unknown[]).map(torrentOf) };
}

/**
 * @param version recorded version
 * @param state state folder
 * @returns the snapshot of that poll
 */
function snap(version: string, state: string): ReturnType<typeof toSnapshot> {
  const p = poll(version, state);
  const [down, up, downMax, upMax] = p.global;
  return toSnapshot(version, p.torrents, { down, up, downMax, upMax }, false, () => undefined);
}

/** A torrent with every field set to its quiet value. */
const base: RtTorrent = {
  hash: "H",
  name: "n",
  state: 1,
  open: 1,
  active: 1,
  complete: 0,
  hashing: 0,
  checking: 0,
  size: 100,
  done: 50,
  down: 10,
  up: 0,
  ratio: 0,
  peers: 1,
  message: "",
  label: "",
  loaded: null,
  finished: null,
  held: "",
};

describe("rTorrent status", () => {
  it("maps every row of the status table", () => {
    for (const [raw, expected] of statusTable) {
      expect([raw, mapRtStatus(raw, () => undefined)]).toEqual([raw, expected]);
    }
  });

  it("names an unknown state in a debug line", () => {
    const lines: string[] = [];
    expect(mapRtStatus("frozen:left", m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("frozen:left");
  });

  it("derives the raw key from ruTorrent's fields", () => {
    const key = (t: Partial<RtTorrent>): string => rawStatus({ ...base, ...t });
    expect(key({ checking: 1, hashing: 1, active: 0 })).toBe("checking");
    expect(key({ hashing: 2 })).toBe("hashing");
    expect(key({})).toBe("active:left");
    expect(key({ peers: 0, down: 0 })).toBe("active:stalled");
    expect(key({ peers: 0, down: 5 })).toBe("active:left");
    expect(key({ complete: 1, peers: 0, down: 0 })).toBe("active:done");
    expect(key({ active: 0 })).toBe("paused:left");
    expect(key({ state: 0, active: 0 })).toBe("stopped:left");
    expect(key({ state: 0, active: 0, message: 'Tracker: [Failure reason "unregistered torrent"]' })).toBe(
      "stopped:left",
    );
    expect(
      key({ state: 0, active: 0, message: "Storage error: [File chunk write error: No space left on device]" }),
    ).toBe("stopped:error");
    expect(key({ open: 0, state: 0, active: 0, message: "Storage error" })).toBe("closed:error");
    expect(key({ open: 0, state: 0, active: 0, complete: 1, message: "Storage error" })).toBe("closed:done");
    // an error message on a running torrent stops nothing — it stays downloading
    expect(key({ message: "Storage error" })).toBe("active:left");
  });

  it("shows every message as the error except ruTorrent's one tracker note", () => {
    expect(errorOf({ ...base, message: "Tracker: [Tried all trackers.]" })).toBe("");
    expect(errorOf({ ...base, message: "Tracker: [No DHT nodes available for peer search.]" })).toBe(
      "Tracker: [No DHT nodes available for peer search.]",
    );
  });

  it("reads 0 and ruTorrent's maximum as unlimited", () => {
    expect(limitBps(0)).toBe(0);
    expect(limitBps(UNLIMITED_BPS)).toBe(0);
    expect(limitBps(335488000)).toBe(0);
    expect(limitBps(2048000)).toBe(2048000);
    expect(limitBps("x")).toBeNull();
  });
});

describe("rTorrent torrent rows", () => {
  /** @returns a copy of the first raw row of the 0.16.25 running recording */
  function row(): unknown[] {
    const res = parseResponse(loadFixture("rtorrent", "0.16.25", "running", "poll").body as string) as unknown[][];
    return [...(res[4][0] as unknown[][])[0]];
  }

  it("asks the fields the recorder asked", () => {
    expect(row()).toHaveLength(FIELDS.length);
  });

  it("refuses a row with a field less, a row that is no list and a row without hash", () => {
    expect(() => torrentOf(row().slice(0, -1))).toThrow(/19 of 20 fields/);
    expect(() => torrentOf("x")).toThrow(ProtocolError);
    const noHash = row();
    noHash[0] = 7;
    expect(() => torrentOf(noHash)).toThrow(/without its d.hash/);
    noHash[0] = "";
    expect(() => torrentOf(noHash)).toThrow(/without its d.hash/);
  });
});

describe("rTorrent snapshot from the recorded answers", () => {
  for (const version of ["0.9.8", "0.16.25"]) {
    const byName = (state: string): Record<string, ReturnType<typeof toSnapshot>["items"][number]> =>
      Object.fromEntries(snap(version, state).items.map(i => [i.name, i]));

    it(`maps the running torrents of ${version}`, () => {
      const s = byName("running");
      expect(s["big.bin"]).toMatchObject({ status: "downloading", key: "885BD0670ADDF14EC2C3014998AB3EF2F810FABF" });
      expect(s["big.bin"].speedBps).toBeGreaterThan(0);
      expect(s["big.bin"].etaSeconds).toBeGreaterThan(0);
      expect(s["big.bin"].addedMs).toBeGreaterThan(0);
      expect(s["big.bin"].finishedMs).toBeNull();
      expect(s["stopped.bin"]).toMatchObject({ status: "paused", etaSeconds: null });
      expect(s["done.bin"]).toMatchObject({ status: "seeding", doneBytes: 2097152, sizeBytes: 2097152, ratio: 0 });
      expect(s["done.bin"].finishedMs).toBeGreaterThan(0);
    });

    it(`maps checking, a torrent without peers, a magnet without metadata and a missing payload of ${version}`, () => {
      expect(byName("checking")["check.bin"].status).toBe("checking");
      expect(byName("stalled")["stopped.bin"]).toMatchObject({ status: "waiting", etaSeconds: null });
      const meta = Object.values(byName("metadata")).find(i => i.name.endsWith(".meta"));
      expect(meta?.status).toBe("waiting");
      expect(byName("missing")["gone.bin"]).toMatchObject({
        status: "failed",
        error: "Download registered as completed, but hash check returned unfinished chunks.",
        // rTorrent keeps the finish time of the first run — the download is not finished any more
        finishedMs: null,
      });
    });

    it(`maps a paused, a stopped, a closed and a reopened finished torrent of ${version}`, () => {
      expect(byName("pausing")["done.bin"].status).toBe("completed");
      expect(byName("completed")["done.bin"].status).toBe("completed");
      expect(byName("closed")["done.bin"].status).toBe("completed");
      expect(byName("reopened")["done.bin"].status).toBe("seeding");
      expect(byName("finished")["big.bin"]).toMatchObject({ status: "seeding", etaSeconds: null });
    });

    it(`maps what d.start, d.resume and a stopped hash check leave behind on ${version}`, () => {
      // d.start does not wake a torrent d.pause halted (recording unpaused), d.resume does (resumed)
      expect(byName("unpaused")["done.bin"].status).toBe("completed");
      expect(byName("resumed")["done.bin"].status).toBe("seeding");
      // d.resume on a stopped torrent: state 0 with active 1 — the driver never sends it there, a stopped torrent stays
      // what its state says
      expect(byName("resumed-stopped")["done.bin"].status).toBe("completed");
      // a hash check stopped halfway: rTorrent keeps d.complete and reports the bytes checked so far (0.9.8: none,
      // 0.16: 4 MiB) — finished by the program's own word; the next start checks it whole again (recording held)
      expect(byName("check-stopped")["check.bin"]).toMatchObject({ status: "completed", sizeBytes: 1073741824 });
      expect(byName("check-stopped")["check.bin"].doneBytes).toBeLessThan(1073741824);
    });

    it(`maps a magnet added stopped and marked, and the torrent built from its metadata, of ${version}`, () => {
      const meta = Object.values(byName("held")).find(i => i.name.startsWith("38B12B1A"));
      expect(meta).toMatchObject({ status: "paused", name: "38B12B1A4FFFB255161B45E772882BEBE94D3B30.meta" });
      expect(byName("released")["queued.bin"]).toMatchObject({ status: "paused", sizeBytes: 4194304 });
      expect(byName("rereleased")["queued.bin"].status).not.toBe("paused");
    });

    it(`reads the limits and rates of ${version}`, () => {
      expect(snap(version, "limited").status).toMatchObject({ speedLimitBps: 2048000, uploadLimitBps: 512000 });
      // ruTorrent's maximum stands in one recording of each version — unlimited either way
      for (const state of ["empty", "finished"]) {
        expect(snap(version, state).status).toMatchObject({ speedLimitBps: 0, uploadLimitBps: 0 });
      }
      expect(snap(version, "empty").status).toMatchObject({ version, paused: false, downloadBps: 0, uploadBps: 0 });
      expect(snap(version, "empty").items).toEqual([]);
      expect(snap(version, "running").status.downloadBps).toBeGreaterThan(0);
    });
  }
});

describe("rTorrent snapshot edge values", () => {
  it("names a torrent without name by its hash, reads the ratio in thousandths and the label as category", () => {
    const s = toSnapshot(
      "0.16.25",
      [{ ...base, name: "", ratio: 1500, label: "tv", complete: 1, done: 100 }],
      { down: null, up: "x", downMax: 0, upMax: 0 },
      true,
      () => undefined,
    );
    expect(s.items[0]).toMatchObject({ key: "H", name: "H", ratio: 1.5, category: "tv", status: "seeding" });
    expect(s.status).toMatchObject({ paused: true, downloadBps: null, uploadBps: null });
  });

  it("tells no time left without a rate or with nothing left", () => {
    const eta = (t: Partial<RtTorrent>): number | null =>
      toSnapshot("v", [{ ...base, ...t }], { down: 0, up: 0, downMax: 0, upMax: 0 }, false, () => undefined).items[0]
        .etaSeconds;
    expect(eta({ size: 1000, done: 500, down: 100 })).toBe(5);
    expect(eta({ size: 1000, done: 500, down: 0, peers: 1 })).toBeNull();
    expect(eta({ size: null })).toBeNull();
  });
});
