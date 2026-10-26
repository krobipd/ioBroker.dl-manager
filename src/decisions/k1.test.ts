// Core decision K1 (accepted 2026-10-22, krobi: "alle soweit ok"): a download is the unit the user added — a
// JDownloader or pyLoad package with 20 files is one channel, not 20; likewise a torrent, an NZB job, an aria2 download
// (its top GID).
import { describe, expect, it } from "vitest";
import { toSnapshot as aria2 } from "../lib/programs/aria2/map";
import { toSnapshot as jdownloader } from "../lib/programs/jdownloader/map";
import { toSnapshot as pyload } from "../lib/programs/pyload/map";
import { MaindataState, toSnapshot as qbittorrent } from "../lib/programs/qbittorrent/map";

const quiet = (): void => undefined;

describe("K1 a download is the unit the user added", () => {
  it("makes one download of a JDownloader package, however many links it holds", () => {
    const packages = [
      { uuid: 10, name: "holiday", bytesTotal: 300, bytesLoaded: 100 },
      { uuid: 11, name: "single", bytesTotal: 50, bytesLoaded: 0 },
    ];
    const link = (uuid: number, packageUUID: number): Record<string, unknown> => ({
      uuid,
      packageUUID,
      name: `part${uuid}.rar`,
      enabled: true,
    });
    const links = [link(1, 10), link(2, 10), link(3, 10), link(4, 11)];
    const s = jdownloader("2.0", {}, packages, links, quiet);
    expect(s.items.map(i => i.key)).toEqual(["10", "11"]);
    expect(s.items[0]).toMatchObject({ name: "holiday", sizeBytes: 300 });
  });

  it("makes one download of a pyLoad package, however many files it holds", () => {
    const queue = [
      {
        pid: 5,
        name: "series",
        links: [
          { fid: 1, status: 3 },
          { fid: 2, status: 3 },
          { fid: 3, status: 3 },
        ],
      },
    ];
    const s = pyload("0.5", {}, queue, [], null, null, quiet);
    expect(s.items.map(i => i.key)).toEqual(["5"]);
  });

  it("makes one download of an aria2 download — the one the user added, not the parts it was split into", () => {
    const entries = [
      { gid: "meta", status: "complete", followedBy: ["real"], files: [{ path: "[METADATA]x" }] },
      { gid: "real", status: "active", following: "meta", downloadSpeed: "10", files: [{ path: "/d/x.iso" }] },
    ];
    const s = aria2("1.37", entries, {}, {}, false, quiet);
    expect(s.items.map(i => i.key)).toEqual(["real"]);
  });

  it("makes one download of a torrent, however many files it holds", () => {
    const m = new MaindataState();
    m.apply({ full_update: true, torrents: { abc: { name: "distro", state: "downloading", size: 900 } } });
    expect(qbittorrent("v5.0.0", m, false, quiet).items.map(i => i.key)).toEqual(["abc"]);
  });
});
