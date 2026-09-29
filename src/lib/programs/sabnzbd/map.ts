import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { asRecord, asText, doneOf, epochMs, num } from "../../core/units";

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

/** The table as a lookup — a Map, so an inherited name like `constructor` is no status. */
const BY_RAW = new Map<string, Status>(statusTable);

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
  const s = BY_RAW.get(`${list}:${status}`);
  if (s === undefined) {
    debug(`sabnzbd: unknown slot status ${String(raw)} — shown as queued`);
    return "queued";
  }
  return s;
}

const scaled = (v: unknown, unit: number): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.round(n * unit) : null;
};
const category = (v: unknown): string => {
  const c = asText(v);
  return c === "*" ? "" : c;
};

/**
 * One poll into the common model: queue slots, then history entries (an id in both is a job that moved on — the
 * history entry wins).
 *
 * @param queue `mode=queue` → `queue`
 * @param history `mode=history` → `history.slots` (the last full list when SABnzbd reported no change)
 * @param debug debug log
 * @param ppPause `mode=status` → `pp_pause_event`: SABnzbd holds the queue itself for post-processing
 * @returns the snapshot
 */
export function toSnapshot(
  queue: Record<string, unknown>,
  history: readonly unknown[],
  debug: (msg: string) => void,
  ppPause = false,
): ProgramSnapshot {
  // SABnzbd pauses itself while post-processing when the user switched that on — not a pause of the user's
  const held = queue.paused === true;
  const paused = held && !ppPause;
  const byKey = new Map<string, DownloadItem>();
  let firstDownloading = true;
  for (const raw of Array.isArray(queue.slots) ? queue.slots : []) {
    const s = asRecord(raw);
    const key = asText(s.nzo_id);
    if (!key) {
      continue;
    }
    const rawStatus = asText(s.status);
    let status = mapSabStatus(`q:${rawStatus}`, debug);
    if (held) {
      status = paused ? "paused" : "queued";
    } else if (status === "downloading") {
      // SABnzbd calls every running slot "Downloading" — it works on the first one
      status = firstDownloading ? "downloading" : "queued";
      firstDownloading = false;
    }
    const size = scaled(s.mb, MiB);
    const left = scaled(s.mbleft, MiB);
    byKey.set(key, {
      key,
      name: asText(s.filename) || key,
      status,
      sizeBytes: size,
      doneBytes: doneOf(size, left),
      speedBps: null,
      etaSeconds: null,
      addedMs: epochMs(s.time_added),
      finishedMs: null,
      category: category(s.cat),
      error: "",
    });
  }
  for (const raw of history) {
    const h = asRecord(raw);
    const key = asText(h.nzo_id);
    if (!key) {
      continue;
    }
    const rawStatus = asText(h.status);
    const status = mapSabStatus(`h:${rawStatus}`, debug);
    const bytes = scaled(h.bytes, 1);
    byKey.set(key, {
      key,
      name: asText(h.name) || key,
      status,
      sizeBytes: bytes,
      doneBytes: scaled(h.downloaded, 1) ?? bytes,
      speedBps: null,
      etaSeconds: null,
      addedMs: null,
      finishedMs: status === "completed" || status === "failed" ? epochMs(h.completed) : null,
      category: category(h.category),
      error: status === "failed" ? asText(h.fail_message) : "",
    });
  }
  return {
    status: {
      version: asText(queue.version),
      paused,
      downloadBps: scaled(queue.kbpersec, 1024),
      speedLimitBps: scaled(queue.speedlimit_abs, 1) ?? 0,
      freeSpaceBytes: scaled(queue.diskspace1, GiB),
    },
    items: [...byKey.values()],
    complete: true,
  };
}
