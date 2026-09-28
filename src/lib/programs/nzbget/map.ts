import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { hiLo, num } from "../../core/units";

const PP = [
  "PP_QUEUED",
  "LOADING_PARS",
  "VERIFYING_SOURCES",
  "REPAIRING",
  "VERIFYING_REPAIRED",
  "RENAMING",
  "UNPACKING",
  "MOVING",
  "POST_UNPACK_RENAMING",
  "POST_DOWNLOAD_RENAMING",
  "EXECUTING_SCRIPT",
  "PP_FINISHED",
  "QS_QUEUED",
  "QS_EXECUTING",
] as const;
const DONE = [
  "SUCCESS/ALL",
  "SUCCESS/UNPACK",
  "SUCCESS/PAR",
  "SUCCESS/HEALTH",
  "SUCCESS/GOOD",
  "SUCCESS/MARK",
  "WARNING/SCRIPT",
] as const;
const FAILED = [
  "WARNING/SPACE",
  "WARNING/PASSWORD",
  "WARNING/DAMAGED",
  "WARNING/REPAIRABLE",
  "WARNING/HEALTH",
  "WARNING/SKIPPED",
  "FAILURE/PAR",
  "FAILURE/UNPACK",
  "FAILURE/MOVE",
  "FAILURE/SCAN",
  "FAILURE/BAD",
  "FAILURE/HEALTH",
  "FAILURE/FETCH",
  "FAILURE/INTERNAL_ERROR",
] as const;

/** Raw key `q:<listgroups Status>` or `h:<history Status>`; `q:*:globalPause` = download paused. */
export const statusTable = [
  ["q:QUEUED", "queued"],
  ["q:PAUSED", "paused"],
  ["q:DOWNLOADING", "downloading"],
  ["q:FETCHING", "downloading"],
  ["q:DOWNLOADING:globalPause", "paused"],
  ...PP.map(s => [`q:${s}`, "postprocessing"] as const),
  ...DONE.map(s => [`h:${s}`, "completed"] as const),
  ...FAILED.map(s => [`h:${s}`, "failed"] as const),
] as const satisfies readonly (readonly [string, Status])[];

const QUEUE: ReadonlyMap<string, Status> = new Map<string, Status>([
  ["QUEUED", "queued"],
  ["PAUSED", "paused"],
  ["DOWNLOADING", "downloading"],
  ["FETCHING", "downloading"],
  ...PP.map(s => [s, "postprocessing"] as const),
]);
const HISTORY: ReadonlyMap<string, Status> = new Map<string, Status>([
  ...DONE.map(s => [s, "completed"] as const),
  ...FAILED.map(s => [s, "failed"] as const),
]);

/**
 * @param raw a key of the status table
 * @param debug debug log, names an unknown status
 * @returns the status
 */
export function mapNzbStatus(raw: string | number, debug: (msg: string) => void): Status {
  const [list, status, flag] = String(raw).split(":");
  const known = (list === "h" ? HISTORY : QUEUE).get(status);
  if (known === undefined) {
    // an unknown history text still says SUCCESS/FAILURE/WARNING before the slash
    const prefix = list === "h" ? status.split("/")[0] : "";
    debug(`nzbget: unknown status ${String(raw)}`);
    return prefix === "SUCCESS" ? "completed" : prefix === "FAILURE" || prefix === "WARNING" ? "failed" : "queued";
  }
  if (flag === "globalPause" && (known === "queued" || known === "downloading")) {
    return "paused";
  }
  return known;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * One poll into the common model. A job deleted by the user (history DELETED/*) is not shown.
 *
 * @param version `version()`
 * @param status `status()`
 * @param groups `listgroups(0)`
 * @param history `history(false)`
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  status: unknown,
  groups: unknown,
  history: unknown,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const st = obj(status);
  const paused = st.DownloadPaused === true;
  const items: DownloadItem[] = [];
  for (const g of list(groups)) {
    const id = num(g.NZBID);
    if (id === null) {
      continue;
    }
    const raw = text(g.Status);
    const size = hiLo(g.FileSizeHi, g.FileSizeLo);
    const left = hiLo(g.RemainingSizeHi, g.RemainingSizeLo);
    items.push({
      key: String(id),
      name: text(g.NZBName) || String(id),
      status: mapNzbStatus(`q:${raw}${paused ? ":globalPause" : ""}`, debug),
      rawStatus: raw,
      sizeBytes: size,
      doneBytes: size !== null && left !== null ? Math.max(0, size - left) : null,
      speedBps: null,
      etaSeconds: null,
      category: text(g.Category),
      error: "",
    });
  }
  for (const h of list(history)) {
    const id = num(h.NZBID);
    const raw = text(h.Status);
    if (id === null || raw.startsWith("DELETED/")) {
      continue;
    }
    const s = mapNzbStatus(`h:${raw}`, debug);
    const time = num(h.HistoryTime);
    items.push({
      key: String(id),
      name: text(h.Name) || String(id),
      status: s,
      rawStatus: raw,
      sizeBytes: hiLo(h.FileSizeHi, h.FileSizeLo),
      doneBytes: hiLo(h.DownloadedSizeHi, h.DownloadedSizeLo),
      speedBps: null,
      etaSeconds: null,
      finishedMs: time !== null && time > 0 ? time * 1000 : null,
      category: text(h.Category),
      error: s === "failed" ? raw : "",
    });
  }
  return {
    status: {
      version,
      paused,
      downloadBps: hiLo(st.DownloadRateHi, st.DownloadRateLo) ?? num(st.DownloadRate),
      speedLimitBps: num(st.DownloadLimit) ?? 0,
      freeSpaceBytes: hiLo(st.FreeDiskSpaceHi, st.FreeDiskSpaceLo),
    },
    items,
    complete: true,
  };
}
