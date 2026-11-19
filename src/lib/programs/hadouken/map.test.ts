import { ProtocolError } from "../../core/errors";
import { limitBps, PAUSED, QUEUED, rawStatus, runs, STARTED, toSnapshot, torrentOf } from "./map";

/**
 * @param status the status bits
 * @param progress per mille
 * @param more columns to set (index → value)
 * @returns a row of `webui.list` → `torrents` (webui_list.js, 27 columns)
 */
const row = (status: number, progress: number, more: Record<number, unknown> = {}): unknown[] => {
  const r: unknown[] = new Array(27).fill(0);
  Object.assign(r, { 0: "a".repeat(40), 1: status, 2: "x.bin", 3: 1000, 4: progress, 10: -1 }, more);
  return r;
};

describe("Hadouken rows", () => {
  it("refuses a row without its hash or with a status that is no whole number", () => {
    for (const odd of [
      null,
      {},
      row(1, 0, { 0: "" }),
      row(1, 0, { 0: 7 }),
      row(1, 0, { 1: 1.5 }),
      row(1, 0, { 1: "1" }),
    ]) {
      expect(() => torrentOf(odd)).toThrow(ProtocolError);
    }
    expect(torrentOf(row(STARTED, 0)).status).toBe(STARTED);
  });

  it("tells a queued torrent that has every byte from one that still loads, and leaves a row without bits unknown", () => {
    expect(rawStatus(torrentOf(row(QUEUED, 1000)))).toBe("Status_Queued_Up");
    expect(rawStatus(torrentOf(row(QUEUED, 400)))).toBe("Status_Queued_Down");
    expect(rawStatus(torrentOf(row(0, 400)))).toBe("");
  });

  it("halts what is started or queued and not paused", () => {
    expect([STARTED, QUEUED, STARTED | PAUSED, QUEUED | PAUSED, PAUSED, 0].map(runs)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("reads a limit in whole bytes per second, 0 and below as unlimited, none as unknown", () => {
    expect([limitBps(1500.6), limitBps(0), limitBps(-1), limitBps(null)]).toEqual([1501, 0, 0, null]);
  });

  it("gives no ETA beyond two years — the Web UI shows it as infinite", () => {
    const etaOf = (eta: number): number | null | undefined =>
      toSnapshot("5.2.0", [torrentOf(row(STARTED, 400, { 9: 100, 10: eta }))], {}, false, () => undefined).items[0]
        .etaSeconds;
    expect([etaOf(120), etaOf(63_072_000), etaOf(63_072_001)]).toEqual([120, 63_072_000, null]);
  });
});
