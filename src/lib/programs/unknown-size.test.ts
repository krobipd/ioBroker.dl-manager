import { toSnapshot as aria2 } from "./aria2/map";
import { toSnapshot as deluge } from "./deluge/map";
import { toSnapshot as pyload } from "./pyload/map";
import { MaindataState, toSnapshot as qbittorrent } from "./qbittorrent/map";
import { toSnapshot as transmission } from "./transmission/map";

const quiet = (): void => undefined;

// A magnet without metadata yet reports a size of 0 — the size is unknown, never 0 bytes (review S1, model.ts).
describe("a size the program does not know yet", () => {
  it("is empty for Deluge", () => {
    const ui = { torrents: { h: { name: "m", state: "Downloading", total_wanted: 0, total_done: 0 } }, stats: {} };
    expect(deluge("2.2.0", ui, {}, false, quiet).items[0].sizeBytes).toBeNull();
  });

  it("is empty for qBittorrent", () => {
    const m = new MaindataState();
    m.apply({ full_update: true, rid: 1, torrents: { h: { name: "m", state: "metaDL", size: 0, completed: 0 } } });
    expect(qbittorrent("v5.2.3", m, false, quiet).items[0].sizeBytes).toBeNull();
  });

  it("is empty for Transmission", () => {
    const t = { hash_string: "h", name: "m", status: 4, size_when_done: 0, left_until_done: 0 };
    expect(transmission("4.1.3", [t], {}, {}, {}, false, quiet).items[0].sizeBytes).toBeNull();
  });

  it("is empty for aria2", () => {
    const e = { gid: "g", status: "active", totalLength: "0", completedLength: "0" };
    expect(aria2("1.37.0", [e], {}, {}, false, quiet).items[0].sizeBytes).toBeNull();
  });

  it("is empty for pyLoad", () => {
    const queue = [{ pid: 1, name: "m", links: [{ fid: 1, status: 3, size: 0 }] }];
    expect(pyload("0.5.0", {}, queue, [], 0, null, quiet).items[0].sizeBytes).toBeNull();
  });
});
