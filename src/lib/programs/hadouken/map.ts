import { ProtocolError } from "../../core/errors";
import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { statusFrom } from "../../core/status";
import { asText, epochMs, eta, nonNegative, num, round2, sizeOf } from "../../core/units";

/**
 * Status bits of a row (Hadouken 5.2.0 js/rpc/webui_list.js): started = not paused, checking = libtorrent's states
 * queued for checking, checking files and checking resume data, error, paused = paused and not auto-managed, queued =
 * paused and auto-managed (libtorrent's queue starts it when its turn comes).
 */
export const STARTED = 1;
export const CHECKING = 2;
export const ERROR = 16;
export const PAUSED = 32;
export const QUEUED = 64;

/** A torrent row by position (webui_list.js, µTorrent's layout). */
const AT = {
  hash: 0,
  status: 1,
  name: 2,
  /** Bytes, -1 without metadata. */
  size: 3,
  /** Per mille of the wanted bytes. */
  progress: 4,
  /** Per mille of upload over the bytes it has, -1000 while it has none (torrent_status_wrapper.cpp `get_ratio`). */
  ratio: 7,
  upSpeed: 8,
  downSpeed: 9,
  /** Seconds as a float, -1 = none (torrent_status_wrapper.cpp `get_eta`). */
  eta: 10,
  label: 11,
  error: 21,
  /** Seconds since the epoch (libtorrent's added_time). */
  dateAdded: 23,
  /** Seconds since the epoch, 0 until it finished (libtorrent's completed_time). */
  dateCompleted: 24,
} as const;

/** One torrent row, the fields the driver reads. */
export interface HkTorrent {
  /** Lower-case hex of the info hash — every action takes it (libtorrent's from_hex reads either case). */
  hash: string;
  /** Status bits. */
  status: number;
  /** The row itself. */
  row: readonly unknown[];
}

/**
 * @param row one entry of `webui.list` → `torrents`
 * @returns the torrent; a row without its hash or status refuses the whole answer
 */
export function torrentOf(row: unknown): HkTorrent {
  if (!Array.isArray(row) || typeof row[AT.hash] !== "string" || row[AT.hash] === "") {
    throw new ProtocolError("an entry of Hadouken's torrent list without its hash — answer refused");
  }
  const status = row[AT.status];
  if (typeof status !== "number" || !Number.isInteger(status)) {
    throw new ProtocolError("an entry of Hadouken's torrent list without its status — answer refused");
  }
  return { hash: row[AT.hash], status, row };
}

/**
 * Raw key (the CSS class Hadouken's own Web UI gives the status, webui.js `getStatusInfo`) and the status it maps to. A
 * finished torrent paused is completed, like qBittorrent's pausedUP — the Web UI gives it the class Status_Paused too,
 * the key adds `:done`.
 */
export const statusTable = [
  ["Status_Error", "failed"],
  ["Status_Checking", "checking"],
  ["Status_Paused", "paused"],
  ["Status_Paused:done", "completed"],
  ["Status_Up", "seeding"],
  ["Status_Down", "downloading"],
  ["Status_Queued_Up", "seeding"],
  ["Status_Queued_Down", "queued"],
] as const satisfies readonly (readonly [string, Status])[];

const STATUS = new Map<string, Status>(statusTable);

/**
 * The status bits as Hadouken's own Web UI reads them (webui.js `getStatusInfo`), in its order: error, checking,
 * paused, started (seeding or loading), queued. Every row carries one of started, paused or queued (webui_list.js), so
 * the Web UI's last class, Status_Completed, never comes — an empty key would be an unknown status.
 *
 * @param t one torrent
 * @returns the raw key of the status table
 */
export function rawStatus(t: HkTorrent): string {
  const done = num(t.row[AT.progress]) === 1000;
  if (t.status & ERROR) {
    return "Status_Error";
  }
  if (t.status & CHECKING) {
    return "Status_Checking";
  }
  if (t.status & PAUSED) {
    return done ? "Status_Paused:done" : "Status_Paused";
  }
  if (t.status & STARTED) {
    return done ? "Status_Up" : "Status_Down";
  }
  if (t.status & QUEUED) {
    return done ? "Status_Queued_Up" : "Status_Queued_Down";
  }
  return "";
}

