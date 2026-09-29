import type { DownloadItem, Status } from "./model";

/**
 * Which downloads get a channel in the object tree (decision 7): the scope setting, and above the limit the best ranked
 * ones. Pure — the tree asks, nothing here writes.
 */

/** Which downloads the object tree shows (adapter setting `treeScope`). */
export type TreeScope = "all" | "withoutCompleted" | "unfinished";

/** The adapter settings that shape the object tree. */
export interface TreeOptions {
  /** Which downloads get a channel. */
  scope: TreeScope;
  /** At most this many download channels per program, 0 = no limit. */
  limit: number;
}

/** A download that is through: loaded completely (seeding ones too). */
export const DONE: ReadonlySet<Status> = new Set<Status>(["completed", "seeding"]);

/** Who keeps a channel when a program has more downloads than the limit — lower first. */
const RANK: Readonly<Record<Status, number>> = {
  downloading: 0,
  checking: 0,
  postprocessing: 0,
  failed: 1,
  paused: 2,
  waiting: 2,
  queued: 3,
  seeding: 4,
  completed: 5,
};

/**
 * The downloads that get a channel: those the scope admits, and of them — when there are more than the limit — the
 * best ranked ones, the newest first within a rank (finished downloads by their finish, the others by when they were
 * added; without a time in the program's own order).
 *
 * @param items all downloads of the poll
 * @param opts the tree settings
 * @returns the keys of the downloads to show
 */
export function shownKeys(items: readonly DownloadItem[], opts: TreeOptions): Set<string> {
  const admitted = items.filter(i => admits(opts.scope, i.status));
  const limit = opts.limit;
  if (limit <= 0 || admitted.length <= limit) {
    return new Set(admitted.map(i => i.key));
  }
  const time = (i: DownloadItem): number =>
    (DONE.has(i.status) ? (i.finishedMs ?? i.addedMs) : i.addedMs) ?? Number.NEGATIVE_INFINITY;
  const ranked = [...admitted].sort((a, b) => {
    const byRank = RANK[a.status] - RANK[b.status];
    if (byRank !== 0) {
      return byRank;
    }
    const ta = time(a);
    const tb = time(b);
    return ta === tb ? 0 : tb > ta ? 1 : -1;
  });
  return new Set(ranked.slice(0, limit).map(i => i.key));
}

/**
 * @param scope the tree setting
 * @param status a download's status
 * @returns whether the scope lets a download of this status have a channel
 */
function admits(scope: TreeScope, status: Status): boolean {
  switch (scope) {
    case "withoutCompleted":
      return status !== "completed";
    case "unfinished":
      return !DONE.has(status);
    default:
      return true;
  }
}
