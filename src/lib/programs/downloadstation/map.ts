import { idIn, recordIn } from "../../core/answer";
import { ProtocolError } from "../../core/errors";
import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { statusFrom } from "../../core/status";
import { asRecord, asText, epochMs, fromKiB, nonNegative, num, round2, sizeOf } from "../../core/units";

/** One task of `SYNO.DownloadStation.Task list` with `additional=detail,transfer`. */
export interface DsTask {
  /** `dbid_<n>` — every command takes it. */
  id: string;
  /** The raw status as listed: a text (the v1 list, Download Station API guide appendix A). */
  status: string;
  /** The task itself. */
  row: Record<string, unknown>;
}

/**
 * @param entry one entry of the list's `tasks`
 * @returns the task; an entry without its id or status refuses the whole answer
 */
export function taskOf(entry: Record<string, unknown>): DsTask {
  const what = "Download Station's task list";
  const id = idIn(entry, "id", what, "text");
  const status = entry.status;
  // the v1 list sends a text; a number (what DSM sends after the first id of a getinfo, cmeans spec) stays a raw key
  if (typeof status !== "string" && !(typeof status === "number" && Number.isInteger(status))) {
    throw new ProtocolError(`an entry of ${what} without its status — answer refused`);
  }
  return { id, status: String(status), row: entry };
}

/**
 * Raw status (Download Station API guide, appendix A) and the status it maps to. `waiting` waits for a place in the
 * queue, `filehosting_waiting` for a file host; `finishing` moves the finished file to its destination and `extracting`
 * unpacks it. A paused task that has every byte is completed (`paused:done`, like qBittorrent's pausedUP).
 */
export const statusTable = [
  ["waiting", "queued"],
  ["downloading", "downloading"],
  ["paused", "paused"],
  ["paused:done", "completed"],
  ["finishing", "postprocessing"],
  ["finished", "completed"],
  ["hash_checking", "checking"],
  ["seeding", "seeding"],
  ["filehosting_waiting", "waiting"],
  ["extracting", "postprocessing"],
  ["error", "failed"],
] as const satisfies readonly (readonly [string, Status])[];

const STATUS = new Map<string, Status>(statusTable);

/** What the emulated pause halts: what loads, seeds or waits for its turn — Download Station pauses these. */
const RUNS: ReadonlySet<string> = new Set(["waiting", "downloading", "seeding", "filehosting_waiting"]);

/**
 * @param t one task
 * @returns whether the global pause halts it
 */
export const isRunning = (t: DsTask): boolean => RUNS.has(t.status);

/**
 * @param t one task
 * @returns its byte counts, null where the answer has none (a list without `transfer`, a size of 0 = not known yet)
 */
function bytesOf(t: DsTask): { size: number | null; done: number | null } {
  const transfer = asRecord(asRecord(t.row.additional).transfer);
  const size = sizeOf(t.row.size);
  const loaded = nonNegative(transfer.size_downloaded);
  return { size, done: loaded === null ? null : size === null ? loaded : Math.min(loaded, size) };
}

/**
 * @param t one task
 * @returns the raw key of the status table
 */
export function rawStatus(t: DsTask): string {
  if (t.status === "paused") {
    const { size, done } = bytesOf(t);
    return size !== null && done === size ? "paused:done" : "paused";
  }
  return t.status;
}

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapDsStatus(raw: string | number, debug: (msg: string) => void): Status {
  return statusFrom(STATUS, String(raw), "downloadstation", debug);
}

/**
 * Download Station keeps its limits per protocol (`SYNO.DownloadStation.Info getconfig`), none for the whole program.
 * The adapter shows no download limit: BitTorrent, NZB, HTTP/FTP and eMule each have their own, and the API guide's own
 * example has HTTP/FTP unlimited beside 13 and 10 KB/s (p. 18) — one value would stand for protocols that differ.
 * The upload limit is BitTorrent's, and eMule's while it is switched on.
 *
 * @param config the answer of `getconfig`
 * @returns the upload limit fields — eMule's only while it is switched on
 */
