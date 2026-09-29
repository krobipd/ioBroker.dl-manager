import type { I18nKey } from "../i18n";
import type { PauseStore } from "./emulated-pause";
import type { HttpTimers } from "./http";

/** The one status list every program maps onto, in display order. */
export const STATUSES = [
  "queued",
  "downloading",
  "waiting",
  "paused",
  "checking",
  "postprocessing",
  "seeding",
  "completed",
  "failed",
] as const;

/** A download's status, the same for every program. */
export type Status = (typeof STATUSES)[number];

/** Statuses that count as "active" (the program is working on the download). */
export const ACTIVE: ReadonlySet<Status> = new Set<Status>(["downloading", "postprocessing"]);

/** Which datapoints and commands exist for a program. A missing capability means: no datapoint. */
export type Capability =
  | "globalPause"
  | "itemPause"
  | "itemRemove"
  | "add"
  | "speedLimit"
  | "upload"
  | "uploadLimit"
  | "altSpeed"
  | "freeSpace"
  | "itemSpeed"
  | "itemEta"
  | "itemAdded"
  | "itemFinished"
  | "category"
  | "itemError";

/**
 * @param items the downloads of a poll
 * @returns how many run right now (downloading, checking, post-processing …)
 */
export const countActive = (items: readonly { status: Status }[]): number =>
  items.filter(i => ACTIVE.has(i.status)).length;

/**
 * @param items the downloads of a poll
 * @returns how many wait in the queue
 */
export const countQueued = (items: readonly { status: Status }[]): number =>
  items.filter(i => i.status === "queued").length;

/** One download in the common model — the unit the user added (JD/pyLoad package, torrent, NZB job, aria2 GID). */
export interface DownloadItem {
  /** Stable raw key of the program (hash, nzo_id, NZBID, GID, JD package uuid, pyLoad pid). */
  key: string;
  /** Display name as the program reports it. */
  name: string;
  /** Mapped status. */
  status: Status;
  /** Total size in bytes, null while unknown. */
  sizeBytes: number | null;
  /** Bytes done, null while unknown. */
  doneBytes: number | null;
  /** Download speed in bytes per second, null where the program does not report one per download. */
  speedBps: number | null;
  /** Upload speed in bytes per second (torrent programs). */
  uploadBps?: number | null;
  /** Upload ratio (torrent programs). */
  ratio?: number | null;
  /** Seconds left, null while unknown. */
  etaSeconds: number | null;
  /** Time the download was added, ms since epoch. */
  addedMs?: number | null;
  /** Time the download finished, ms since epoch. */
  finishedMs?: number | null;
  /** Category or label. */
  category?: string;
  /** The program's error text, empty while all is well. */
  error: string;
  /** Program-specific extra values, declared by the driver in `extras`. */
  extra?: Readonly<Record<string, ioBroker.StateValue>>;
}

/** Program-wide values of one query. */
export interface ProgramStatus {
  /** Program version. */
  version: string;
  /** Whether the program is paused as a whole. */
  paused: boolean;
  /** Total download speed in bytes per second. */
  downloadBps: number | null;
  /** Total upload speed in bytes per second (torrent programs). */
  uploadBps?: number | null;
  /** Download limit in bytes per second, 0 = unlimited. */
  speedLimitBps?: number | null;
  /** Upload limit in bytes per second, 0 = unlimited. */
  uploadLimitBps?: number | null;
  /** Alternative speed limits on. */
  altSpeed?: boolean;
  /** Free space in the download folder, bytes. */
  freeSpaceBytes?: number | null;
  /** Program-specific extra values, declared by the driver in `extras`. */
  extra?: Readonly<Record<string, ioBroker.StateValue>>;
}

/** The result of one query of a program. */
export interface ProgramSnapshot {
  /** Program-wide values. */
  status: ProgramStatus;
  /** Every download the program lists. */
  items: DownloadItem[];
  /** False when any list the driver needs failed — then nothing is removed from the tree. */
  complete: boolean;
}

