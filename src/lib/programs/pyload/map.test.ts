import { loadFixture } from "../../../../test/helpers/fixtures";
import { mapPyStatus, packageStatus, statusTable, toSnapshot } from "./map";

const body = (state: string, name: string): unknown => loadFixture("pyload", "0.5.0", state, name).body;
const snap = (state: string): ReturnType<typeof toSnapshot> =>
  toSnapshot(
    "0.5.0",
    body(state, "status-server"),
    body(state, "get-queue-data"),
    body(state, "status-downloads"),
    body(state, "free-space"),
    null,
    () => undefined,
  );

describe("pyLoad status of a package", () => {
  it("maps every file code of the status table", () => {
    for (const [raw, expected] of statusTable) {
      expect([raw, mapPyStatus(raw, () => undefined)]).toEqual([raw, expected]);
    }
  });

  it("names an unknown file code in a debug line", () => {
    const lines: string[] = [];
    expect(mapPyStatus(99, m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("99");
  });

  it("turns pyLoad's bare status word into a sentence, keeps a real error text", () => {
    expect(packageStatus([{ status: 1, error: "offline" }], () => undefined).error).toBe(
      "offline — the file is not available",
    );
    expect(packageStatus([{ status: 8, error: "" }], () => undefined).error).toBe("failed");
    expect(packageStatus([{ status: 8, error: "Disk full" }], () => undefined).error).toBe("Disk full");
  });

  it("is downloading while one file loads, failed only when nothing runs any more", () => {
    const f = (status: number): { status: number; error?: string } => ({ status });
    expect(packageStatus([f(0), f(12)], () => undefined).status).toBe("downloading");
    expect(packageStatus([f(8), f(12)], () => undefined).status).toBe("downloading");
    expect(packageStatus([{ status: 8, error: "boom" }, f(0)], () => undefined)).toEqual({
      status: "failed",
      error: "boom",
    });
    expect(packageStatus([f(0), f(4)], () => undefined).status).toBe("completed");
  });
});

describe("pyLoad snapshot from the recorded answers (0.5.0b3.dev101)", () => {
  it("maps finished, offline and downloading packages with the active files' progress", () => {
    const s = snap("running");
    const byName = Object.fromEntries(s.items.map(i => [i.name, i]));
    expect(byName.small).toMatchObject({ key: "1", status: "completed" });
    expect(byName.missing).toMatchObject({ status: "failed", error: "offline — the file is not available" });
    expect(byName.big).toMatchObject({ status: "downloading", sizeBytes: 33554432, speedBps: 1371952, etaSeconds: 21 });
    expect(byName.big.doneBytes).toBe(33554432 - 29294592);
    expect(s.status).toMatchObject({ version: "0.5.0", paused: false, downloadBps: 1371952 });
    expect(s.status.freeSpaceBytes).toBeGreaterThan(0);
  });

  it("shows an aborted package paused and the server pause", () => {
    expect(snap("aborted").items.find(i => i.name === "big")?.status).toBe("paused");
    expect(snap("paused-global").status.paused).toBe(true);
    expect(snap("finished").items.every(i => i.status === "completed" || i.name === "missing")).toBe(true);
  });

  it("takes the limit in KiB/s when it is on", () => {
    const s = toSnapshot("0.5.0", {}, [], [], 0, { on: true, kib: 2000 }, () => undefined);
    expect(s.status.speedLimitBps).toBe(2000 * 1024);
    expect(toSnapshot("0.5.0", {}, [], [], 0, { on: false, kib: 2000 }, () => undefined).status.speedLimitBps).toBe(0);
  });
});

describe("pyLoad package rules", () => {
  const st = (files: { status?: number; error?: string }[]): { status: string; error: string } =>
    packageStatus(files, () => undefined);

  it("never calls an empty package or a file without status finished", () => {
    expect(st([]).status).toBe("queued");
    expect(st([{}]).status).toBe("queued");
  });

  it("turns a bare status word into a sentence", () => {
    expect(st([{ status: 1, error: "temp. offline" }]).error).toBe("offline — the file is not available");
  });

  it("adds sizes, done bytes and the longest eta the adapter's way", () => {
    const snap = toSnapshot(
      "0.5.0",
      { speed: -1 },
      [
        { name: "no id", links: [] },
        {
          pid: 1,
          name: "p1",
          links: [
            { fid: 10, status: 12, size: 100 },
            { fid: 11, status: 12, size: 100 },
            { fid: 12, status: 4, size: 50 },
          ],
        },
        { pid: 2, name: "p2", links: [{ fid: 20, status: 13, size: 0 }] },
      ],
      [
        { fid: 10, bleft: 150, speed: 1, eta: 5 },
        { fid: 11, bleft: 50, speed: 1, eta: 3 },
        { fid: 20, bleft: 0, speed: 0, eta: 7 },
      ],
      1000,
      null,
      () => undefined,
    );
    expect(snap.items.map(i => i.key)).toEqual(["1", "2"]);
    expect(snap.items[0]).toMatchObject({ sizeBytes: 250, doneBytes: 100, etaSeconds: 5 });
    expect(snap.items[1]).toMatchObject({ sizeBytes: null, etaSeconds: null });
    expect(snap.status).toMatchObject({ paused: false, downloadBps: null });
  });
});
