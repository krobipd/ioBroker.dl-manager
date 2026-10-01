import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { asRecord, epochMs, eta, fromKiB, nonNegative, num } from "../../core/units";

/** A torrent of `web.update_ui`. */
export interface DlTorrent {
  /** Display name. */
  name?: unknown;
  /** Allocating, Checking, Downloading, Seeding, Paused, Error, Queued, Moving. */
  state?: unknown;
  /** 0..100. */
  progress?: unknown;
  /** Bytes of the wanted files. */
  total_wanted?: unknown;
  /** Bytes done. */
  total_done?: unknown;
  /** Download rate, B/s. */
  download_payload_rate?: unknown;
  /** Upload rate, B/s. */
  upload_payload_rate?: unknown;
  /** Connected peers. */
  num_peers?: unknown;
  /** Connected seeds. */
  num_seeds?: unknown;
  /** Seconds, 0 = no estimate, −1 = over a year. */
  eta?: unknown;
  /** Ratio, −1 = infinite. */
  ratio?: unknown;
  /** Added, Unix seconds. */
  time_added?: unknown;
  /** Completed, Unix seconds, 0 while not. */
  completed_time?: unknown;
  /** Status or error text. */
  message?: unknown;
  /** Label plugin. */
  label?: unknown;
}

/** The keys the driver asks `web.update_ui` for. */
export const DL_KEYS = [
  "name",
  "state",
  "progress",
  "total_wanted",
  "total_done",
  "download_payload_rate",
  "upload_payload_rate",
  "num_peers",
  "num_seeds",
  "eta",
  "ratio",
  "time_added",
  "completed_time",
  "message",
  "label",
];

/** Raw key = state, `:done` when the wanted bytes are all there, `:idle` = rate 0 and no peers. */
export const statusTable = [
  ["Downloading", "downloading"],
  ["Downloading:idle", "waiting"],
  ["Seeding", "seeding"],
  ["Paused", "paused"],
  ["Paused:done", "completed"],
  ["Queued", "queued"],
  ["Checking", "checking"],
  ["Allocating", "checking"],
  ["Moving", "postprocessing"],
  ["Error", "failed"],
] as const satisfies readonly (readonly [string, Status])[];

/**
 * @param raw a key of the status table
 * @returns the torrent it stands for
 */
export function dlTorrentFromRaw(raw: string): DlTorrent {
  const [state, detail] = raw.split(":");
  return {
    state,
    progress: detail === "done" ? 100 : 50,
    total_wanted: 1000,
    total_done: detail === "done" ? 1000 : 500,
    download_payload_rate: detail === "idle" ? 0 : 1000,
    num_peers: detail === "idle" ? 0 : 3,
  };
}

/**
 * @param t a torrent
 * @param debug debug log, names an unknown state
 * @returns status and error text
 */
export function dlStatus(t: DlTorrent, debug: (msg: string) => void): { status: Status; error: string } {
  switch (t.state) {
    case "Downloading": {
      const idle =
        (num(t.download_payload_rate) ?? 0) === 0 && (num(t.num_peers) ?? 0) === 0 && (num(t.num_seeds) ?? 0) === 0;
      return { status: idle ? "waiting" : "downloading", error: "" };
    }
    case "Seeding":
      return { status: "seeding", error: "" };
    case "Paused":
      // "done" by progress — a magnet without metadata wants 0 bytes and has 0 done
      return { status: (num(t.progress) ?? 0) >= 100 ? "completed" : "paused", error: "" };
    case "Queued":
      return { status: "queued", error: "" };
    case "Checking":
    case "Allocating":
      return { status: "checking", error: "" };
    case "Moving":
      return { status: "postprocessing", error: "" };
    case "Error":
      return { status: "failed", error: typeof t.message === "string" ? t.message : "" };
    default:
      debug(`deluge: unknown state "${String(t.state)}" — shown as queued`);
      return { status: "queued", error: "" };
  }
}

/**
 * The map layer as the contract suite sees it.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapDlStatus(raw: string | number, debug: (msg: string) => void): Status {
  return dlStatus(dlTorrentFromRaw(String(raw)), debug).status;
}

/**
 * One poll into the common model.
 *
 * @param version daemon version
 * @param ui `web.update_ui`
 * @param config `core.get_config_values` (limits in KiB/s, −1 = off)
 * @param paused `core.is_session_paused`
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  ui: unknown,
  config: unknown,
  paused: boolean,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const u = asRecord(ui);
  const stats = asRecord(u.stats);
  const cfg = asRecord(config);
  const items: DownloadItem[] = Object.entries(asRecord(u.torrents)).map(([hash, raw]) => {
    const t = asRecord(raw) as DlTorrent;
    const { status, error } = dlStatus(t, debug);
    return {
      key: hash,
      name: typeof t.name === "string" ? t.name : hash,
      status,
      sizeBytes: nonNegative(t.total_wanted),
      doneBytes: nonNegative(t.total_done),
      speedBps: nonNegative(t.download_payload_rate),
      uploadBps: nonNegative(t.upload_payload_rate),
      ratio: nonNegative(t.ratio),
      etaSeconds: eta(t.eta, [0]),
      addedMs: epochMs(t.time_added),
      finishedMs: epochMs(t.completed_time),
      category: typeof t.label === "string" ? t.label : "",
      error,
    };
  });
  return {
    status: {
      version,
      paused,
      downloadBps: nonNegative(stats.download_rate),
      uploadBps: nonNegative(stats.upload_rate),
      speedLimitBps: fromKiB(cfg.max_download_speed),
      uploadLimitBps: fromKiB(cfg.max_upload_speed),
      freeSpaceBytes: nonNegative(stats.free_space),
    },
    items,
    complete: true,
  };
}
