import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { num } from "../../core/units";

/** A file of a pyLoad package (`get_queue_data` → `links`). */
export interface PyFile {
  /** File id. */
  fid?: unknown;
  /** Status code (0 finished … 14 unknown). */
  status?: unknown;
  /** Error text. */
  error?: unknown;
  /** Size in bytes. */
  size?: unknown;
}

/** Raw key = the status code of a one-file package. */
export const statusTable = [
  [0, "completed"],
  [1, "failed"],
  [2, "queued"],
  [3, "queued"],
  [4, "completed"],
  [5, "waiting"],
  [6, "waiting"],
  [7, "downloading"],
  [8, "failed"],
  [9, "paused"],
  [10, "postprocessing"],
  [11, "queued"],
  [12, "downloading"],
  [13, "postprocessing"],
  [14, "queued"],
] as const satisfies readonly (readonly [number, Status])[];

const KNOWN = new Set<number>(statusTable.map(([code]) => code));

/** pyLoad's own words for its file states — as an error they need a sentence. */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  1: "offline — the file is not available",
  6: "temporarily offline — pyLoad tries again later",
  8: "failed",
};
const STATUS_WORDS = new Set(["offline", "temp. offline", "failed", ""]);

/**
 * @param code the file's status code
 * @param error pyLoad's error field
 * @returns the error as a sentence: pyLoad's own text, or for its bare status word the meaning of the code
 */
function errorText(code: number, error: unknown): string {
  const e = typeof error === "string" ? error.trim() : "";
  return STATUS_WORDS.has(e.toLowerCase()) ? (STATUS_TEXT[code] ?? e) : e;
}

/**
 * The status of a package from its files' codes (`core/datatypes/enums.py`).
 *
 * @param files the package's files
 * @param debug debug log, names an unknown code
 * @returns status and the error of a failed file
 */
export function packageStatus(
  files: readonly PyFile[],
  debug: (msg: string) => void,
): { status: Status; error: string } {
  const codes = files.map(f => num(f.status) ?? 14);
  for (const c of codes) {
    if (!KNOWN.has(c)) {
      debug(`pyload: unknown file status ${c} — shown as queued`);
    }
  }
  const has = (...set: number[]): boolean => codes.some(c => set.includes(c));
  if (has(12, 7)) {
    return { status: "downloading", error: "" };
  }
  if (has(13, 10)) {
    return { status: "postprocessing", error: "" };
  }
  if (codes.length > 0 && codes.every(c => c === 0 || c === 4)) {
    return { status: "completed", error: "" };
  }
  const failed = files.find(f => [8, 1].includes(num(f.status) ?? -1));
  if (failed) {
    return { status: "failed", error: errorText(num(failed.status) ?? 8, failed.error) };
  }
  if (has(9)) {
    return { status: "paused", error: "" };
  }
  if (has(5, 6)) {
    return { status: "waiting", error: "" };
  }
  return { status: "queued", error: "" };
}

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw a file status code
 * @param debug debug log
 * @returns the status
 */
export function mapPyStatus(raw: string | number, debug: (msg: string) => void): Status {
  return packageStatus([{ status: Number(raw) }], debug).status;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);
const nonNegative = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};

/**
 * One poll into the common model. A download is a pyLoad package (design decision 3).
 *
 * @param version `get_server_version`
 * @param server `status_server`
 * @param queue `get_queue_data`
 * @param active `status_downloads` (speed and bytes left of the files that run)
 * @param free `free_space`
 * @param limit the download limit, null when not read yet
 * @param limit.on limit switched on
 * @param limit.kib limit in KiB/s
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  server: unknown,
  queue: unknown,
  active: unknown,
  free: unknown,
  limit: { on: boolean; kib: number } | null,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const running = new Map<number, Record<string, unknown>>();
  for (const d of list(active)) {
    const fid = num(d.fid);
    if (fid !== null) {
      running.set(fid, d);
    }
  }
  const items: DownloadItem[] = [];
  for (const p of list(queue)) {
    const pid = num(p.pid);
    if (pid === null) {
      continue;
    }
    const files = list(p.links) as PyFile[];
    const { status, error } = packageStatus(files, debug);
    let size = 0;
    let done = 0;
    let speed = 0;
    let eta: number | null = null;
    for (const f of files) {
      const s = nonNegative(f.size) ?? 0;
      size += s;
      const run = running.get(num(f.fid) ?? -1);
      if (run) {
        done += Math.max(0, s - (nonNegative(run.bleft) ?? s));
        speed += nonNegative(run.speed) ?? 0;
        const e = nonNegative(run.eta);
        eta = e !== null ? Math.max(eta ?? 0, e) : eta;
      } else if (num(f.status) === 0 || num(f.status) === 4) {
        done += s;
      }
    }
    items.push({
      key: String(pid),
      name: typeof p.name === "string" ? p.name : String(pid),
      status,
      sizeBytes: size > 0 ? size : null,
      doneBytes: done,
      speedBps: speed,
      etaSeconds: status === "downloading" && eta ? eta : null,
      error,
    });
  }
  const s = obj(server);
  return {
    status: {
      version,
      paused: s.pause === true,
      downloadBps: nonNegative(s.speed),
      ...(limit ? { speedLimitBps: limit.on && limit.kib > 0 ? Math.round(limit.kib * 1024) : 0 } : {}),
      freeSpaceBytes: nonNegative(free),
    },
    items,
    complete: true,
  };
}
