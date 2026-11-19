import { loadFixture } from "../../../../test/helpers/fixtures";
import { RATIO_INFINITE } from "../../core/model";
import { errorOf, limitBps, mapTblStatus, rawStatus, statusTable, toSnapshot, type TblDownload } from "./map";

/**
 * @param version recorded version
 * @param state state folder
 * @param name file name
 * @returns the answer's body as a record
 */
const body = (version: string, state: string, name: string): Record<string, unknown> =>
  loadFixture("tribler", version, state, name).body as Record<string, unknown>;

/**
 * @param version recorded version
 * @param state state folder
 * @returns the recorded downloads by name
 */
const raw = (version: string, state: string): Record<string, TblDownload & Record<string, unknown>> =>
  Object.fromEntries(
    (body(version, state, "downloads").downloads as (TblDownload & Record<string, unknown>)[]).map(d => [d.name, d]),
  );

/**
 * @param version recorded version
 * @param state state folder
 * @param paused the adapter holds the program paused
 * @returns the snapshot of that state
 */
const snap = (version: string, state: string, paused = false): ReturnType<typeof toSnapshot> =>
  toSnapshot(
    version,
    body(version, state, "downloads").downloads as Record<string, unknown>[],
    body(version, state, "settings").settings as Record<string, unknown>,
    paused,
    () => undefined,
  );

/**
 * @param version recorded version
 * @param state state folder
 * @returns the items of that state by name
 */
const byName = (version: string, state: string): Record<string, ReturnType<typeof toSnapshot>["items"][number]> =>
  Object.fromEntries(snap(version, state).items.map(i => [i.name, i]));

