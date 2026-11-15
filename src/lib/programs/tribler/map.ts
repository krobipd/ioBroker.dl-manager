import { RATIO_INFINITE, type DownloadItem, type ProgramSnapshot, type Status } from "../../core/model";
import { statusFrom } from "../../core/status";
import { asRecord, asText, epochMs, nonNegative, num, round2, sizeOf } from "../../core/units";

/**
 * One download of `GET /api/downloads` as the map reads it (downloads_endpoint.py `get_downloads`, 8.0.7 and 8.4).
 */
export interface TblDownload {
  /** Stable key, lower-case hex — every command takes it. */
  infohash?: unknown;
  /** Display name; the magnet's `dn` or the hash until the metadata is there. */
  name?: unknown;
  /** The name of Tribler's `DownloadStatus` — the numbers moved between versions (8.0.7 CIRCUITS = 8.4 LOADING = 8). */
  status?: unknown;
  /** libtorrent's progress 0…1 — during a hash check the share already checked (download_state.py `get_progress`). */
  progress?: unknown;
  /** Bytes of the torrent, 0 without metadata. */
  size?: unknown;
  /** Payload bytes per second, 0 unless DOWNLOADING or SEEDING; a finished download keeps its last rate. */
  speed_down?: unknown;
  /** Payload bytes per second up. */
  speed_up?: unknown;
  /** Seconds left: the bytes left over the rate, a huge number while the rate is 0. */
  eta?: unknown;
  /** Peers known (connected, or the tracker's scrape when larger). */
  num_peers?: unknown;
  /** Uploaded over completed bytes, -1 = infinite (uploaded with nothing completed), 0 without a handle. */
  all_time_ratio?: unknown;
  /** `repr()` of the error — a Python string in quotes (recording 8.4.2 `error`), "" while all is well. */
  error?: unknown;
  /** Seconds since 1970. */
  time_added?: unknown;
  /** Seconds since 1970, 0 until finished — 8.4 only. */
  time_finished?: unknown;
}

/**
 * Raw key `<status>`, `:done` for a stopped or queued download that has every byte, `:idle` for a download without
 * rate and peer. The names are 8.4's `DownloadStatus` plus 8.0.7's CIRCUITS (download_state.py, downloads_endpoint.py
 * `_get_extended_status`): LOADING, CIRCUITS and EXIT_NODES are a download whose anonymous circuits or DHT are not
 * ready yet. The table follows qBittorrent's: metadata and every check are checking, a queued finished one seeds.
 */
export const statusTable = [
  ["ALLOCATING_DISKSPACE", "checking"],
  ["WAITING_FOR_HASHCHECK", "checking"],
  ["HASHCHECKING", "checking"],
  ["METADATA", "checking"],
  ["DOWNLOADING", "downloading"],
  ["DOWNLOADING:idle", "waiting"],
  ["SEEDING", "seeding"],
  ["STOPPED", "paused"],
  ["STOPPED:done", "completed"],
  ["STOPPED_ON_ERROR", "failed"],
  ["LOADING", "waiting"],
  ["CIRCUITS", "waiting"],
  ["EXIT_NODES", "waiting"],
  ["MOVING", "postprocessing"],
  ["QUEUED", "queued"],
  ["QUEUED:done", "seeding"],
] as const satisfies readonly (readonly [string, Status])[];

const STATUS = new Map<string, Status>(statusTable);

/**
 * @param d one download
 * @returns whether every byte is there
 */
function finished(d: TblDownload): boolean {
  return (num(d.progress) ?? 0) >= 1;
}

/**
 * @param d one download
 * @returns the raw key of the status table
 */
export function rawStatus(d: TblDownload): string {
  const status = asText(d.status) || String(d.status);
  if ((status === "STOPPED" || status === "QUEUED") && finished(d)) {
    return `${status}:done`;
  }
  return status === "DOWNLOADING" && !num(d.speed_down) && !num(d.num_peers) ? "DOWNLOADING:idle" : status;
}

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapTblStatus(raw: string | number, debug: (msg: string) => void): Status {
  return statusFrom(STATUS, String(raw), "tribler", debug);
}

/**
 * @param error the `error` field — `repr()` of the error text
 * @returns the text without the quotes Python's `repr` puts around a string
 */
export function errorOf(error: unknown): string {
  const text = asText(error);
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

/**
 * @param settings `GET /api/settings` → `settings`
 * @param key `max_download_rate` or `max_upload_rate`
 * @returns bytes per second, 0 = unlimited; null while the scheduled limits of 8.4 (`use_advanced_rate_limits`) rule
 */
export function limitBps(
  settings: Record<string, unknown>,
  key: "max_download_rate" | "max_upload_rate",
): number | null {
  const lt = asRecord(settings.libtorrent);
  return lt.use_advanced_rate_limits === true ? null : nonNegative(lt[key]);
}

/**
 * One poll into the common model.
 *
 * @param version the program version (`GET /api/versioning/versions/current`)
 * @param downloads `GET /api/downloads` → `downloads`
 * @param settings `GET /api/settings` → `settings`
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  downloads: readonly Record<string, unknown>[],
  settings: Record<string, unknown>,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = [];
  for (const d of downloads as readonly TblDownload[]) {
    if (typeof d.infohash !== "string") {
      continue;
    }
    const status = mapTblStatus(rawStatus(d), debug);
    const size = sizeOf(d.size);
    const progress = nonNegative(d.progress);
    const ratio = num(d.all_time_ratio);
    // a finished download keeps the rate it last loaded at (8.0.7 `checking`: big.bin seeding at 922394)
    const speed = finished(d) ? 0 : nonNegative(d.speed_down);
    items.push({
      key: d.infohash,
      name: typeof d.name === "string" && d.name ? d.name : d.infohash,
      status,
      sizeBytes: size,
      // during a hash check the progress is the share checked, not the share there
      doneBytes:
        size !== null && progress !== null && asText(d.status) !== "HASHCHECKING" ? Math.round(size * progress) : null,
      speedBps: speed,
      uploadBps: nonNegative(d.speed_up),
      ratio: ratio === -1 ? RATIO_INFINITE : ratio !== null && ratio >= 0 ? round2(ratio) : null,
      etaSeconds: status === "downloading" && speed ? nonNegative(Math.round(num(d.eta) ?? -1)) : null,
      addedMs: epochMs(d.time_added),
      finishedMs: epochMs(d.time_finished),
      error: errorOf(d.error),
    });
  }
  const sum = (pick: (i: DownloadItem) => number | null | undefined): number =>
    items.reduce((total, i) => total + (pick(i) ?? 0), 0);
  return {
    status: {
      version,
      paused,
      // Tribler tells no session rate: the sum of its downloads
      downloadBps: sum(i => i.speedBps),
      uploadBps: sum(i => i.uploadBps),
      speedLimitBps: limitBps(settings, "max_download_rate"),
      uploadLimitBps: limitBps(settings, "max_upload_rate"),
    },
    items,
    complete: true,
  };
}
