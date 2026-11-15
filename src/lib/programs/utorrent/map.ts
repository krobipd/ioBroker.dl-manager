import { ProtocolError } from "../../core/errors";
import { RATIO_INFINITE, type DownloadItem, type ProgramSnapshot, type Status } from "../../core/model";
import { statusFrom } from "../../core/status";
import { asText, doneOf, epochMs, eta, fromKiB, nonNegative, num, round2, sizeOf } from "../../core/units";

/** Status bits of a row (webui.js `CONST.STATE_*`, Sonarr's UTorrentTorrentStatus). */
export const STARTED = 1;
export const CHECKING = 2;
export const ERROR = 16;
export const PAUSED = 32;
export const QUEUED = 64;

/** A torrent row by position (webui.js `CONST.TORRENT_*`); µTorrent Server 3.3 build 30470 sends 30 fields. */
const AT = {
  hash: 0,
  status: 1,
  name: 2,
  size: 3,
  /** Per mille. */
  progress: 4,
  /** Per mille, -1 = infinite (webui.js shows "∞"). */
  ratio: 7,
  upSpeed: 8,
  downSpeed: 9,
  /** Seconds; 0 = none, -1 = infinite (webui.js). */
  eta: 10,
  label: 11,
  remaining: 18,
  statusMessage: 21,
  dateAdded: 23,
  dateCompleted: 24,
} as const;

/** One torrent row, the fields the driver reads. */
export interface UtTorrent {
  /** Upper-case hex of the info hash — every action takes it. */
  hash: string;
  /** Status bits. */
  status: number;
  /** The row itself. */
  row: readonly unknown[];
}

/**
 * @param row one entry of `list=1` → `torrents`
 * @returns the torrent; a row without its hash or status refuses the whole answer
 */
export function torrentOf(row: unknown): UtTorrent {
  if (!Array.isArray(row) || typeof row[AT.hash] !== "string" || row[AT.hash] === "") {
    throw new ProtocolError("an entry of µTorrent's torrent list without its hash — answer refused");
  }
  const status = row[AT.status];
  if (typeof status !== "number" || !Number.isInteger(status)) {
    throw new ProtocolError("an entry of µTorrent's torrent list without its status — answer refused");
  }
  return { hash: row[AT.hash], status, row };
}

/** Raw key (the CSS class µTorrent's own Web UI gives the status, webui.js `getStatusInfo`) and the status it maps to. */
export const statusTable = [
  ["Status_Paused", "paused"],
  ["Status_Up", "seeding"],
  ["Status_Down", "downloading"],
  ["Status_Checking", "checking"],
  ["Status_Error", "failed"],
  ["Status_Queued_Up", "seeding"],
  ["Status_Queued_Down", "queued"],
  ["Status_Completed", "completed"],
  ["Status_Incomplete", "paused"],
] as const satisfies readonly (readonly [string, Status])[];

const STATUS = new Map<string, Status>(statusTable);

/**
 * The status bits as µTorrent's own Web UI reads them (webui.js `getStatusInfo`), in its order: paused, started
 * (seeding or loading), checking, error, queued, finished, stopped.
 *
 * @param t one torrent
 * @returns the raw key of the status table
 */
export function rawStatus(t: UtTorrent): string {
  const done = num(t.row[AT.progress]) === 1000;
  if (t.status & PAUSED) {
    return "Status_Paused";
  }
  if (t.status & STARTED) {
    return done ? "Status_Up" : "Status_Down";
  }
  if (t.status & CHECKING) {
    return "Status_Checking";
  }
  if (t.status & ERROR) {
    return "Status_Error";
  }
  if (t.status & QUEUED) {
    return done ? "Status_Queued_Up" : "Status_Queued_Down";
  }
  return done ? "Status_Completed" : "Status_Incomplete";
}

/**
 * What the emulated pause halts: what is started or waits in the queue and is not paused — the torrents the Web UI's
 * "pause all" pauses (webui.js `perform("pauseall")` → `getHashes("pause")`).
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
export const isRunning = (t: UtTorrent): boolean => runs(t.status);

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapUtStatus(raw: string | number, debug: (msg: string) => void): Status {
  return statusFrom(STATUS, String(raw), "utorrent", debug);
}

/**
 * @param settings `action=getsettings` → `settings`: `[name, type, value, access]`, the value as text
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
 * @param value `max_dl_rate` / `max_ul_rate`: KiB/s — the Web UI shows the limit in the kB of its sizes, which divide by
 *   1024 (webui.js `showSpeedMenu`, utils.js `toFileSize`); 0 is unlimited (its menu's "Unlimited"), and so is the -1 of
 *   µTorrent Server's configuration (utserver.conf, recording `empty`)
 * @returns bytes per second, 0 = unlimited
 */
export function limitBps(value: unknown): number | null {
  const v = num(value);
  return v === null ? null : v <= 0 ? 0 : fromKiB(v);
}

/**
 * @param raw `TORRENT_ETA`
 * @returns seconds, null for none (0), infinite (-1) or what the Web UI shows as infinite (over two years, utils.js
 *   `toTimeDelta`)
 */
function etaOf(raw: unknown): number | null {
  const v = num(raw);
  return v !== null && v > 63_072_000 ? null : eta(v, [0]);
}

/**
 * One poll into the common model.
 *
 * @param version µTorrent's version
 * @param torrents the rows of `list=1`
 * @param settings `action=getsettings` → `settings`
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  torrents: readonly UtTorrent[],
  settings: unknown,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = torrents.map(t => {
    const r = t.row;
    const status = mapUtStatus(rawStatus(t), debug);
    // a paused or stopped torrent keeps its last rates (recordings `paused`: 1394 B/s, `all-stopped`: 2417747 B/s)
    const loads = status === "downloading";
    const speed = loads ? (nonNegative(r[AT.downSpeed]) ?? 0) : 0;
    const size = sizeOf(r[AT.size]);
    const ratio = num(r[AT.ratio]);
    return {
      key: t.hash,
      name: asText(r[AT.name]) || t.hash,
      status,
      // a magnet without its metadata lists 0 bytes (recording `metadata`)
      sizeBytes: size,
      doneBytes: doneOf(size, nonNegative(r[AT.remaining])),
      speedBps: speed,
      uploadBps: loads || status === "seeding" ? (nonNegative(r[AT.upSpeed]) ?? 0) : 0,
      ratio: ratio === -1 ? RATIO_INFINITE : ratio !== null && ratio >= 0 ? round2(ratio / 1000) : null,
      etaSeconds: loads && speed ? etaOf(r[AT.eta]) : null,
      addedMs: epochMs(r[AT.dateAdded]),
      finishedMs: epochMs(r[AT.dateCompleted]),
      category: asText(r[AT.label]),
      // the program's own text ("Error: Files missing from job. Please recheck.", recording `error`)
      error: t.status & ERROR ? asText(r[AT.statusMessage]) : "",
    };
  });
  const sum = (pick: (i: DownloadItem) => number | null | undefined): number =>
    items.reduce((total, i) => total + (pick(i) ?? 0), 0);
  return {
    status: {
      version,
      paused,
      // the list carries every torrent's rates; µTorrent sends no totals
      downloadBps: sum(i => i.speedBps),
      uploadBps: sum(i => i.uploadBps),
      speedLimitBps: limitBps(settingOf(settings, "max_dl_rate")),
      uploadLimitBps: limitBps(settingOf(settings, "max_ul_rate")),
    },
    items,
    complete: true,
  };
}
