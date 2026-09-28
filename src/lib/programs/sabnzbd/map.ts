import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { num } from "../../core/units";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Raw key `q:<queue slot status>` or `h:<history slot status>`; `q:*:globalPause` = queue header paused. */
export const statusTable = [
  ["q:Downloading", "downloading"],
  ["q:Fetching", "downloading"],
  ["q:Grabbing", "downloading"],
  ["q:Propagating", "waiting"],
  ["q:Checking", "checking"],
  ["q:Queued", "queued"],
  ["q:Paused", "paused"],
  ["q:Downloading:globalPause", "paused"],
  ["h:Queued", "postprocessing"],
  ["h:QuickCheck", "postprocessing"],
  ["h:Verifying", "postprocessing"],
  ["h:Repairing", "postprocessing"],
  ["h:Fetching", "postprocessing"],
  ["h:Extracting", "postprocessing"],
  ["h:Moving", "postprocessing"],
  ["h:Running", "postprocessing"],
  ["h:Completed", "completed"],
  ["h:Failed", "failed"],
  ["q:Idle", "queued"],
] as const satisfies readonly (readonly [string, Status])[];

const QUEUE: Readonly<Record<string, Status>> = {
  Downloading: "downloading",
  Fetching: "downloading",
  Grabbing: "downloading",
  Propagating: "waiting",
  Checking: "checking",
  Queued: "queued",
  Paused: "paused",
  Idle: "queued",
};
const HISTORY: Readonly<Record<string, Status>> = {
  Queued: "postprocessing",
  QuickCheck: "postprocessing",
  Verifying: "postprocessing",
  Repairing: "postprocessing",
  Fetching: "postprocessing",
  Extracting: "postprocessing",
  Moving: "postprocessing",
  Running: "postprocessing",
  Completed: "completed",
  Failed: "failed",
};

/**
 * @param raw a key of the status table
 * @param debug debug log, names an unknown slot status
 * @returns the status
 */
export function mapSabStatus(raw: string | number, debug: (msg: string) => void): Status {
  const [list, status, flag] = String(raw).split(":");
  if (list === "q" && flag === "globalPause") {
    return "paused";
  }
  const s = (list === "h" ? HISTORY : QUEUE)[status];
  if (s === undefined) {
    debug(`sabnzbd: unknown slot status ${String(raw)} — shown as queued`);
    return "queued";
  }
  return s;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const scaled = (v: unknown, unit: number): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.round(n * unit) : null;
};
const seconds = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n * 1000 : null;
};
const category = (v: unknown): string => {
  const c = text(v);
  return c === "*" ? "" : c;
};

/**
 * One poll into the common model: queue slots, then history entries (an id in both is a job that moved on — the
 * history entry wins).
 *
 * @param queue `mode=queue` → `queue`
 * @param history `mode=history` → `history.slots` (the last full list when SABnzbd reported no change)
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  queue: Record<string, unknown>,
  history: readonly unknown[],
  debug: (msg: string) => void,
): ProgramSnapshot {
  const paused = queue.paused === true;
  const byKey = new Map<string, DownloadItem>();
  let firstDownloading = true;
  for (const raw of Array.isArray(queue.slots) ? queue.slots : []) {
    const s = obj(raw);
    const key = text(s.nzo_id);
    if (!key) {
      continue;
    }
    const rawStatus = text(s.status);
    let status = mapSabStatus(`q:${rawStatus}`, debug);
    if (paused) {
      status = "paused";
    } else if (status === "downloading") {
      // SABnzbd calls every running slot "Downloading" — it works on the first one
      status = firstDownloading ? "downloading" : "queued";
      firstDownloading = false;
    }
    const size = scaled(s.mb, MiB);
    const left = scaled(s.mbleft, MiB);
    byKey.set(key, {
      key,
      name: text(s.filename) || key,
      status,
      rawStatus,
      sizeBytes: size,
      doneBytes: size !== null && left !== null ? Math.max(0, size - left) : null,
      speedBps: null,
      etaSeconds: null,
      addedMs: seconds(s.time_added),
      finishedMs: null,
      category: category(s.cat),
      error: "",
    });
  }
  for (const raw of history) {
    const h = obj(raw);
    const key = text(h.nzo_id);
    if (!key) {
      continue;
    }
    const rawStatus = text(h.status);
    const status = mapSabStatus(`h:${rawStatus}`, debug);
    const bytes = scaled(h.bytes, 1);
    byKey.set(key, {
      key,
      name: text(h.name) || key,
      status,
      rawStatus,
      sizeBytes: bytes,
      doneBytes: scaled(h.downloaded, 1) ?? bytes,
      speedBps: null,
      etaSeconds: null,
      addedMs: null,
      finishedMs: status === "completed" || status === "failed" ? seconds(h.completed) : null,
      category: category(h.category),
      error: status === "failed" ? text(h.fail_message) : "",
    });
  }
  return {
    status: {
      version: text(queue.version),
      paused,
      downloadBps: scaled(queue.kbpersec, 1024),
      speedLimitBps: scaled(queue.speedlimit_abs, 1) ?? 0,
      freeSpaceBytes: scaled(queue.diskspace1, GiB),
    },
    items: [...byKey.values()],
    complete: true,
  };
}
