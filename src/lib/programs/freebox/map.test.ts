import { loadFixture } from "../../../../test/helpers/fixtures";
import { ProtocolError } from "../../core/errors";
import { isRunning, limitsOf, rawStatus, taskOf, tasksOf, toSnapshot, versionOf } from "./map";

/**
 * @param name the list's fixture
 * @returns its tasks, a copy
 */
const rows = (name: string): Record<string, unknown>[] =>
  structuredClone((loadFixture("freebox", "v8", "queue", name).body as { result: Record<string, unknown>[] }).result);
/** The built list: 501 done, 502 failed, 503–505 nzb post-processing, 506 starting, 507 stopping, 508 retry, 509 queued, 510 downloading, 511 failed. */
const states = (): Record<string, unknown>[] => rows("list-states");
const quiet = (): void => undefined;
const limits = { down: null, up: null };

describe("Freebox map", () => {
  it("refuses a task without a numeric id or its status", () => {
    const [done] = states();
    expect(() => taskOf({ ...done, id: "501" })).toThrow(ProtocolError);
    expect(() => taskOf({ ...done, status: "" })).toThrow(ProtocolError);
    expect(() => taskOf({ ...done, status: undefined })).toThrow(ProtocolError);
    expect(() => tasksOf([done, null])).toThrow(ProtocolError);
  });

  it("reads checking as post-processing only for an NZB — a torrent's checking is its data check", () => {
    const nzb = taskOf(states()[2]);
    const bt = taskOf(rows("list-checking")[2]);
    expect([nzb.type, rawStatus(nzb)]).toEqual(["nzb", "checking:nzb"]);
    expect([bt.type, rawStatus(bt)]).toEqual(["bt", "checking"]);
  });

  it("halts what loads, seeds, waits for its turn or checks a torrent's data — never what stops, post-processes or ended", () => {
    const running = states()
      .map(taskOf)
      .filter(isRunning)
      .map(t => t.id);
    expect(running).toEqual(["506", "508", "509", "510"]);
    expect(isRunning(taskOf(rows("list")[0]))).toBe(true);
    // a torrent in its data check loads right after it (a running Freebox: stopped → checking → downloading)
    expect(rows("list-checking").map(taskOf).filter(isRunning)).toHaveLength(8);
  });

  it("keeps the share loaded within the size, and reads an unknown size as unknown", () => {
    const [loading] = rows("list-checking");
    const [over, unknownSize] = toSnapshot(
      "16.0",
      [taskOf({ ...loading, rx_pct: 12_000 }), taskOf({ ...loading, id: 900, size: 0 })],
      limits,
      false,
      quiet,
    ).items;
    expect(over.doneBytes).toBe(over.sizeBytes);
    expect([unknownSize.sizeBytes, unknownSize.doneBytes, unknownSize.ratio]).toEqual([null, null, null]);
    // 70 of 10000 of 5.26 GB
    expect(toSnapshot("16.0", [taskOf(loading)], limits, false, quiet).items[0].doneBytes).toBe(36_820_000);
  });

  it("reads what a torrent loaded while its data is checked from rx_bytes — rx_pct is then the check's progress", () => {
    // a running Freebox: 420 stopped at rx_pct 454, checked at 1040; rx_bytes 249460000 in both lists
    const stopped = taskOf(rows("list-stopped")[3]);
    const checked = taskOf(rows("list-checking")[3]);
    const [before, during] = toSnapshot("16.0", [stopped, checked], limits, false, quiet).items;
    expect([before.status, during.status]).toEqual(["paused", "checking"]);
    expect(during.doneBytes).toBe(249_460_000);
    expect(Math.abs((before.doneBytes ?? 0) - 249_460_000) / 249_460_000).toBeLessThan(0.02);
    const [over, unknown] = toSnapshot(
      "16.0",
      [taskOf({ ...checked.row, rx_bytes: 9e12 }), taskOf({ ...checked.row, id: 902, rx_bytes: null })],
      limits,
      false,
      quiet,
    ).items;
    expect([over.doneBytes, unknown.doneBytes]).toEqual([5_400_000_000, null]);
  });

  it("gives no time left at a rate of 0 and the Freebox's own for a slow one (a running Freebox: 1103101952 s at 2 B/s)", () => {
    const [stalled] = rows("list-checking");
    const slow = { ...stalled, id: 901, rx_rate: 2, eta: 1_103_101_952 };
    const items = toSnapshot("16.0", [taskOf({ ...stalled, eta: 0 }), taskOf(slow)], limits, false, quiet).items;
    expect(items.map(i => i.etaSeconds)).toEqual([null, 1_103_101_952]);
  });

  it("names no error for a failed task whose code is none, and none for a task that did not fail", () => {
    const [, failed, , , , , , , , loading] = states();
    const items = toSnapshot(
      "16.0",
      [taskOf({ ...failed, error: "none" }), taskOf({ ...loading, error: "timeout" })],
      limits,
      false,
      quiet,
    ).items;
    expect(items.map(i => [i.status, i.error])).toEqual([
      ["failed", ""],
      ["downloading", ""],
    ]);
  });

  it("reads the limits of the normal mode, unknown when the config has none", () => {
    const config = (loadFixture("freebox", "v8", "config", "get").body as { result: unknown }).result;
    expect(limitsOf(config)).toEqual({ down: 0, up: 0 });
    expect(limitsOf({ throttling: { normal: { rx_rate: 512_000, tx_rate: 42_000 } } })).toEqual({
      down: 512_000,
      up: 42_000,
    });
    expect(limitsOf({ throttling: {} })).toEqual({ down: null, up: null });
  });

  it("refuses an api_version answer without its version", () => {
    const answer = loadFixture("freebox", "v8", "app", "api-version").body as Record<string, unknown>;
    expect(versionOf(answer)).toBe("16.0");
    expect(() => versionOf({ ...answer, api_version: 16 })).toThrow(ProtocolError);
    expect(() => versionOf({})).toThrow(ProtocolError);
  });
});
