import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { num } from "../../core/units";

/** Raw key = status, `:0` = download speed 0. `removed` and entries followed by another are not shown. */
export const statusTable = [
  ["active", "downloading"],
  ["active:0", "waiting"],
  ["waiting", "queued"],
  ["paused", "paused"],
  ["complete", "completed"],
  ["error", "failed"],
] as const satisfies readonly (readonly [string, Status])[];

/**
 * @param raw a key of the status table
 * @param debug debug log, names an unknown status
 * @returns the status
 */
export function mapAriaStatus(raw: string | number, debug: (msg: string) => void): Status {
  const [status, speed] = String(raw).split(":");
  switch (status) {
    case "active":
      return speed === "0" ? "waiting" : "downloading";
    case "waiting":
      return "queued";
    case "paused":
      return "paused";
    case "complete":
      return "completed";
    case "error":
      return "failed";
    default:
      debug(`aria2: unknown status "${String(raw)}" — shown as queued`);
      return "queued";
  }
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const nonNegative = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};

/**
 * @param e a download of tellActive/tellWaiting/tellStopped
 * @returns the torrent's name, the first file's name, or its first URL
 */
export function ariaName(e: Record<string, unknown>): string {
  const bt = obj(obj(e.bittorrent).info).name;
  if (typeof bt === "string" && bt) {
    return bt;
  }
  const file = obj(arr(e.files)[0]);
  const path = typeof file.path === "string" ? file.path : "";
  if (path) {
    return path.split("/").pop() ?? path;
  }
  const uri = obj(arr(file.uris)[0]).uri;
  return typeof uri === "string" ? uri : typeof e.gid === "string" ? e.gid : "";
}

/**
 * One poll into the common model.
 *
 * @param version `aria2.getVersion`
 * @param entries tellActive + tellWaiting + tellStopped
 * @param stat `aria2.getGlobalStat`
 * @param option `aria2.getGlobalOption`
 * @param paused the adapter holds the program paused
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  entries: readonly unknown[],
  stat: unknown,
  option: unknown,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = [];
  for (const raw of entries) {
    const e = obj(raw);
    const gid = typeof e.gid === "string" ? e.gid : "";
    if (!gid || e.status === "removed" || arr(e.followedBy).length > 0) {
      continue;
    }
    const speed = nonNegative(e.downloadSpeed);
    const size = nonNegative(e.totalLength);
    const done = nonNegative(e.completedLength);
    const status = mapAriaStatus(`${String(e.status)}${e.status === "active" && speed === 0 ? ":0" : ""}`, debug);
    items.push({
      key: gid,
      name: ariaName(e),
      status,
      rawStatus: String(e.status),
      sizeBytes: size !== null && size > 0 ? size : null,
      doneBytes: done,
      speedBps: speed,
      uploadBps: nonNegative(e.uploadSpeed),
      etaSeconds: speed && size !== null && done !== null && size > done ? Math.round((size - done) / speed) : null,
      error:
        status === "failed"
          ? typeof e.errorMessage === "string"
            ? e.errorMessage
            : `error ${String(e.errorCode)}`
          : "",
    });
  }
  const s = obj(stat);
  const o = obj(option);
  return {
    status: {
      version,
      paused,
      downloadBps: nonNegative(s.downloadSpeed),
      uploadBps: nonNegative(s.uploadSpeed),
      speedLimitBps: nonNegative(o["max-overall-download-limit"]) ?? 0,
      uploadLimitBps: nonNegative(o["max-overall-upload-limit"]) ?? 0,
    },
    items,
    complete: true,
  };
}
