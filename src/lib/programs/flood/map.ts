import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { statusFrom } from "../../core/status";
import { asText, epochMs, eta, fromKiB, nonNegative, num, round2, sizeOf } from "../../core/units";
import { UNLIMITED_BPS } from "../rtorrent/map";

/**
 * One torrent of `GET /api/torrents` → `torrents` as the map reads it (shared/types/Torrent.ts `TorrentProperties`,
 * 4.11 and 4.16).
 */
export interface FloodTorrent {
  /** Upper-case hex of the info hash — every command takes it; the list is keyed by it. */
  hash?: unknown;
  /** The torrent's name. */
  name?: unknown;
  /**
   * Flags the backend's gateway composes (shared/constants/torrentStatusMap.ts): downloading, seeding, checking,
   * stopped, moving, and beside them complete, active/inactive, error, warning — which come together differs per backend
   * (server/services/<backend>/util/torrentPropertiesUtil.ts).
   */
  status?: unknown;
  /** 0…100; null for a Transmission magnet without its metadata (0 of 0 bytes). */
  percentComplete?: unknown;
  /** Bytes of the selected files — 4.16 only; `sizeBytes` is the whole torrent (-1 for a qBittorrent magnet). */
  selectedSizeBytes?: unknown;
  /** Bytes of the whole torrent. */
  sizeBytes?: unknown;
  /** Bytes loaded. */
  bytesDone?: unknown;
  /** Bytes per second. */
  downRate?: unknown;
  /** Bytes per second. */
  upRate?: unknown;
  /** Seconds left, -1 = unknown. */
  eta?: unknown;
  /** -1 or null where nothing was loaded yet (Deluge, Transmission). */
  ratio?: unknown;
  /**
   * The backend's message: rTorrent's `d.message` (tracker answers too), Transmission's error, Deluge's `OK` on every
   * healthy torrent.
   */
  message?: unknown;
  /** Seconds since 1970; -1 (qBittorrent) or 0 (Transmission, Deluge) before it finished. */
  dateAdded?: unknown;
  /** Seconds since 1970, as `dateAdded`. */
  dateFinished?: unknown;
  /** The backend's labels (rTorrent `d.custom1`, qBittorrent tags, Transmission labels; always [] for Deluge). */
  tags?: unknown;
}

/**
 * Raw key from the flags, in a fixed order because several come together: a check, a move, an error that stopped the
 * torrent, stopped (`:done` with every byte), seeding, downloading (`:inactive` without a rate — queued or stalled, the
 * backends do not tell which).
 */
export const statusTable = [
  ["checking", "checking"],
  ["moving", "postprocessing"],
  ["error", "failed"],
  ["stopped", "paused"],
  ["stopped:done", "completed"],
  ["seeding", "seeding"],
  ["downloading", "downloading"],
  ["downloading:inactive", "waiting"],
] as const satisfies readonly (readonly [string, Status])[];

const STATUS = new Map<string, Status>(statusTable);

/** Deluge's message on a torrent without a problem (recorded on every healthy torrent). */
const DELUGE_OK = "OK";

/** ruTorrent shows every rTorrent message as the torrent's error except this one (js/rtorrent.js, as rtorrent/map.ts). */
const NO_ERROR = "Tracker: [Tried all trackers.]";

/**
 * @param t one torrent
 * @returns its flags
 */
export function flagsOf(t: FloodTorrent): ReadonlySet<string> {
  return new Set(Array.isArray(t.status) ? t.status.filter((f): f is string => typeof f === "string") : []);
}

/**
 * Every selected byte is there. The flag `complete` alone does not tell it: Transmission sets it for a magnet without
 * metadata (0 of 0 bytes, `percentComplete` null — recording 4.16.4-transmission `all-stopped`).
 *
 * @param t one torrent
 * @returns whether it is done
 */
export function isDone(t: FloodTorrent): boolean {
  return (num(t.percentComplete) ?? 0) >= 100;
}

/**
 * The flag `error` stopped the torrent: neither downloading nor seeding, and its message is no tracker's answer —
 * rTorrent's gateway sets the flag for every message (`Tracker: [No DHT nodes available for peer search.]` on a stopped
 * complete torrent, recording 4.16.4-rtorrent `all-stopped`), and Deluge's `OK` is none.
 *
 * @param t one torrent
 * @returns whether an error stopped it
 */
function stoppedByError(t: FloodTorrent): boolean {
  const f = flagsOf(t);
  const message = asText(t.message);
  return (
    f.has("error") &&
    !f.has("downloading") &&
    !f.has("seeding") &&
    message !== DELUGE_OK &&
    !message.startsWith("Tracker: ")
  );
}

/**
 * @param t one torrent
 * @returns the raw key of the status table, the flags themselves when none of them decides
 */
export function rawStatus(t: FloodTorrent): string {
  const f = flagsOf(t);
  if (f.has("checking")) {
    return "checking";
  }
  if (f.has("moving")) {
    return "moving";
  }
  if (stoppedByError(t)) {
    return "error";
  }
  if (f.has("stopped")) {
    return isDone(t) ? "stopped:done" : "stopped";
  }
  if (f.has("seeding")) {
    return "seeding";
  }
  if (f.has("downloading")) {
    return f.has("inactive") ? "downloading:inactive" : "downloading";
  }
  return [...f].join(",");
}

