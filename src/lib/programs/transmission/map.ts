import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { eta, num } from "../../core/units";

/** A torrent of `torrent_get`, keys in snake_case (legacy answers are converted by snakeKeys). */
export interface TrTorrent {
  /** Stable id (the numeric `id` changes on a daemon restart). */
  hash_string?: unknown;
  /** Display name. */
  name?: unknown;
  /** 0 stopped · 1 check wait · 2 check · 3 download wait · 4 download · 5 seed wait · 6 seed. */
  status?: unknown;
  /** 0 ok · 1 tracker warning · 2 tracker error · 3 local error. */
  error?: unknown;
  /** The program's error text. */
  error_string?: unknown;
  /** 0..1 — 1 is "done" (a magnet without metadata reports left 0). */
  percent_done?: unknown;
  /** Bytes of the wanted files. */
  size_when_done?: unknown;
  /** Bytes still to load. */
  left_until_done?: unknown;
  /** Download rate, B/s. */
  rate_download?: unknown;
  /** Upload rate, B/s. */
  rate_upload?: unknown;
  /** Seconds, −1 not available, −2 unknown. */
  eta?: unknown;
  /** Ratio, −1 not available, −2 infinite. */
  upload_ratio?: unknown;
  /** Added, Unix seconds. */
  added_date?: unknown;
  /** Done, Unix seconds, 0 while not done. */
  done_date?: unknown;
  /** Labels (Transmission's categories). */
  labels?: unknown;
  /** Downloading without peers. */
  is_stalled?: unknown;
  /** Seed ratio reached — NOT "download finished". */
  is_finished?: unknown;
}

/**
 * Keys of an answer in snake_case: legacy (≤ 4.0) camelCase and kebab-case become the 4.1 names.
 *
 * @param v any JSON value
 * @returns the same value with converted object keys
 */
export function snakeKeys(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(snakeKeys);
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [
        k
          .replace(/-/g, "_")
          .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
          .toLowerCase(),
        snakeKeys(val),
      ]),
    );
  }
  return v;
}

/** Raw key `<status>:<error>:<detail>` (detail: left, done, stalled) and the status it maps to. */
export const statusTable = [
  ["0:0:left", "paused"],
  ["0:0:done", "completed"],
  ["1:0:left", "checking"],
  ["2:0:left", "checking"],
  ["3:0:left", "queued"],
  ["4:0:left", "downloading"],
  ["4:0:stalled", "waiting"],
  ["5:0:done", "seeding"],
  ["6:0:done", "seeding"],
  ["4:1:left", "downloading"],
  ["4:2:left", "downloading"],
  ["6:2:done", "seeding"],
  ["0:2:left", "failed"],
  ["4:3:left", "failed"],
  ["0:3:done", "failed"],
] as const satisfies readonly (readonly [string, Status])[];

/**
 * @param raw a key of the status table
 * @returns the torrent it stands for
 */
export function trTorrentFromRaw(raw: string): TrTorrent {
  const [status, error, detail] = raw.split(":");
  const done = detail === "done";
  return {
    status: Number(status),
    error: Number(error),
    percent_done: done ? 1 : 0.5,
    left_until_done: done ? 0 : 1000,
    is_stalled: detail === "stalled",
  };
}

/**
 * @param t a torrent
 * @param debug debug log, names an unknown status number
 * @returns status and the program's text
 */
export function trStatus(t: TrTorrent, debug: (msg: string) => void): { status: Status; error: string } {
  const code = num(t.status);
  const err = num(t.error) ?? 0;
  const text = typeof t.error_string === "string" ? t.error_string : "";
  const running = code === 4 || code === 6;
  if (err === 3 || (err === 2 && !running)) {
    return { status: "failed", error: text };
  }
  const note = err === 1 || err === 2 ? text : "";
  switch (code) {
    case 0:
      return { status: t.percent_done === 1 ? "completed" : "paused", error: note };
    case 1:
    case 2:
      return { status: "checking", error: note };
    case 3:
      return { status: "queued", error: note };
    case 4:
      return { status: t.is_stalled === true ? "waiting" : "downloading", error: note };
    case 5:
    case 6:
      return { status: "seeding", error: note };
    default:
      debug(`transmission: unknown status ${String(t.status)} — shown as queued`);
      return { status: "queued", error: note };
  }
}

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapTrStatus(raw: string | number, debug: (msg: string) => void): Status {
  return trStatus(trTorrentFromRaw(String(raw)), m => debug(`${m} (raw ${raw})`)).status;
}

const nonNegative = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};
const seconds = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n * 1000 : null;
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * @param session `session_get`
 * @returns bytes per "kB" of the speed limits (1000 or 1024)
 */
export function speedUnit(session: Record<string, unknown>): number {
  const u = num(obj(session.units).speed_bytes);
  return u === 1024 ? 1024 : 1000;
}

/**
 * One poll into the common model.
 *
 * @param version the program version
 * @param torrents `torrent_get.torrents` (snake_case)
 * @param session `session_get`
 * @param stats `session_stats`
 * @param free `free_space(download_dir)`
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  torrents: readonly unknown[],
  session: Record<string, unknown>,
  stats: Record<string, unknown>,
  free: Record<string, unknown>,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const unit = speedUnit(session);
  const limit = (value: unknown, enabled: unknown): number => (enabled === true ? (nonNegative(value) ?? 0) * unit : 0);
  const items: DownloadItem[] = [];
  for (const raw of torrents) {
    const t = obj(raw) as TrTorrent;
    if (typeof t.hash_string !== "string") {
      continue;
    }
    const { status, error } = trStatus(t, debug);
    const size = nonNegative(t.size_when_done);
    const left = nonNegative(t.left_until_done);
    const ratio = num(t.upload_ratio);
    items.push({
      key: t.hash_string,
      name: typeof t.name === "string" ? t.name : t.hash_string,
      status,
      rawStatus: `${String(t.status)}:${String(t.error)}`,
      sizeBytes: size,
      doneBytes: size !== null && left !== null ? Math.max(0, size - left) : null,
      speedBps: nonNegative(t.rate_download),
      uploadBps: nonNegative(t.rate_upload),
      ratio: ratio !== null && ratio >= 0 ? ratio : null,
      etaSeconds: eta(t.eta, []),
      addedMs: seconds(t.added_date),
      finishedMs: seconds(t.done_date),
      category: Array.isArray(t.labels) ? t.labels.filter(l => typeof l === "string").join(", ") : "",
      error,
    });
  }
  return {
    status: {
      version,
      paused,
      downloadBps: nonNegative(stats.download_speed),
      uploadBps: nonNegative(stats.upload_speed),
      speedLimitBps: limit(session.speed_limit_down, session.speed_limit_down_enabled),
      uploadLimitBps: limit(session.speed_limit_up, session.speed_limit_up_enabled),
      altSpeed: session.alt_speed_enabled === true,
      freeSpaceBytes: nonNegative(free.size_bytes) ?? nonNegative(session.download_dir_free_space),
    },
    items,
    complete: true,
  };
}