/** A command the adapter sends to a program. */
export type Command =
  | { kind: "pauseAll" }
  | { kind: "resumeAll" }
  | { kind: "pause"; key: string }
  | { kind: "resume"; key: string }
  | { kind: "remove"; key: string }
  | { kind: "add"; url: string }
  | { kind: "setSpeedLimit"; bps: number }
  | { kind: "setUploadLimit"; bps: number }
  | { kind: "setAltSpeed"; on: boolean }
  | { kind: "extra"; name: string; key?: string; value?: ioBroker.StateValue };

/** A program-specific datapoint or button, declared by its driver. */
export interface ExtraDefinition {
  /** Datapoint id below the device (`program`) or below each download (`item`). */
  id: string;
  /** Where the datapoint lives. */
  level: "program" | "item";
  /** Value type. */
  type: ioBroker.CommonType;
  /** Role from the ioBroker catalog. */
  role: string;
  /** Unit, if any. */
  unit?: string;
  /** Writable. */
  write: boolean;
  /** Readable. */
  read: boolean;
  /** i18n key of the name in admin/i18n/en.json. */
  nameKey: I18nKey;
  /** i18n key of the explanation. */
  descKey?: I18nKey;
}

/** What every program implements. The core never names a program. */
export interface ProgramDriver {
  /** Program type as in the registry (`qbittorrent`, `jdownloader`, …). */
  readonly type: string;
  /** Capabilities that decide which datapoints exist. */
  readonly capabilities: ReadonlySet<Capability>;
  /** Program-specific datapoints and buttons. */
  readonly extras: readonly ExtraDefinition[];
  /** One complete query. */
  poll(): Promise<ProgramSnapshot>;
  /** Sends a command; throws when the program refuses or does not support it. */
  command(cmd: Command): Promise<void>;
  /** Releases connections and timers. */
  close(): Promise<void>;
  /**
   * Optional quiet check for the settings page's connection test (e.g. SABnzbd `mode=auth`, which leaves no warning
   * in the program on a wrong key); without it the test polls once.
   */
  test?(): Promise<string>;
  /** Shortest poll interval the program tolerates (My.JDownloader: 30 s); the adapter never polls faster. */
  readonly minIntervalMs?: number;
  /** Optional push channel; it only triggers an immediate poll, it never carries values. */
  subscribe?(onChange: () => void): () => void;
}

/** The adapter log, as far as the core and the drivers write to it. */
export interface AdapterLog {
  /** Routine. */
  debug(msg: string): void;
  /** Relevant events. */
  info(msg: string): void;
  /** Something the user should look at. */
  warn(msg: string): void;
}

/** A settings field a program cannot work without. */
export type RequiredField = "host" | "username" | "password" | "apiKey" | "device";

/** One row of the settings table, cleaned and with its secrets decrypted. */
export interface ProgramConfig {
  /** Program type, e.g. `qbittorrent`. */
  type: string;
  /** Display name of the device. */
  name: string;
  /** Host name or IP address. */
  host: string;
  /** Port, 0 = the program's default. */
  port: number;
  /** Use HTTPS. */
  https: boolean;
  /** URL path below the host (reverse proxy, NZBGet/SABnzbd base path). */
  path: string;
  /** Login user (My.JDownloader: e-mail address). */
  username: string;
  /** Login password, decrypted. */
  password: string;
  /** API key or RPC secret, decrypted. */
  apiKey: string;
  /** My.JDownloader device name. */
  device: string;
  /** My.JDownloader: the id the account lists for the device, "" until known. */
  deviceId: string;
}

/** Adapter services a driver may use — timers only through the adapter. */
export interface DriverDeps extends HttpTimers {
  /** The adapter log. */
  log: AdapterLog;
  /** Where an emulated global pause keeps its state (absent in the connection test — then kept in memory). */
  pauseStore?: PauseStore;
  /** My.JDownloader: the account listed the device under this id — the adapter stores it (absent in the test). */
  onDeviceId?: (id: string) => void;
}

/** A program the adapter can talk to. */
export interface ProgramEntry {
  /** Program type as stored in the settings table. */
  readonly type: string;
  /** Fields the row must fill. */
  readonly needs: readonly RequiredField[];
  /** Builds the driver for one configured program. */
  create(cfg: ProgramConfig, deps: DriverDeps): ProgramDriver;
}