/**
 * What the emulated pause stops: every torrent not stopped yet — a check too — except one an error stopped.
 *
 * @param t one torrent
 * @returns whether the global pause stops it
 */
export function isRunning(t: FloodTorrent): boolean {
  return !flagsOf(t).has("stopped") && !stoppedByError(t);
}

/**
 * What tells that the user started a held torrent himself: it downloads or seeds. A check does not — qBittorrent lists a
 * torrent added stopped as `checking` first (recording 4.16.4-qbittorrent `added-stopped`, `late.bin`).
 *
 * @param t one torrent
 * @returns whether it loads or seeds
 */
export function isLoading(t: FloodTorrent): boolean {
  const f = flagsOf(t);
  return !f.has("stopped") && (f.has("downloading") || f.has("seeding"));
}

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapFloodStatus(raw: string | number, debug: (msg: string) => void): Status {
  return statusFrom(STATUS, String(raw), "flood", debug);
}

/**
 * Settings that Flood's Deluge gateway alone sends as a fixed -1 (server/services/Deluge/clientGatewayService.ts
 * `getClientSettings`, 4.11.0, 4.16.4 and master): the gateways of qBittorrent, Transmission and Neptune send 0, rTorrent's
 * the values rTorrent keeps (recording 4.16.4-rtorrent `completed`: 4096 and 32768).
 */
const DELUGE_FIXED = ["networkMaxOpenFiles", "piecesMemoryMax"] as const;

/**
 * @param settings `GET /api/client/settings`
 * @returns Deluge stands behind Flood: its gateway passes Deluge's limits on as Deluge keeps them, in KiB/s
 *   (core/preferencesmanager.py multiplies by 1024 for libtorrent), where Flood names bytes per second
 *   (shared/types/ClientSettings.ts) — the Transmission gateway converts, the Deluge gateway does not
 */
export function behindDeluge(settings: Record<string, unknown>): boolean {
  return DELUGE_FIXED.every(k => settings[k] === -1);
}

/**
 * @param value `throttleGlobalDownSpeed` / `throttleGlobalUpSpeed` of `GET /api/client/settings`
 * @param kib Deluge stands behind Flood ({@link behindDeluge}): the value is KiB/s, -1 = unlimited
 * @returns bytes per second, 0 = unlimited — also ruTorrent's maximum, which rTorrent behind Flood reported as well
 *   (run 43677990506, 4.16.4-rtorrent from `finished` on — the value the rTorrent driver reads as unlimited)
 */
export function limitBps(value: unknown, kib: boolean): number | null {
  const v = num(value);
  if (v === null) {
    return null;
  }
  if (kib) {
    return fromKiB(v);
  }
  return v < 0 || v >= UNLIMITED_BPS ? 0 : Math.round(v);
}

/**
 * @param t one torrent
 * @returns the error text: the message of a torrent the error flag marks, never Deluge's `OK` or ruTorrent's hidden one
 */
function errorOf(t: FloodTorrent): string {
  const message = asText(t.message);
  return flagsOf(t).has("error") && message !== DELUGE_OK && message !== NO_ERROR ? message : "";
}

/**
 * One poll into the common model.
 *
 * @param version Flood's version, "" where it tells none (before 4.12)
 * @param torrents `GET /api/torrents` → `torrents`, by hash
 * @param settings `GET /api/client/settings`, null when it failed (Flood 4.11 in front of rTorrent 0.16)
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  torrents: readonly (readonly [string, FloodTorrent])[],
  settings: Record<string, unknown> | null,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = [];
  for (const [key, t] of torrents) {
    const status = mapFloodStatus(rawStatus(t), debug);
    // only a torrent that loads has a rate: a stopped or finished one keeps its last (Transmission 950272 B/s stopped,
    // qBittorrent 1085357 B/s seeding — recordings `all-stopped`, `finished`)
    const loads = status === "downloading" || status === "waiting";
    const speed = loads ? (nonNegative(t.downRate) ?? 0) : 0;
    const ratio = num(t.ratio);
    const tags = Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string") : [];
    items.push({
      key,
      name: typeof t.name === "string" && t.name ? t.name : key,
      status,
      sizeBytes: sizeOf(t.selectedSizeBytes) ?? sizeOf(t.sizeBytes),
      doneBytes: nonNegative(t.bytesDone),
      speedBps: speed,
      uploadBps: loads || status === "seeding" ? (nonNegative(t.upRate) ?? 0) : 0,
      ratio: ratio !== null && ratio >= 0 ? round2(ratio) : null,
      etaSeconds: status === "downloading" && speed ? eta(t.eta, []) : null,
      addedMs: epochMs(t.dateAdded),
      finishedMs: epochMs(t.dateFinished),
      category: tags.join(","),
      error: errorOf(t),
    });
  }
  const sum = (pick: (i: DownloadItem) => number | null | undefined): number =>
    items.reduce((total, i) => total + (pick(i) ?? 0), 0);
  const kib = settings !== null && behindDeluge(settings);
  return {
    status: {
      version,
      paused,
      // the list carries every torrent's rates; Flood's own summary comes only over its event stream
      downloadBps: sum(i => i.speedBps),
      uploadBps: sum(i => i.uploadBps),
      speedLimitBps: settings ? limitBps(settings.throttleGlobalDownSpeed, kib) : null,
      uploadLimitBps: settings ? limitBps(settings.throttleGlobalUpSpeed, kib) : null,
    },
    items,
    complete: true,
  };
}
