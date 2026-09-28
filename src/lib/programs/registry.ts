import type { PauseStore } from "../core/emulated-pause";
import type { ProgramDriver } from "../core/model";
import { JdDriver } from "./jdownloader/driver";
import { QbDriver } from "./qbittorrent/driver";

/** One row of the settings table, cleaned and with its secrets decrypted. */
export interface ProgramConfig {
  /** Program type, e.g. `qbittorrent`. */
  type: string;
  /** The user's ID column — part of the device id. */
  key: string;
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
}

/** A settings field a program cannot work without. */
export type RequiredField = "host" | "username" | "password" | "apiKey" | "device";

/** Adapter services a driver may use — timers only through the adapter. */
export interface DriverDeps {
  /** The adapter's timer. */
  setTimeout(cb: () => void, ms: number): ioBroker.Timeout | undefined;
  /** Clears an adapter timer. */
  clearTimeout(t: ioBroker.Timeout | undefined): void;
  /** The adapter log. */
  log: { debug(msg: string): void; info(msg: string): void; warn(msg: string): void };
  /** Where an emulated global pause keeps its state (absent in the connection test — then kept in memory). */
  pauseStore?: PauseStore;
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

/** THE program list — one line per driver. */
export const PROGRAMS: readonly ProgramEntry[] = [
  { type: "jdownloader", needs: ["host"], create: (cfg, deps) => new JdDriver(cfg, deps) },
  { type: "qbittorrent", needs: ["host"], create: (cfg, deps) => new QbDriver(cfg, deps) },
];

/**
 * @param type program type from the settings table
 * @returns the registry entry, undefined for a type the adapter does not know
 */
export function findProgram(type: string): ProgramEntry | undefined {
  return PROGRAMS.find(p => p.type === type);
}
