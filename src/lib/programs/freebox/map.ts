import { idIn, recordIn } from "../../core/answer";
import { ProtocolError } from "../../core/errors";
import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { statusFrom } from "../../core/status";
import { asRecord, asText, epochMs, nonNegative, num, sizeOf } from "../../core/units";

/** One task of `GET downloads/` (documentation, download: "Download object"). */
export interface FbxTask {
  /** The task's id — every `downloads/{id}` call takes it. */
  id: string;
  /** The raw status, one of the twelve the documentation lists. */
  status: string;
  /** `bt`, `nzb`, `http` or `ftp`. */
  type: string;
  /** The task itself. */
  row: Record<string, unknown>;
}

/**
 * @param entry one entry of the list
 * @returns the task; one without its id or status refuses the whole answer
 */
export function taskOf(entry: Record<string, unknown>): FbxTask {
  const what = "the Freebox's download list";
  const id = idIn(entry, "id", what, "number");
  const status = asText(entry.status);
  if (status === "") {
    throw new ProtocolError(`an entry of ${what} without its status — answer refused`);
  }
  return { id, status, type: asText(entry.type), row: entry };
}

/**
 * @param result the `result` of `GET downloads/`
 * @returns its tasks — an empty list is the answer without `result` (a running Freebox, Radarr #9938), every other
 *   form refuses it
 */
export function tasksOf(result: unknown): FbxTask[] {
  if (result === undefined) {
    return [];
  }
  if (!Array.isArray(result)) {
    throw new ProtocolError("the Freebox's download list is no list — answer refused");
  }
  return result.map(e => taskOf(recordIn(e, "an entry of the Freebox's download list")));
}

/**
 * Raw status (documentation, download: "status") and the status it maps to. `stopped` waits for the user,
 * `stopping` is on the way there; `starting` prepares the data; `checking` is the check of a torrent's data (a running
 * Freebox lists it for bt, Radarr #9938) and of an NZB's par2 after the download; `repairing` and `extracting`
 * post-process an NZB. `retry` is the task set to start anew — it waits for its turn. `done` is finished, `error`
 * failed; `seeding` only for bt, until the seed ratio is reached.
 */
export const statusTable = [
  ["stopped", "paused"],
  ["stopping", "paused"],
  ["queued", "queued"],
  ["starting", "checking"],
  ["downloading", "downloading"],
  ["checking", "checking"],
  ["checking:nzb", "postprocessing"],
  ["repairing", "postprocessing"],
  ["extracting", "postprocessing"],
  ["seeding", "seeding"],
  ["done", "completed"],
  ["error", "failed"],
  ["retry", "queued"],
] as const satisfies readonly (readonly [string, Status])[];

const STATUS = new Map<string, Status>(statusTable);

/**
 * @param t one task
 * @returns the raw key of the status table — an NZB's check is its post-processing
 */
export function rawStatus(t: FbxTask): string {
  return t.status === "checking" && t.type === "nzb" ? "checking:nzb" : t.status;
}

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapFbxStatus(raw: string | number, debug: (msg: string) => void): Status {
  return statusFrom(STATUS, String(raw), "freebox", debug);
}

/**
 * What the emulated pause halts: what loads, seeds or waits for its turn, and a torrent whose data is checked — it loads
 * or seeds right after (a running Freebox: stopped → checking → downloading, Radarr #9938; Transmission's pause halts
 * its check too). Never one on its way to `stopped`, never an NZB's post-processing (raw keys of the status table).
 */
const RUNS: ReadonlySet<string> = new Set(["queued", "starting", "downloading", "checking", "seeding", "retry"]);

/**
 * @param t one task
 * @returns whether the global pause halts it
 */
export const isRunning = (t: FbxTask): boolean => RUNS.has(rawStatus(t));

/** The Freebox's limits in bytes per second, 0 = none, null = not known. */
export interface FbxLimits {
  /** Download. */
  down: number | null;
  /** Upload. */
  up: number | null;
}

/**
 * @param config the `result` of `GET downloads/config/`
 * @returns the limits of the normal mode (`throttling.normal`, documentation download_config: B/s, 0 = no limit) — the
 *   ones the adapter sets
 */
export function limitsOf(config: unknown): FbxLimits {
  const normal = asRecord(asRecord(asRecord(config).throttling).normal);
  return { down: nonNegative(normal.rx_rate), up: nonNegative(normal.tx_rate) };
}

/**
 * @param answer the answer of `GET /api_version`
 * @returns the API version the Freebox speaks (e.g. "16.0"); an answer without one is refused
 */
export function versionOf(answer: Record<string, unknown>): string {
  const version = asText(answer.api_version);
  if (version === "") {
    throw new ProtocolError("the Freebox's API version is missing — answer refused");
  }
  return version;
}

/**
 * @param t one task
 * @param raw its key of the status table
 * @param size its size
 * @returns the bytes loaded, within the size; null when the task does not say
 */
function doneOf(t: FbxTask, raw: string, size: number): number | null {
  if (raw === "checking") {
    // while a torrent's data is checked, `rx_pct` is the check's progress (a running Freebox: one task at 3, 5795 while
    // checked, 70 after; another 454 stopped, 1040 checked) — `rx_bytes` stays what was loaded (Radarr #9938)
    const bytes = nonNegative(t.row.rx_bytes);
    return bytes === null ? null : Math.min(bytes, size);
  }
  // otherwise `rx_pct` in hundredths of a percent, without the protocol's overhead that `rx_bytes` counts — the share
  // is what is loaded (Sonarr TorrentFreeboxDownload.cs: RemainingSize from rx_pct)
  const pct = nonNegative(t.row.rx_pct);
  return pct === null ? null : Math.round((size * Math.min(pct, 10_000)) / 10_000);
}

/**
 * One poll into the common model.
 *
 * @param version the Freebox's API version
 * @param tasks the download list
 * @param limits the normal mode's limits
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  tasks: readonly FbxTask[],
  limits: FbxLimits,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = tasks.map(t => {
    const raw = rawStatus(t);
    const status = mapFbxStatus(raw, debug);
    const size = sizeOf(t.row.size);
    const done = size === null ? null : doneOf(t, raw, size);
    const uploaded = nonNegative(t.row.tx_bytes);
    const eta = num(t.row.eta);
    const code = asText(t.row.error);
    return {
      key: t.id,
      name: asText(t.row.name) || t.id,
      status,
      sizeBytes: size,
      doneBytes: done,
      speedBps: nonNegative(t.row.rx_rate),
      uploadBps: nonNegative(t.row.tx_rate),
      // only a torrent is shared: what went up over the size
      ratio: t.type === "bt" && size !== null && uploaded !== null ? uploaded / size : null,
      // while seeding `eta` counts to the seed ratio, at a rate of 0 it is 0 — time left only while it loads
      etaSeconds: status === "downloading" && eta !== null && eta > 0 ? eta : null,
      addedMs: epochMs(t.row.created_ts),
      error: status === "failed" && code !== "none" ? code : "",
    };
  });
  return {
    status: {
      version,
      paused,
      // the sums of every task's rates, without a call to `downloads/stats` of its own
      downloadBps: items.reduce((total, i) => total + (i.speedBps ?? 0), 0),
      uploadBps: items.reduce((total, i) => total + (i.uploadBps ?? 0), 0),
      speedLimitBps: limits.down,
      uploadLimitBps: limits.up,
    },
    items,
    complete: true,
  };
}
