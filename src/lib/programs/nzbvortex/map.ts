import { idIn } from "../../core/answer";
import { ProtocolError } from "../../core/errors";
import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { statusFrom } from "../../core/status";
import { asText, fromKiB, nonNegative, num, sizeOf } from "../../core/units";

/** One entry of `GET /api/nzb` (Network API documentation p. 15). */
export interface NvEntry {
  /** The NZB's id — every `nzb/<id>/…` command takes it. */
  id: string;
  /** The raw state, 0–24 in the documentation's table (p. 35). */
  state: number;
  /** `isPaused` — `true`, or `1` as the documentation also allows. */
  paused: boolean;
  /** The entry itself. */
  row: Record<string, unknown>;
}

/**
 * @param entry one entry of the queue's `nzbs`
 * @returns the entry; one without its id or state refuses the whole answer
 */
export function entryOf(entry: Record<string, unknown>): NvEntry {
  const what = "NZBVortex's queue";
  const id = idIn(entry, "id", what, "number");
  const state = entry.state;
  if (typeof state !== "number" || !Number.isInteger(state)) {
    throw new ProtocolError(`an entry of ${what} without its state — answer refused`);
  }
  return { id, state, paused: entry.isPaused === true || entry.isPaused === 1, row: entry };
}

/**
 * Raw state (documentation p. 35, NZBVortex's own names) and the status it maps to. 2 and 3 still belong to the
 * download: the articles are in and wait for the one thread that writes them (NZBVortex's developer in Sonarr PR #960).
 * 5 asks the user for the archive's password and 7 waits until he presses resume — both wait for him. From 4 on the
 * download is post-processed: queued for it, checked, repaired, joined, unpacked, cleaned up, moved. 20 is done; 21–24
 * failed (23 "Move failed, disk full?" too — NZBVortex's web interface shows it as an error). `paused` is `isPaused`,
 * which goes before every state but done and failed.
 */
export const statusTable = [
  ["0", "queued"], // Waiting
  ["1", "downloading"], // Downloading
  ["2", "downloading"], // Waiting for save
  ["3", "downloading"], // Saving
  ["4", "postprocessing"], // Saved
  ["5", "waiting"], // Password request
  ["6", "postprocessing"], // Queued for processing
  ["7", "waiting"], // User wait for processing
  ["8", "postprocessing"], // Checking
  ["9", "postprocessing"], // Repairing
  ["10", "postprocessing"], // Joining
  ["11", "postprocessing"], // Wait for further processing
  ["12", "postprocessing"], // Joining
  ["13", "postprocessing"], // Wait for uncompress
  ["14", "postprocessing"], // Uncompressing
  ["15", "postprocessing"], // Wait for cleanup
  ["16", "postprocessing"], // Cleaning up
  ["17", "postprocessing"], // Cleaned up
  ["18", "postprocessing"], // Moving to completed
  ["19", "postprocessing"], // Move completed
  ["20", "completed"], // Done
  ["21", "failed"], // Uncompress failed
  ["22", "failed"], // Check failed, data corrupt
  ["23", "failed"], // Move failed
  ["24", "failed"], // Badly encoded download (uuencoded)
  ["paused", "paused"],
] as const satisfies readonly (readonly [string, Status])[];

const STATUS = new Map<string, Status>(statusTable);

/** The documentation's names of the failed states — the error of an entry whose `statusText` says nothing. */
const FAILED: Readonly<Record<number, string>> = {
  21: "Uncompress failed",
  22: "Check failed, data corrupt",
  23: "Move failed",
  24: "Badly encoded download (uuencoded)",
};

/**
 * @param e one entry
 * @returns the raw key of the status table: done and failed stay what they are, `isPaused` goes before the rest
 */
export function rawStatus(e: NvEntry): string {
  return e.state === 20 || FAILED[e.state] !== undefined || !e.paused ? String(e.state) : "paused";
}

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapNvStatus(raw: string | number, debug: (msg: string) => void): Status {
  return statusFrom(STATUS, String(raw), "nzbvortex", debug);
}

/**
 * @param e one entry
 * @returns whether the global pause halts it: not paused, waiting for its turn or loading (states 0–3)
 */
export const isRunning = (e: NvEntry): boolean => !e.paused && e.state >= 0 && e.state <= 3;

/**
 * @param answer the answer of `GET /api/speedlimit`
 * @returns the limit in bytes per second, 0 = none; `speedlimit` in KB/s (documentation p. 28–29), a KB 1024 bytes as
 *   NZBVortex's web interface counts it (rates / 1024 shown as KB/s); null when the switch is neither on nor off —
 *   `speedlimit_enabled` comes as 0/1 or as a boolean (documentation p. 14 and 28)
 */
export function limitOf(answer: Record<string, unknown>): number | null {
  const on = answer.speedlimit_enabled;
  if (on === false || on === 0) {
    return 0;
  }
  if (on !== true && on !== 1) {
    return null;
  }
  return num(answer.speedlimit) === null ? null : fromKiB(answer.speedlimit);
}

/**
 * @param answer the answer of `GET /api/app/appversion`
 * @returns NZBVortex's version; an answer without one is refused
 */
export function versionOf(answer: Record<string, unknown>): string {
  const version = asText(answer.appversion);
  if (version === "") {
    throw new ProtocolError("NZBVortex's version is missing — answer refused");
  }
  return version;
}

/**
 * One poll into the common model.
 *
 * @param version NZBVortex's version
 * @param entries the queue
 * @param limit the download limit in bytes per second, 0 = none, null = not known
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  entries: readonly NvEntry[],
  limit: number | null,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = entries.map(e => {
    const status = mapNvStatus(rawStatus(e), debug);
    const size = sizeOf(e.row.totalDownloadSize);
    const loaded = nonNegative(e.row.downloadedSize);
    const done = loaded === null || size === null ? loaded : Math.min(loaded, size);
    const rate = nonNegative(e.row.transferedSpeed);
    // a paused or finished entry may keep its last rate
    const speed = rate === null ? null : status === "downloading" ? rate : 0;
    return {
      key: e.id,
      name: asText(e.row.uiTitle) || e.id,
      status,
      sizeBytes: size,
      doneBytes: done,
      speedBps: speed,
      // NZBVortex reports no time left: what is still to load over the rate
      etaSeconds: speed && size !== null && done !== null && size > done ? Math.round((size - done) / speed) : null,
      // the group the NZB went into — Sonarr reads it as the category (NzbVortex.cs)
      category: asText(e.row.groupName),
      error: status === "failed" ? asText(e.row.statusText).trim() || (FAILED[e.state] ?? "") : "",
    };
  });
  return {
    status: {
      version,
      paused,
      // the sum of every entry's rate in bytes per second, without a call to `app/downloadspeed` of its own
      downloadBps: items.reduce((total, i) => total + (i.speedBps ?? 0), 0),
      speedLimitBps: limit,
    },
    items,
    complete: true,
  };
}