describe("Tribler status", () => {
  it("maps every row of the status table", () => {
    for (const [key, expected] of statusTable) {
      expect([key, mapTblStatus(key, () => undefined)]).toEqual([key, expected]);
    }
  });

  it("names an unknown status in a debug line", () => {
    const lines: string[] = [];
    expect(mapTblStatus("FROZEN", m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("FROZEN");
  });

  it("tells a stopped or queued download that has every byte, and a download without rate and peer", () => {
    expect(rawStatus({ status: "STOPPED", progress: 1 })).toBe("STOPPED:done");
    expect(rawStatus({ status: "STOPPED", progress: 0.5 })).toBe("STOPPED");
    expect(rawStatus({ status: "QUEUED", progress: 1 })).toBe("QUEUED:done");
    expect(rawStatus({ status: "DOWNLOADING", progress: 0.1, speed_down: 0, num_peers: 0 })).toBe("DOWNLOADING:idle");
    // a web seed brings bytes without a peer
    expect(rawStatus({ status: "DOWNLOADING", progress: 0.1, speed_down: 42934, num_peers: 0 })).toBe("DOWNLOADING");
    expect(rawStatus({ status: "DOWNLOADING", progress: 0.1, speed_down: 0, num_peers: 2 })).toBe("DOWNLOADING");
    expect(rawStatus({ status: "SEEDING", progress: 1 })).toBe("SEEDING");
    // a status that is no text keeps its value, so the debug line of the unknown status names it
    expect(rawStatus({ status: 3, progress: 0.5 })).toBe("3");
  });

  it("takes the error text out of the quotes of Python's repr", () => {
    expect(errorOf("'Read-only file system: /ro/ro.bin'")).toBe("Read-only file system: /ro/ro.bin");
    expect(errorOf('"it\'s gone"')).toBe("it's gone");
    expect(errorOf("")).toBe("");
    expect(errorOf(undefined)).toBe("");
    expect(errorOf("no quotes")).toBe("no quotes");
  });

  it("reads a limit in bytes per second, 0 = unlimited, unknown while the scheduled limits rule", () => {
    expect(limitBps({ libtorrent: { max_download_rate: 102400 } }, "max_download_rate")).toBe(102400);
    expect(limitBps({ libtorrent: { max_upload_rate: 0 } }, "max_upload_rate")).toBe(0);
    expect(
      limitBps({ libtorrent: { max_download_rate: 102400, use_advanced_rate_limits: true } }, "max_download_rate"),
    ).toBeNull();
    expect(limitBps({}, "max_download_rate")).toBeNull();
  });
});

describe("Tribler snapshot from the recorded answers", () => {
  for (const version of ["8.0.7", "8.4.2"]) {
    it(`reads the limits and an empty list of ${version}`, () => {
      expect(snap(version, "empty").status).toMatchObject({
        version,
        paused: false,
        downloadBps: 0,
        uploadBps: 0,
        speedLimitBps: 0,
        uploadLimitBps: 0,
      });
      expect(snap(version, "empty").items).toEqual([]);
      expect(snap(version, "limited").status).toMatchObject({ speedLimitBps: 102400, uploadLimitBps: 51200 });
    });

    it(`maps a download, a stopped one, a finished one and the magnets of ${version}`, () => {
      const s = byName(version, "metadata");
      const r = raw(version, "metadata");
      expect(s["stopped.bin"]).toMatchObject({
        key: r["stopped.bin"].infohash,
        status: "paused",
        sizeBytes: 4194304,
        etaSeconds: null,
      });
      expect(s["done.bin"]).toMatchObject({ status: "seeding", sizeBytes: 2097152, doneBytes: 2097152, speedBps: 0 });
      expect(s["done.bin"].addedMs).toBe(Number(r["done.bin"].time_added) * 1000);
      // a magnet without metadata: no size, named by its dn — 8.0.7 shows it STOPPED until its handle is there, 8.4
      // already METADATA
      expect(s["nobody-seeds-this"]).toMatchObject({ sizeBytes: null, doneBytes: null });
      expect(s["nobody-seeds-this"].status).toBe(r["nobody-seeds-this"].status === "METADATA" ? "checking" : "paused");
      // the driver's add: the installation's 1 hop, the circuit not built in a container without Internet
      expect(r["default-hops"].status).toBe("EXIT_NODES");
      expect(s["default-hops"].status).toBe("waiting");
    });

    it(`counts no rate of a finished download in ${version}`, () => {
      for (const state of ["checking", "running", "metadata", "finished"]) {
        const s = snap(version, state);
        const r = raw(version, state);
        for (const i of s.items) {
          if (Number(r[i.name].progress) >= 1) {
            expect([state, i.name, i.speedBps]).toEqual([state, i.name, 0]);
          }
        }
        expect(s.status.downloadBps).toBe(s.items.reduce((sum, i) => sum + (i.speedBps ?? 0), 0));
      }
    });
  }

  it("maps a download into a read-only folder as failed with Tribler's text (8.4.2)", () => {
    const ro = byName("8.4.2", "error")["ro.bin"];
    const text = String(raw("8.4.2", "error")["ro.bin"].error);
    expect(ro).toMatchObject({ status: "failed", error: text.slice(1, -1) });
    expect(ro.error).toMatch(/\/ro\/ro\.bin$/);
  });

  it("maps the hash check without a done value — its progress is the share checked (8.4.2)", () => {
    const s = byName("8.4.2", "checking");
    expect(s["check.bin"]).toMatchObject({ status: "checking", doneBytes: null, sizeBytes: 1073741824 });
    expect(s["done.bin"]).toMatchObject({ status: "checking", doneBytes: null });
  });

  it("maps what the emulated pause stopped: unfinished paused, finished completed (8.4.2)", () => {
    const s = byName("8.4.2", "stopped");
    expect(s["big.bin"]).toMatchObject({ status: "paused", speedBps: 0, etaSeconds: null });
    expect(s["done.bin"].status).toBe("completed");
    expect(s["nobody-seeds-this"].status).toBe("paused");
  });

  it("reads the time a download finished on 8.4 — 8.0.7 does not send it", () => {
    const r = raw("8.4.2", "finished");
    expect(byName("8.4.2", "finished")["big.bin"].finishedMs).toBe(Number(r["big.bin"].time_finished) * 1000);
    expect(byName("8.0.7", "finished")["big.bin"].finishedMs).toBeNull();
  });

  it("gives an ETA only to a download that loads", () => {
    const s = byName("8.4.2", "limited");
    const r = raw("8.4.2", "limited");
    expect(s["big.bin"]).toMatchObject({ status: "downloading", etaSeconds: Math.round(Number(r["big.bin"].eta)) });
    // a resumed download before its first byte: the ETA Tribler sends is the size over a rate of almost nothing
    const idle = toSnapshot("8.4.2", [{ ...r["big.bin"], speed_down: 0 }], {}, false, () => undefined).items[0];
    expect(idle).toMatchObject({ status: "waiting", etaSeconds: null });
  });
});

describe("Tribler snapshot edge values", () => {
  it("skips a download without hash, names one without name by its hash, reads an infinite and a plain ratio", () => {
    const s = toSnapshot(
      "8.4.2",
      [
        { name: "x", status: "SEEDING" },
        { infohash: "h1", name: "", status: "SEEDING", progress: 1, size: 100, all_time_ratio: -1 },
        { infohash: "h2", name: "two", status: "SEEDING", progress: 1, size: 100, all_time_ratio: 1.23456 },
        { infohash: "h3", name: "three", status: "STOPPED", progress: 0, size: 0, all_time_ratio: 0 },
      ],
      { libtorrent: { max_download_rate: 0, max_upload_rate: 0 } },
      true,
      () => undefined,
    );
    expect(s.items.map(i => [i.key, i.name, i.status, i.ratio])).toEqual([
      ["h1", "h1", "seeding", RATIO_INFINITE],
      ["h2", "two", "seeding", 1.23],
      ["h3", "three", "paused", 0],
    ]);
    expect(s.items[2]).toMatchObject({ sizeBytes: null, doneBytes: null, addedMs: null, error: "" });
    expect(s.status).toMatchObject({ paused: true, downloadBps: 0 });
  });
});
