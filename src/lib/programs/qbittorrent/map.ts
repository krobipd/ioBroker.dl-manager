import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { eta, num } from "../../core/units";

/** A torrent of `sync/maindata` — only the fields the adapter reads. */
export interface QbTorrent {
  /** Display name. */
  name?: unknown;
  /** State string (§ 1.4). */
  state?: unknown;
  /** Size of the selected files, bytes. */
  size?: unknown;
  /** Bytes done. */
  completed?: unknown;
  /** Download speed, B/s. */
  dlspeed?: unknown;
  /** Upload speed, B/s. */
  upspeed?: unknown;
  /** Seconds left, 8640000 = unknown. */
  eta?: unknown;
  /** Upload ratio, −1 = ≥ 9999. */
  ratio?: unknown;
  /** Added, Unix seconds. */
  added_on?: unknown;
  /** Finished, Unix seconds; −1 (5.x) or 0 (4.x) while not finished. */
  completion_on?: unknown;
  /** Category. */
  category?: unknown;
  /** Force started. */
  force_start?: unknown;
  /** A tracker reported an error. */
  has_tracker_error?: unknown;
}

/** Every state of qBittorrent 4.6–5.3 (api-torrent.md § 1.4) and the status it maps to. */
export const statusTable = [
  ["downloading", "downloading"],
  ["forcedDL", "downloading"],
  ["metaDL", "checking"],
  ["forcedMetaDL", "checking"],
  ["checkingDL", "checking"],
  ["checkingUP", "checking"],
  ["checkingResumeData", "checking"],
  ["allocating", "checking"],
  ["stalledDL", "waiting"],
  ["queuedDL", "queued"],
  ["stoppedDL", "paused"],
  ["pausedDL", "paused"],
  ["uploading", "seeding"],
  ["stalledUP", "seeding"],
  ["forcedUP", "seeding"],
  ["queuedUP", "seeding"],
  ["stoppedUP", "completed"],
  ["pausedUP", "completed"],
  ["moving", "postprocessing"],
  ["error", "failed"],
  ["missingFiles", "failed"],
  ["unknown", "queued"],
] as const satisfies readonly (readonly [string, Status])[];

const KNOWN: ReadonlyMap<string, Status> = new Map(statusTable);
const STOPPED = /^(stopped|paused)(DL|UP)$/;

/**
 * @param raw qBittorrent's `state`
 * @param debug debug log, names a state the adapter does not know
 * @returns the common status
 */
export function mapQbState(raw: string | number, debug: (msg: string) => void): Status {
  const s = KNOWN.get(String(raw));
  if (s === undefined) {
    debug(`qbittorrent: unknown state "${raw}" — shown as queued`);
    return "queued";
  }
  return s;
}

/**
 * @param text `app/version`, e.g. `v5.2.3`
 * @returns major, minor, patch — zeros when unreadable
 */
export function parseQbVersion(text: unknown): [number, number, number] {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(typeof text === "string" ? text : "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : [0, 0, 0];
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The merged picture of `sync/maindata`: a full update replaces, a partial one changes fields. */
export class MaindataState {
  /** Response id to send with the next request. */
  public rid = 0;
  /** Torrents by hash. */
  public torrents: Record<string, QbTorrent> = {};
  /** Program-wide values. */
  public serverState: Record<string, unknown> = {};

  /** @param raw one answer of `sync/maindata` */
  public apply(raw: unknown): void {
    const r = obj(raw);
    if (typeof r.rid === "number") {
      this.rid = r.rid;
    }
    if (r.full_update === true) {
      this.torrents = {};
      this.serverState = {};
    }
    for (const [hash, fields] of Object.entries(obj(r.torrents))) {
      this.torrents[hash] = { ...this.torrents[hash], ...obj(fields) };
    }
    if (Array.isArray(r.torrents_removed)) {
      for (const hash of r.torrents_removed) {
        delete this.torrents[String(hash)];
      }
    }
    this.serverState = { ...this.serverState, ...obj(r.server_state) };
  }

  /** Forgets everything — the next request asks for a full update. */
  public reset(): void {
    this.rid = 0;
    this.torrents = {};
    this.serverState = {};
  }
}

/**
 * @param m the merged state
 * @returns hashes of the torrents that run, wait or seed (not stopped, not failed)
 */
export function qbRunning(m: MaindataState): Set<string> {
  return new Set(
    Object.entries(m.torrents)
      .filter(([, t]) => {
        const s = typeof t.state === "string" ? t.state : "";
        return !STOPPED.test(s) && s !== "error" && s !== "missingFiles";
      })
      .map(([hash]) => hash),
  );
}

const nonNegative = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};
const seconds = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n * 1000 : null;
};

/**
 * One poll into the common model.
 *
 * @param version `app/version`
 * @param m the merged maindata
 * @param paused the program is paused (session pause from 5.3, the adapter-made pause below)
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  m: MaindataState,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const items: DownloadItem[] = Object.entries(m.torrents).map(([hash, t]) => {
    const raw = typeof t.state === "string" ? t.state : "unknown";
    const status = mapQbState(raw, debug);
    const ratio = num(t.ratio);
    let error = "";
    if (status === "failed") {
      error = raw === "missingFiles" ? "files missing" : t.has_tracker_error === true ? "tracker error" : "error";
    }
    return {
      key: hash,
      name: typeof t.name === "string" ? t.name : hash,
      status,
      rawStatus: raw,
      sizeBytes: nonNegative(t.size),
      doneBytes: nonNegative(t.completed),
      speedBps: nonNegative(t.dlspeed),
      uploadBps: nonNegative(t.upspeed),
      ratio: ratio !== null && ratio >= 0 ? ratio : null,
      etaSeconds: eta(t.eta, [8640000]),
      addedMs: seconds(t.added_on),
      finishedMs: seconds(t.completion_on),
      category: typeof t.category === "string" ? t.category : "",
      error,
      extra: { forceStart: t.force_start === true },
    };
  });
  const ss = m.serverState;
  return {
    status: {
      version: version.replace(/^v/, ""),
      paused,
      downloadBps: nonNegative(ss.dl_info_speed),
      uploadBps: nonNegative(ss.up_info_speed),
      speedLimitBps: nonNegative(ss.dl_rate_limit) ?? 0,
      uploadLimitBps: nonNegative(ss.up_rate_limit) ?? 0,
      altSpeed: ss.use_alt_speed_limits === true,
      freeSpaceBytes: nonNegative(ss.free_space_on_disk),
    },
    items,
    complete: true,
  };
}
