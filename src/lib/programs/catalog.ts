/**
 * What the adapter knows about each program type besides its driver — the one list the registry, the clients, the
 * duplicate check and the settings dialogs read. Types only from the core: nothing here pulls a driver in.
 */
import type { RequiredField } from "../core/model";

/** Program family — one pictogram per family (`admin/icons/<family>.svg`). */
export type Family = "jdownloader" | "torrent" | "usenet" | "aria2" | "pyload";

/**
 * How a program is logged into, which decides the fields of its settings dialog:
 * - `none` — no login (JDownloader's local API)
 * - `account` — My.JDownloader: e-mail, password, the JDownloader instance of the account
 * - `password` — a password only (Deluge's web interface), required
 * - `apiKey` — an API key, required (SABnzbd)
 * - `secret` — an optional RPC secret in the API key field (aria2)
 * - `user` — user and password, both optional (NZBGet)
 * - `optionalUser` — user and password behind a switch (Transmission)
 * - `userOrKey` / `keyOrUser` — user and password OR an API key, the first one preselected (qBittorrent / pyLoad)
 */
export type Login =
  "none" | "account" | "password" | "apiKey" | "secret" | "user" | "optionalUser" | "userOrKey" | "keyOrUser";

/** Every program type the catalog carries. */
export type ProgramType =
  | "jdownloader"
  | "jdownloader-cloud"
  | "qbittorrent"
  | "transmission"
  | "deluge"
  | "sabnzbd"
  | "nzbget"
  | "aria2"
  | "pyload";

/** One program type. */
export interface ProgramInfo {
  /** Program type as stored in the settings (`native.programs[].type`). */
  readonly type: ProgramType;
  /** Product name, the same in every language. */
  readonly label: string;
  /** Pictogram family. */
  readonly family: Family;
  /** The program's default port — used when the settings leave the port empty (0 for a cloud account). */
  readonly port: number;
  /** The default path below the host, "" for the root. */
  readonly path: string;
  /** How the program is logged into. */
  readonly login: Login;
}

/** THE list of program types, in the order the settings dialog offers them. */
export const CATALOG: readonly ProgramInfo[] = [
  { type: "jdownloader", label: "JDownloader 2", family: "jdownloader", port: 3128, path: "", login: "none" },
  { type: "jdownloader-cloud", label: "JDownloader 2", family: "jdownloader", port: 0, path: "", login: "account" },
  { type: "qbittorrent", label: "qBittorrent", family: "torrent", port: 8080, path: "", login: "userOrKey" },
  {
    type: "transmission",
    label: "Transmission",
    family: "torrent",
    port: 9091,
    path: "/transmission/rpc",
    login: "optionalUser",
  },
  { type: "deluge", label: "Deluge", family: "torrent", port: 8112, path: "", login: "password" },
  { type: "sabnzbd", label: "SABnzbd", family: "usenet", port: 8080, path: "", login: "apiKey" },
  { type: "nzbget", label: "NZBGet", family: "usenet", port: 6789, path: "", login: "user" },
  { type: "aria2", label: "aria2", family: "aria2", port: 6800, path: "/jsonrpc", login: "secret" },
  { type: "pyload", label: "pyLoad", family: "pyload", port: 8000, path: "", login: "keyOrUser" },
];

/**
 * @param type program type from outside (settings, device object)
 * @returns its catalog entry, undefined for a type the adapter does not know
 */
export function programInfo(type: string): ProgramInfo | undefined {
  return CATALOG.find(p => p.type === type);
}

/**
 * @param type a program type the code names itself
 * @returns its catalog entry
 */
export function catalogEntry(type: ProgramType): ProgramInfo {
  const info = programInfo(type);
  if (!info) {
    throw new Error(`catalog: no entry for ${type}`);
  }
  return info;
}

/**
 * @param info the program
 * @returns the fields a settings row must fill for it
 */
export function needsOf(info: Pick<ProgramInfo, "login">): RequiredField[] {
  switch (info.login) {
    case "account":
      return ["username", "password", "device"];
    case "password":
      return ["host", "password"];
    case "apiKey":
      return ["host", "apiKey"];
    default:
      return ["host"];
  }
}

/** The address part of a settings row. */
export interface Endpoint {
  /** Host name or IP address. */
  host: string;
  /** Port, 0 = the program's default. */
  port: number;
  /** Use TLS. */
  https: boolean;
  /** Path below the host, "" = the program's default. */
  path: string;
}

/**
 * @param cfg the row's address
 * @param info the program's defaults
 * @returns the port and path the program is actually reached at — the path with a leading and no trailing `/`, "" for
 *   the root
 */
export function effectiveEndpoint(
  cfg: Endpoint,
  info: Pick<ProgramInfo, "port" | "path">,
): { port: number; path: string } {
  const own = cfg.path.trim().replace(/\/+$/, "");
  const path = own || info.path;
  return { port: cfg.port || info.port, path: path && !path.startsWith("/") ? `/${path}` : path };
}

/**
 * @param cfg the row's address
 * @param info the program's defaults
 * @param scheme `http` (→ `https` with TLS) or `ws` (→ `wss`)
 * @returns `<scheme>://<host>:<port><path>` — the base every client appends its own endpoint to
 */
export function baseUrl(
  cfg: Endpoint,
  info: Pick<ProgramInfo, "port" | "path">,
  scheme: "http" | "ws" = "http",
): string {
  const { port, path } = effectiveEndpoint(cfg, info);
  return `${scheme}${cfg.https ? "s" : ""}://${cfg.host}:${port}${path}`;
}