/**
 * What the emulated pause halts: what is started or waits in libtorrent's queue and is not paused.
 *
 * @param status a torrent's status bits
 * @returns whether the global pause halts it
 */
export function runs(status: number): boolean {
  return (status & PAUSED) === 0 && (status & (STARTED | QUEUED)) !== 0;
}

/**
 * @param t one torrent
 * @returns whether the global pause halts it (`runs`)
 */
export const isRunning = (t: HkTorrent): boolean => runs(t.status);

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapHkStatus(raw: string | number, debug: (msg: string) => void): Status {
  return statusFrom(STATUS, String(raw), "hadouken", debug);
}

/**
 * @param settings `webui.getSettings` → `settings`: `[name, type, value, access]`, a number's value as a number
 * @param name the setting
 * @returns its value
 */
export function settingOf(settings: unknown, name: string): unknown {
  const entry = Array.isArray(settings)
    ? settings.find((s): s is unknown[] => Array.isArray(s) && s[0] === name)
    : undefined;
  return entry?.[2];
}

/**
 * @param value `max_dl_rate` / `max_ul_rate`: libtorrent's session setting, handed through unchanged
 *   (webui_getSettings.js, webui_setSettings.js → session_settings `download_rate_limit`) — bytes per second, 0
 *   unlimited; Hadouken's own Web UI labels the number kB/s
 * @returns bytes per second, 0 = unlimited
 */
export function limitBps(value: unknown): number | null {
  const v = num(value);
  return v === null ? null : v <= 0 ? 0 : Math.round(v);
}

/**
 * @param raw `TORRENT_ETA`
 * @returns whole seconds, null for none (-1) or what the Web UI shows as infinite (over two years, utils.js
 *   `toTimeDelta`)
 */
function etaOf(raw: unknown): number | null {
  const v = num(raw);
  return v === null || v > 63_072_000 ? null : eta(Math.round(v), [0]);
}

/**
 * One poll into the common model.
 *
 * @param version Hadouken's version
 * @param torrents the rows of `webui.list`
 * @param settings `webui.getSettings` → `settings`
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  torrents: readonly HkTorrent[],
  settings: unknown,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = torrents.map(t => {
    const r = t.row;
    const status = mapHkStatus(rawStatus(t), debug);
    const loads = status === "downloading";
    const speed = loads ? (nonNegative(r[AT.downSpeed]) ?? 0) : 0;
    // a magnet without its metadata lists -1 bytes
    const size = sizeOf(r[AT.size]);
    const progress = nonNegative(r[AT.progress]);
    const ratio = num(r[AT.ratio]);
    return {
      key: t.hash,
      name: asText(r[AT.name]) || t.hash,
      status,
      sizeBytes: size,
      // the row's "remaining" is the size minus the wanted bytes (webui_list.js), not what is left — the loaded bytes
      // come from the per mille
      doneBytes: size !== null && progress !== null ? Math.round((size * Math.min(progress, 1000)) / 1000) : null,
      speedBps: speed,
      uploadBps: loads || status === "seeding" ? (nonNegative(r[AT.upSpeed]) ?? 0) : 0,
      ratio: ratio !== null && ratio >= 0 ? round2(ratio / 1000) : null,
      etaSeconds: loads && speed ? etaOf(r[AT.eta]) : null,
      addedMs: epochMs(r[AT.dateAdded]),
      finishedMs: epochMs(r[AT.dateCompleted]),
      category: asText(r[AT.label]),
      error: t.status & ERROR ? asText(r[AT.error]) : "",
    };
  });
  const sum = (pick: (i: DownloadItem) => number | null | undefined): number =>
    items.reduce((total, i) => total + (pick(i) ?? 0), 0);
  return {
    status: {
      version,
      paused,
      // the list carries every torrent's rates; Hadouken sends no totals
      downloadBps: sum(i => i.speedBps),
      uploadBps: sum(i => i.uploadBps),
      speedLimitBps: limitBps(settingOf(settings, "max_dl_rate")),
      uploadLimitBps: limitBps(settingOf(settings, "max_ul_rate")),
    },
    items,
    complete: true,
  };
}
