import { ProtocolError } from "../../core/errors";
import { listIn } from "../../core/answer";
import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { statusFrom } from "../../core/status";
import { epochMs, nonNegative, num, round2, sizeOf } from "../../core/units";

/** The custom field the adapter marks a torrent with that it added stopped while it held the program paused. */
export const HELD_MARK = "dlm_held";

/**
 * What one poll asks of every torrent (`d.multicall2` on the view `main`), in this order — the recorder asks the same
 * (test/live/programs/rtorrent.mjs `FIELDS`). The status fields are ruTorrent's (js/rtorrent.js).
 */
export const FIELDS = [
  "d.hash=",
  "d.name=",
  "d.state=",
  "d.is_open=",
  "d.is_active=",
  "d.complete=",
  "d.hashing=",
  "d.is_hash_checking=",
  "d.size_bytes=",
  "d.completed_bytes=",
  "d.down.rate=",
  "d.up.rate=",
  "d.up.total=",
  "d.ratio=",
  "d.peers_connected=",
  "d.message=",
  "d.custom1=",
  "d.load_date=",
  "d.timestamp.finished=",
  `d.custom=${HELD_MARK}`,
] as const;

/** One torrent of the poll, by field. */
export interface RtTorrent {
  /** Info hash in capitals — every command takes it. */
  hash: string;
  /** Display name; `<HASH>.meta` while a magnet has no metadata. */
  name: string;
  /** 1 = started, 0 = stopped. */
  state: number;
  /** The files are open (0 after `d.close`). */
  open: number;
  /** 0 while paused (`d.pause`). */
  active: number;
  /** All wanted bytes are on disk. */
  complete: number;
  /** Non-zero while a hash check waits or runs. */
  hashing: number;
  /** 1 while the hash check runs. */
  checking: number;
  /** Bytes of the wanted files. */
  size: number | null;
  /** Bytes on disk. */
  done: number | null;
  /** Download rate in bytes per second. */
  down: number | null;
  /** Upload rate in bytes per second. */
  up: number | null;
  /** Ratio in thousandths (Sonarr RTorrent.cs: `Ratio / 1000.0`). */
  ratio: number | null;
  /** Peers connected. */
  peers: number;
  /** The program's message — a tracker answer or an error. */
  message: string;
  /** ruTorrent's label. */
  label: string;
  /** Added, seconds since epoch. */
  loaded: number | null;
  /** Finished, seconds since epoch, 0 = not yet. */
  finished: number | null;
  /** The adapter's mark — `1` on a torrent it added stopped. */
  held: string;
}

/**
 * @param row one row of `d.multicall2`
 * @returns the torrent; a row that lost its shape refuses the whole answer (decision 28)
 */
export function torrentOf(row: unknown): RtTorrent {
  const r = listIn(row, "a row of rTorrent's torrent list");
  if (r.length !== FIELDS.length) {
    throw new ProtocolError(
      `a row of rTorrent's torrent list has ${r.length} of ${FIELDS.length} fields — answer refused`,
    );
  }
  const text = (i: number): string => (typeof r[i] === "string" ? r[i] : "");
  const flag = (i: number): number => num(r[i]) ?? 0;
  if (typeof r[0] !== "string" || r[0] === "") {
    throw new ProtocolError("an entry of rTorrent's torrent list without its d.hash — answer refused");
  }
  return {
    hash: r[0],
    name: text(1),
    state: flag(2),
    open: flag(3),
    active: flag(4),
    complete: flag(5),
    hashing: flag(6),
    checking: flag(7),
    size: sizeOf(r[8]),
    done: nonNegative(r[9]),
    down: nonNegative(r[10]),
    up: nonNegative(r[11]),
    ratio: nonNegative(r[13]),
    peers: flag(14),
    message: text(15),
    label: text(16),
    loaded: num(r[17]),
    finished: num(r[18]),
    held: text(19),
  };
}

/**
 * Raw key and the status it maps to. `<where>:<what>` — where: `active` (started and not paused), `paused` (started,
 * `d.pause`), `stopped` (`d.stop`), `closed` (`d.close`); what: `left`, `stalled` (wants bytes, no peer, nothing
 * coming in), `done`, `error` (stopped by an error of its own). ruTorrent calls a started torrent paused when it is
 * inactive (js/rtorrent.js), and pauses with `d.stop` — paused and stopped are both "paused" here.
 */