export function uploadLimitFields(config: Record<string, unknown>): string[] {
  return ["bt_max_upload", ...(config.emule_enabled === true ? ["emule_max_upload"] : [])];
}

/**
 * The adapter's upload limit is every upload field at one value. KB/s, 0 = unlimited (API guide p. 18); a KB is 1024
 * bytes as Synology's own interface counts it (download.js shows rates as bytes / 1024 KB/s and hands its KB/s fields
 * to the server unchanged — not measured).
 *
 * @param config the answer of `getconfig`
 * @param fields the upload limit fields
 * @param manager the account manages Download Station — any other reads every limit as 0 (live, non-manager)
 * @returns bytes per second, 0 = unlimited, null when the protocols differ, a field is missing or the account cannot
 *   see them
 */
export function limitBps(config: Record<string, unknown>, fields: readonly string[], manager: boolean): number | null {
  if (!manager) {
    return null;
  }
  const values = fields.map(f => num(config[f]));
  if (values.some(v => v === null) || new Set(values).size !== 1) {
    return null;
  }
  return fromKiB(values[0]);
}

/**
 * One poll into the common model.
 *
 * @param version Download Station's `version_string`
 * @param tasks the tasks of the list
 * @param config the answer of `getconfig`
 * @param manager the account manages Download Station
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  tasks: readonly DsTask[],
  config: Record<string, unknown>,
  manager: boolean,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = tasks.map(t => {
    const status = mapDsStatus(rawStatus(t), debug);
    const additional = asRecord(t.row.additional);
    const detail = asRecord(additional.detail);
    const transfer = additional.transfer === undefined ? null : asRecord(additional.transfer);
    const { size, done } = bytesOf(t);
    const loads = status === "downloading";
    // a paused or finished task may keep its last rate; without `transfer` the answer has none
    const speed = transfer ? (loads ? (nonNegative(transfer.speed_download) ?? 0) : 0) : null;
    const uploaded = transfer ? nonNegative(transfer.size_uploaded) : null;
    const extra = asRecord(t.row.status_extra);
    return {
      key: t.id,
      name: asText(t.row.title) || t.id,
      status,
      sizeBytes: size,
      doneBytes: done,
      speedBps: speed,
      uploadBps: transfer ? (loads || status === "seeding" ? (nonNegative(transfer.speed_upload) ?? 0) : 0) : null,
      // Download Station reports no ratio: what a torrent gave back over what it has
      ratio: t.row.type === "bt" && uploaded !== null && done ? round2(uploaded / done) : null,
      // and no time left: Sonarr's (size − loaded) / rate
      etaSeconds: speed && size !== null && done !== null && size > done ? Math.round((size - done) / speed) : null,
      addedMs: epochMs(detail.create_time),
      finishedMs: epochMs(detail.completed_time),
      error: t.status === "error" ? asText(extra.error_detail) || String(num(extra.error_detail) ?? "") : "",
    };
  });
  const sum = (pick: (i: DownloadItem) => number | null | undefined): number =>
    items.reduce((total, i) => total + (pick(i) ?? 0), 0);
  return {
    status: {
      version,
      paused,
      // the list carries every task's rates — the same as SYNO.DownloadStation.Statistic, without a call of its own
      downloadBps: sum(i => i.speedBps),
      uploadBps: sum(i => i.uploadBps),
      uploadLimitBps: limitBps(config, uploadLimitFields(config), manager),
    },
    items,
    complete: true,
  };
}

/**
 * @param data the answer of `SYNO.DownloadStation.Info getinfo`
 * @returns Download Station's version and whether the account manages it; an answer without the version is refused
 */
export function infoOf(data: unknown): { version: string; manager: boolean } {
  const info = recordIn(data, "Download Station's info");
  const version = info.version_string;
  if (typeof version !== "string" || version === "") {
    throw new ProtocolError("Download Station's version is missing — answer refused");
  }
  return { version, manager: info.is_manager === true };
}
