import type { DownloadItem, Status } from "./model";
import { DONE } from "./visibility";

/** The downloads that finished and failed since the previous poll. */
export interface Transitions {
  /** Finished (completed or started seeding). */
  finished: DownloadItem[];
  /** Failed. */
  failed: DownloadItem[];
}

/**
 * @param items the poll's downloads
 * @param prev each download's status at the previous poll; null on the first poll after the start
 * @param lastFinish the `last.finishedTime` stored before the start — on the first poll only a download that finished
 *   after it is new
 * @returns which downloads finished and which failed — the first poll after the start reports no old failure
 */
export function transitions(
  items: readonly DownloadItem[],
  prev: ReadonlyMap<string, Status> | null,
  lastFinish: number | null,
): Transitions {
  const baseline = prev === null;
  const out: Transitions = { finished: [], failed: [] };
  for (const item of items) {
    const before = prev?.get(item.key);
    if (DONE.has(item.status) && (before === undefined ? isNewFinish(item, baseline, lastFinish) : !DONE.has(before))) {
      out.finished.push(item);
    }
    if (item.status === "failed" && !baseline && before !== "failed") {
      out.failed.push(item);
    }
  }
  return out;
}

function isNewFinish(item: DownloadItem, baseline: boolean, lastFinish: number | null): boolean {
  if (!baseline) {
    return true;
  }
  return lastFinish !== null && typeof item.finishedMs === "number" && item.finishedMs > lastFinish;
}
