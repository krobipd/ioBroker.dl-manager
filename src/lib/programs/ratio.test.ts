import { RATIO_INFINITE } from "../core/model";
import { toSnapshot as deluge } from "./deluge/map";
import { MaindataState, toSnapshot as qbittorrent } from "./qbittorrent/map";
import { toSnapshot as transmission } from "./transmission/map";

const quiet = (): void => undefined;
const ratioOf = {
  deluge: (ratio: number): unknown =>
    deluge("2.2.0", { torrents: { h: { name: "t", state: "Seeding", ratio } }, stats: {} }, {}, false, quiet).items[0]
      .ratio,
  qbittorrent: (ratio: number): unknown => {
    const m = new MaindataState();
    m.apply({ full_update: true, rid: 1, torrents: { h: { name: "t", state: "uploading", ratio } } });
    return qbittorrent("v5.2.3", m, false, quiet).items[0].ratio;
  },
  transmission: (upload_ratio: number): unknown =>
    transmission("4.1.3", [{ hash_string: "h", name: "t", status: 6, upload_ratio }], {}, {}, {}, false, quiet).items[0]
      .ratio,
};

// "infinite" is a value the program reports instead of a ratio: a number outside the range with a label, never null —
// "not available" is no value and stays null (krobi 2026-08-19 / 2026-10-15, review S2)
describe("a ratio the program reports as infinite", () => {
  it("is -1 for every program", () => {
    expect(RATIO_INFINITE).toBe(-1);
    expect(ratioOf.deluge(-1)).toBe(RATIO_INFINITE);
    expect(ratioOf.qbittorrent(-1)).toBe(RATIO_INFINITE);
    expect(ratioOf.transmission(-2)).toBe(RATIO_INFINITE);
  });

  it("leaves Transmission's not available empty and keeps a real ratio", () => {
    expect(ratioOf.transmission(-1)).toBeNull();
    expect(ratioOf.transmission(1.5)).toBe(1.5);
    expect(ratioOf.qbittorrent(0.25)).toBe(0.25);
    expect(ratioOf.deluge(2)).toBe(2);
  });

  it("leaves any other negative value empty", () => {
    expect(ratioOf.deluge(-2)).toBeNull();
    expect(ratioOf.qbittorrent(-2)).toBeNull();
    expect(ratioOf.transmission(-3)).toBeNull();
  });
});
