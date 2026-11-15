import { ProtocolError } from "../../core/errors";
import { RATIO_INFINITE, type DownloadItem } from "../../core/model";
import { limitBps, rawStatus, runs, toSnapshot, torrentOf } from "./map";

const quiet = (): void => undefined;

/**
 * A row of µTorrent's list as the recording has it (30 fields).
 *
 * @param status status bits
 * @param over fields by position
 * @returns the row
 */
function row(status: number, over: Record<number, unknown> = {}): unknown[] {
  const r: unknown[] = ["ABC", status, "t.bin", 1000, 500, 0, 0, 0, 0, 100, 5, "", 0, 0, 0, 0, 0, 1, 500];
  r.push("", "", "Downloading", "1", 1794723053, 0, "", "/data", 0, "X", false);
  for (const [k, v] of Object.entries(over)) {
    r[Number(k)] = v;
  }
  return r;
}

const item = (status: number, over: Record<number, unknown> = {}): DownloadItem =>
  toSnapshot("3.3.0.30470", [torrentOf(row(status, over))], [], false, quiet).items[0];

describe("µTorrent's rows", () => {
  it("reads the status bits in the order of µTorrent's own Web UI (webui.js getStatusInfo)", () => {
    // paused before started, started before checking, checking before error, error before queued
    expect(rawStatus(torrentOf(row(1 | 32 | 128)))).toBe("Status_Paused");
    expect(rawStatus(torrentOf(row(1 | 2 | 128)))).toBe("Status_Down");
    expect(rawStatus(torrentOf(row(1 | 128, { 4: 1000 })))).toBe("Status_Up");
    expect(rawStatus(torrentOf(row(2 | 16 | 128)))).toBe("Status_Checking");
    expect(rawStatus(torrentOf(row(16 | 64 | 128)))).toBe("Status_Error");
    expect(rawStatus(torrentOf(row(64 | 128, { 4: 1000 })))).toBe("Status_Queued_Up");
    expect(rawStatus(torrentOf(row(136, { 4: 1000 })))).toBe("Status_Completed");
    expect(rawStatus(torrentOf(row(136)))).toBe("Status_Incomplete");
  });

  it("halts what is started or queued and not paused — never a stopped, failed or paused one", () => {
    expect([201, 200, 137, 194].map(runs)).toEqual([true, true, true, true]);
    expect([136, 152, 233, 232, 130].map(runs)).toEqual([false, false, false, false, false]);
  });

  it("reads -1 as an infinite ratio and per mille otherwise", () => {
    expect(item(201, { 7: -1 }).ratio).toBe(RATIO_INFINITE);
    expect(item(201, { 7: 1500 }).ratio).toBe(1.5);
  });

  it("reads an ETA of 0, -1 or over two years as none (webui.js, utils.js toTimeDelta)", () => {
    expect(item(201, { 10: 113 }).etaSeconds).toBe(113);
    expect(item(201, { 10: 0 }).etaSeconds).toBeNull();
    expect(item(201, { 10: -1 }).etaSeconds).toBeNull();
    expect(item(201, { 10: 63_072_001 }).etaSeconds).toBeNull();
  });

  it("loads the bytes as size minus remaining, a magnet's 0 bytes as unknown, and its error only with the error bit", () => {
    expect(item(201).doneBytes).toBe(500);
    expect(item(201, { 3: 0, 18: 0 }).sizeBytes).toBeNull();
    expect(item(201, { 21: "Error: x" }).error).toBe("");
    expect(item(152, { 21: "Error: x" }).error).toBe("Error: x");
  });

  it("refuses a row without its hash or status", () => {
    expect(() => torrentOf(row(201, { 0: null }))).toThrow(ProtocolError);
    expect(() => torrentOf(row(201, { 1: "201" }))).toThrow(ProtocolError);
    expect(() => torrentOf({})).toThrow(ProtocolError);
  });

  it("reads a limit of 0 or below as unlimited and refuses no unknown one", () => {
    expect(limitBps("2000")).toBe(2_048_000);
    expect(limitBps("0")).toBe(0);
    expect(limitBps("-1")).toBe(0);
    expect(limitBps(undefined)).toBeNull();
  });
});
