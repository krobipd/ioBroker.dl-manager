import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { statusFrom } from "../../core/status";
import { asRecord, nonNegative, sizeOf } from "../../core/units";

/**
 * Raw key = status, `:seed` = a torrent that only seeds (`seeder: "true"`), `:0` = download speed 0. `removed` and
 * entries followed by another are not shown.
 */
export const statusTable = [
  ["active", "downloading"],
  ["active:seed", "seeding"],
  ["active:0", "waiting"],
  ["waiting", "queued"],
  ["paused", "paused"],
  ["complete", "completed"],
  ["error", "failed"],
] as const satisfies readonly (readonly [string, Status])[];

const STATUS = new Map<string, Status>(statusTable);

/**
 * @param raw a key of the status table
 * @param debug debug log, names an unknown status
 * @returns the status
 */
export function mapAriaStatus(raw: string | number, debug: (msg: string) => void): Status {
  return statusFrom(STATUS, String(raw), "aria2", debug);
}

/**
 * @param e a download of tellActive/tellWaiting/tellStopped
 * @param speed its download speed
 * @returns its key in the status table
 */
function rawStatus(e: Record<string, unknown>, speed: number | null): string {
  const status = String(e.status);
  if (status !== "active") {
    return status;
  }
  // a seeding torrent loads nothing: it is not waiting, it is done and gives back
  return e.seeder === "true" ? "active:seed" : speed === 0 ? "active:0" : "active";
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * @param e a download of tellActive/tellWaiting/tellStopped
 * @returns the torrent's name, the first file's name, or its first URL
 */
export function ariaName(e: Record<string, unknown>): string {
  const bt = asRecord(asRecord(e.bittorrent).info).name;
  if (typeof bt === "string" && bt) {
    return bt;
  }
  const file = asRecord(arr(e.files)[0]);
  const path = typeof file.path === "string" ? file.path : "";
  if (path) {
    return path.split("/").pop() ?? path;
  }
  const uri = asRecord(arr(file.uris)[0]).uri;
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
    const e = asRecord(raw);
    const gid = typeof e.gid === "string" ? e.gid : "";
    if (!gid || e.status === "removed" || arr(e.followedBy).length > 0) {
      continue;
    }
    const speed = nonNegative(e.downloadSpeed);
    const size = sizeOf(e.totalLength);
    const done = nonNegative(e.completedLength);
    const status = mapAriaStatus(rawStatus(e, speed), debug);
    const torrent = Object.keys(asRecord(e.bittorrent)).length > 0;
    items.push({
      key: gid,
      name: ariaName(e),
      status,
      sizeBytes: size,
      doneBytes: done,
      speedBps: speed,
      uploadBps: nonNegative(e.uploadSpeed),
      // aria2 reports no ratio: what a torrent gave back over what it has
      ratio: torrent && done ? (nonNegative(e.uploadLength) ?? 0) / done : null,
      etaSeconds: speed && size !== null && done !== null && size > done ? Math.round((size - done) / speed) : null,
      error:
        status === "failed"
          ? typeof e.errorMessage === "string"
            ? e.errorMessage
            : `error ${String(e.errorCode)}`
          : "",
    });
  }
  const s = asRecord(stat);
  const o = asRecord(option);
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
