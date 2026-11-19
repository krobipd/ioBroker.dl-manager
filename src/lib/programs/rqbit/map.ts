import { recordIn } from "../../core/answer";
import { ProtocolError } from "../../core/errors";
import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { statusFrom } from "../../core/status";
import { asRecord, asText, nonNegative, num, round2, sizeOf } from "../../core/units";

/** Bytes per "mbps" of rqbit — a Speed is MiB/s (`Speed::as_bytes`, torrent_state/stats.rs). */
const MIB = 1024 * 1024;

/** One torrent of `GET /torrents?with_stats=true` (api.rs `TorrentDetailsResponse`). */
export interface RqTorrent {
  /** Stable key — every command takes it in place of the numeric id. */
  info_hash?: unknown;
  /** Display name, null while a magnet has no metadata. */
  name?: unknown;
  /** `TorrentStats` (torrent_state/stats.rs). */
  stats?: unknown;
}

/** The stats of one torrent (torrent_state/stats.rs `TorrentStats`). */
interface RqStats {
  /** `initializing` · `live` · `paused` · `error`. */
  state?: unknown;
  /** 9.x: a torrent paused during its check stays `initializing` with this set (recording `checking-paused`). */
  initializing_paused?: unknown;
  /** The program's error text. */
  error?: unknown;
  /** Bytes of the torrent that are on disk. */
  progress_bytes?: unknown;
  /** Bytes uploaded. */
  uploaded_bytes?: unknown;
  /** Bytes of the wanted files. */
  total_bytes?: unknown;
  /** All wanted bytes are on disk. */
  finished?: unknown;
  /** Only while live: speeds and the time left. */
  live?: unknown;
}

/**
 * Raw key `<state>:<finished>` and the status it maps to. The `error:*` rows come from the source
 * (torrent_state/stats.rs `TorrentStatsState::Error`) — no recording reaches them: a torrent whose file cannot be
 * created is refused by the add itself (HTTP 400, `commands/torrents-post-readonly`).
 */
export const statusTable = [
  ["initializing:left", "checking"],
  ["initializing:done", "checking"],
  ["live:left", "downloading"],
  ["live:stalled", "waiting"],
  ["live:done", "seeding"],
  ["paused:left", "paused"],
  ["paused:done", "completed"],
  ["error:left", "failed"],
  ["error:done", "failed"],
] as const satisfies readonly (readonly [string, Status])[];

const STATUS = new Map<string, Status>(statusTable);

/**
 * @param stats the torrent's stats
 * @returns rqbit's state — a torrent paused during its check is `paused`: 9.x answers the pause with 200 and keeps it
 *   `initializing` with `initializing_paused`, its check standing until it is started (recording `checking-paused`;
 *   8.x refuses that pause)
 */
export function stateOf(stats: RqStats): string {
  const state = asText(stats.state) || String(stats.state);
  return state === "initializing" && stats.initializing_paused === true ? "paused" : state;
}

/**
 * @param stats the torrent's stats
 * @returns the raw key of the status table — `live:stalled` is a live torrent that wants bytes and has no peer to get
 *   them from and nothing coming in (rqbit has no state of its own for it)
 */
export function rawStatus(stats: RqStats): string {
  const state = stateOf(stats);
  if (stats.finished === true) {
    return `${state}:done`;
  }
  const live = asRecord(stats.live);
  const peers = num(asRecord(asRecord(live.snapshot).peer_stats).live);
  const speed = num(asRecord(live.download_speed).mbps);
  return state === "live" && stats.live && peers === 0 && !speed ? "live:stalled" : `${state}:left`;
}

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapRqStatus(raw: string | number, debug: (msg: string) => void): Status {
  return statusFrom(STATUS, String(raw), "rqbit", debug);
}

/**
 * @param speed a `Speed` of the answer (`{ mbps, human_readable }`)
 * @returns bytes per second, null when the answer carries none
 */
export function speedBps(speed: unknown): number | null {
  const mbps = nonNegative(asRecord(speed).mbps);
  return mbps === null ? null : Math.round(mbps * MIB);
}

/**
 * @param raw `GET /stats`
 * @returns the stats — refused whole when a speed lost its shape (fleet C26b): read as none it would empty the speed
 */
export function statsIn(raw: unknown): Record<string, unknown> {
  const stats = recordIn(raw, "rqbit's stats");
  for (const key of ["download_speed", "upload_speed"]) {
    if (typeof asRecord(stats[key]).mbps !== "number") {
      throw new ProtocolError(`rqbit's stats without its ${key} — answer refused`);
    }
  }
  return stats;
}

/**
 * @param raw `GET /torrents/limits` (9.x: both keys, each a number or null for unlimited — api.rs `LimitsConfig`)
 * @returns the limits — refused whole when one is gone or of another type: read as unlimited it would also become the
 *   base of the next limit the adapter sets
 */
export function limitsIn(raw: unknown): Record<string, unknown> {
  const limits = recordIn(raw, "rqbit's limits");
  for (const key of ["download_bps", "upload_bps"]) {
    if (limits[key] !== null && typeof limits[key] !== "number") {
      throw new ProtocolError(`rqbit's limits without its ${key} — answer refused`);
    }
  }
  return limits;
}

/**
 * @param limits `GET /torrents/limits`, null when the program cannot tell them (8.x)
 * @param key `download_bps` or `upload_bps`
 * @returns bytes per second, 0 = unlimited (null in the answer), null when unknown
 */
export function limitBps(limits: Record<string, unknown> | null, key: "download_bps" | "upload_bps"): number | null {
  return limits ? (nonNegative(limits[key]) ?? 0) : null;
}

/**
 * One poll into the common model.
 *
 * @param version the program version (`GET /`)
 * @param torrents `GET /torrents?with_stats=true` → `torrents`
 * @param stats `GET /stats`
 * @param limits `GET /torrents/limits`, null when the program cannot tell them (8.x)
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  torrents: readonly Record<string, unknown>[],
  stats: Record<string, unknown>,
  limits: Record<string, unknown> | null,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = [];
  for (const t of torrents as readonly RqTorrent[]) {
    if (typeof t.info_hash !== "string") {
      continue;
    }
    const s = asRecord(t.stats) as RqStats;
    const live = asRecord(s.live);
    const status = mapRqStatus(rawStatus(s), debug);
    // while initializing these are the bytes checked so far, as qBittorrent's `completed` (the same libtorrent meaning)
    // — not again: empty while checking, Tribler alone does that
    const done = nonNegative(s.progress_bytes);
    const up = nonNegative(s.uploaded_bytes);
    const left = asRecord(asRecord(live.time_remaining).duration);
    items.push({
      key: t.info_hash,
      name: typeof t.name === "string" && t.name ? t.name : t.info_hash,
      status,
      sizeBytes: sizeOf(s.total_bytes),
      doneBytes: done,
      speedBps: s.live ? speedBps(live.download_speed) : null,
      uploadBps: s.live ? speedBps(live.upload_speed) : null,
      // what rqbit has on disk is the base — it does not tell loaded from found data (Sonarr RQbitProxy does the same)
      ratio: done && up !== null ? round2(up / done) : null,
      etaSeconds: status === "downloading" ? nonNegative(num(left.secs)) : null,
      error: asText(s.error),
    });
  }
  return {
    status: {
      version,
      paused,
      downloadBps: speedBps(stats.download_speed),
      uploadBps: speedBps(stats.upload_speed),
      speedLimitBps: limitBps(limits, "download_bps"),
      uploadLimitBps: limitBps(limits, "upload_bps"),
    },
    items,
    complete: true,
  };
}
