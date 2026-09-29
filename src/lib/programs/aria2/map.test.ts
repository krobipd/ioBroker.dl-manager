import { loadFixture } from "../../../../test/helpers/fixtures";
import { ariaName, mapAriaStatus, statusTable, toSnapshot } from "./map";

const result = (state: string, name: string): unknown =>
  (loadFixture("aria2", "1.37.0", state, name).body as { result: unknown }).result;
const snap = (state: string, paused = false): ReturnType<typeof toSnapshot> =>
  toSnapshot(
    "1.37.0",
    [
      ...(result(state, "tell-active") as unknown[]),
      ...(result(state, "tell-waiting") as unknown[]),
      ...(result(state, "tell-stopped") as unknown[]),
    ],
    result(state, "global-stat"),
    result(state, "global-option"),
    paused,
    () => undefined,
  );

describe("aria2 status", () => {
  it("maps every row of the status table", () => {
    for (const [raw, expected] of statusTable) {
      expect([raw, mapAriaStatus(raw, () => undefined)]).toEqual([raw, expected]);
    }
  });

  it("names an unknown status in a debug line", () => {
    const lines: string[] = [];
    expect(mapAriaStatus("unknown", m => lines.push(m))).toBe("queued");
    expect(lines.join()).toContain("unknown");
  });

  it("names a download after its torrent, its file, or else its URL", () => {
    expect(ariaName({ bittorrent: { info: { name: "Ubuntu" } }, files: [] })).toBe("Ubuntu");
    expect(ariaName({ files: [{ path: "/downloads/a/b.iso", uris: [] }] })).toBe("b.iso");
    expect(ariaName({ files: [{ path: "", uris: [{ uri: "http://seed:8080/big.bin" }] }] })).toBe(
      "http://seed:8080/big.bin",
    );
  });
});

describe("aria2 snapshot from the recorded answers (1.37.0)", () => {
  it("maps active, waiting, paused, complete and error", () => {
    const s = snap("running");
    const by = (status: string): string[] => s.items.filter(i => i.status === status).map(i => i.name);
    expect(s.items).toHaveLength(5);
    expect(by("completed")).toEqual(["small.bin"]);
    expect(by("failed")).toEqual(["http://seed:8080/missing.bin"]);
    expect(by("paused")).toHaveLength(1);
    expect(s.items.find(i => i.status === "failed")?.error).not.toBe("");
    expect(s.status).toMatchObject({ version: "1.37.0", downloadBps: 1069429, speedLimitBps: 0, uploadLimitBps: 0 });
  });

  it("hides removed downloads", () => {
    expect(snap("finished").items.some(i => i.name.includes("nobody-seeds-this"))).toBe(false);
  });

  it("reads the overall limits in bytes", () => {
    expect(snap("limited").status).toMatchObject({ speedLimitBps: 2097152, uploadLimitBps: 512000 });
  });

  it("folds a metadata download into the one that follows it", () => {
    const s = toSnapshot(
      "1.37.0",
      [
        { gid: "a", status: "complete", followedBy: ["b"], files: [{ path: "[METADATA]x", uris: [] }] },
        {
          gid: "b",
          status: "active",
          following: "a",
          downloadSpeed: "5",
          totalLength: "10",
          completedLength: "5",
          files: [{ path: "/d/x" }],
        },
      ],
      {},
      {},
      false,
      () => undefined,
    );
    expect(s.items.map(i => i.key)).toEqual(["b"]);
    expect(s.items[0].etaSeconds).toBe(1);
  });
});

describe("aria2 edge values", () => {
  it("calls an active download without speed waiting and keeps unknown values unknown", () => {
    const snap = toSnapshot(
      "1.37.0",
      [
        { gid: "a", status: "active", downloadSpeed: "0", totalLength: "0", uploadSpeed: "-1", errorMessage: "old" },
        { gid: "b", status: "error", errorMessage: "404 Not Found", errorCode: "3" },
      ],
      {},
      {},
      false,
      () => undefined,
    );
    expect(snap.items[0]).toMatchObject({ status: "waiting", sizeBytes: null, uploadBps: null, error: "" });
    expect(snap.items[1].error).toBe("404 Not Found");
  });
});