export const statusTable = [
  ["checking", "checking"],
  ["hashing", "queued"],
  ["active:left", "downloading"],
  ["active:stalled", "waiting"],
  ["active:done", "seeding"],
  ["paused:left", "paused"],
  ["paused:done", "completed"],
  ["stopped:left", "paused"],
  ["stopped:done", "completed"],
  ["stopped:error", "failed"],
  ["closed:left", "paused"],
  ["closed:done", "completed"],
  ["closed:error", "failed"],
] as const satisfies readonly (readonly [string, Status])[];

const STATUS = new Map<string, Status>(statusTable);

/** ruTorrent shows every message as the torrent's error except this one (js/rtorrent.js). */
const NO_ERROR = "Tracker: [Tried all trackers.]";

/**
 * @param t a torrent
 * @returns the program's error text — ruTorrent's rule
 */
export const errorOf = (t: RtTorrent): string => (t.message === NO_ERROR ? "" : t.message);

/**
 * @param t a torrent
 * @returns the raw key of the status table — a message that is no tracker's answer on a stopped torrent with bytes left
 *   is the error that stopped it (rTorrent stops a torrent whose hash check finds chunks missing: recording `missing`)
 */
export function rawStatus(t: RtTorrent): string {
  if (t.checking) {
    return "checking";
  }
  if (t.hashing) {
    return "hashing";
  }
  const where = !t.open ? "closed" : !t.state ? "stopped" : !t.active ? "paused" : "active";
  if (t.complete) {
    return `${where}:done`;
  }
  if (where === "active") {
    return t.peers === 0 && !t.down ? "active:stalled" : "active:left";
  }
  const failed = (where === "stopped" || where === "closed") && t.message !== "" && !t.message.startsWith("Tracker: ");
  return `${where}:${failed ? "error" : "left"}`;
}

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapRtStatus(raw: string | number, debug: (msg: string) => void): Status {
  return statusFrom(STATUS, String(raw), "rTorrent", debug);
}

/** ruTorrent's "unlimited": no limit is more than 327625 KiB/s (conf/config.php `$throttleMaxSpeed`, webui.js). */
export const UNLIMITED_BPS = 327625 * 1024;

/**
 * @param v `throttle.global_*.max_rate`
 * @returns bytes per second, 0 = unlimited — 0 itself or ruTorrent's maximum, which it shows as "no" limit
 */
export function limitBps(v: unknown): number | null {
  const n = nonNegative(v);
  return n === null ? null : n >= UNLIMITED_BPS ? 0 : n;
}

/** The program-wide part of one poll. */
export interface RtGlobal {
  /** Download rate. */
  down: unknown;
  /** Upload rate. */
  up: unknown;
  /** Download limit. */
  downMax: unknown;
  /** Upload limit. */
  upMax: unknown;
}

/**
 * One poll into the common model.
 *
 * @param version the program version (`system.client_version`)
 * @param torrents the torrents of the poll
 * @param global rates and limits
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  torrents: readonly RtTorrent[],
  global: RtGlobal,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = torrents.map(t => {
    const status = mapRtStatus(rawStatus(t), debug);
    const left = t.size !== null && t.done !== null ? t.size - t.done : null;
    return {
      key: t.hash,
      name: t.name || t.hash,
      status,
      sizeBytes: t.size,
      doneBytes: t.done,
      speedBps: t.down,
      uploadBps: t.up,
      // not again: null while a torrent is checked — every recording has nothing uploaded then, the 0 is true
      ratio: t.ratio === null ? null : round2(t.ratio / 1000),
      // rTorrent tells no time left — the bytes left at the rate of now, like aria2
      etaSeconds: status === "downloading" && t.down && left !== null && left > 0 ? Math.round(left / t.down) : null,
      addedMs: epochMs(t.loaded),
      // rTorrent keeps the finish time when a recheck finds chunks missing (recording `missing`)
      finishedMs: t.complete ? epochMs(t.finished) : null,
      category: t.label,
      error: errorOf(t),
    };
  });
  return {
    status: {
      version,
      paused,
      downloadBps: nonNegative(global.down),
      uploadBps: nonNegative(global.up),
      speedLimitBps: limitBps(global.downMax),
      uploadLimitBps: limitBps(global.upMax),
    },
    items,
    complete: true,
  };
}
