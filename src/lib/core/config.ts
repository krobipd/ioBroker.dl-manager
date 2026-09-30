import { baseUrl, programInfo } from "../programs/catalog";
import type { ProgramConfig, ProgramEntry, RequiredField } from "./model";
import { programId, sanitize } from "./ids";
import type { TreeScope } from "./tree";

/** One program row after reading. */
export interface ProgramRow {
  /** Device id, stored in the row (`device-id.ts`). */
  id: string;
  /** The id follows the id scheme — false for a My.JDownloader row whose instance id is not known yet. */
  scheme: boolean;
  /** Switched on on its card. */
  enabled: boolean;
  /** Cleaned values. */
  cfg: ProgramConfig;
  /** Why the row cannot run, empty when it can (always empty for a disabled row). */
  problem: string;
  /** The program's registry entry — present exactly when the row is enabled and can run. */
  entry?: ProgramEntry;
}

const FIELD_TEXT: Readonly<Record<RequiredField, string>> = {
  host: "host missing",
  username: "user missing",
  password: "password missing",
  apiKey: "API key missing",
  device: "device missing",
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * @param id a stored device id
 * @returns it when it is a valid id segment, "" otherwise
 */
const sanitizeId = (id: string): string => (id === sanitize(id) ? id : "");

/**
 * The device id a row had up to 0.2.0: `<type>-<key>` from the row's ID column.
 *
 * @param raw a stored row
 * @returns its old device id
 */
export function legacyId(raw: Record<string, unknown>): string {
  return programId(sanitize(str(raw.type)) || "program", str(raw.key));
}

/**
 * Reads the program rows (secrets readable, see `store.ts`). Every row that has a type becomes a row here — an
 * unusable one carries its problem, so its device can show it.
 *
 * @param raw the rows
 * @param find registry lookup
 * @returns the rows in stored order
 */
export function parsePrograms(raw: unknown, find: (type: string) => ProgramEntry | undefined): ProgramRow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows: ProgramRow[] = [];
  const seen = new Set<string>();
  for (const r of raw as unknown[]) {
    if (!r || typeof r !== "object") {
      continue;
    }
    const o = r as Record<string, unknown>;
    const port = typeof o.port === "number" && Number.isInteger(o.port) && o.port > 0 && o.port < 65536 ? o.port : 0;
    const cfg: ProgramConfig = {
      type: str(o.type),
      name: str(o.name),
      host: str(o.host),
      port,
      https: o.https === true,
      path: str(o.path),
      username: str(o.username),
      password: str(o.password),
      apiKey: str(o.apiKey),
      device: str(o.device),
      deviceId: str(o.deviceId),
    };
    const id = sanitizeId(str(o.id)) || legacyId(o);
    const enabled = o.enabled !== false;
    let problem = "";
    let entry: ProgramEntry | undefined;
    if (enabled) {
      entry = cfg.type ? find(cfg.type) : undefined;
      if (!cfg.type) {
        problem = "program type missing";
      } else if (!entry) {
        problem = `unknown program type: ${cfg.type}`;
      } else if (seen.has(id)) {
        problem = `device id ${id} is used twice`;
      } else {
        const missing = entry.needs.find(f => !cfg[f]);
        const twin = missing ? undefined : rows.find(o => o.enabled && !o.problem && sameProgram(o.cfg, cfg));
        problem = missing ? FIELD_TEXT[missing] : twin ? `same program as ${twin.id}` : "";
      }
    }
    seen.add(id);
    rows.push({ id, scheme: o.idPending !== true, enabled, cfg, problem, ...(entry && !problem ? { entry } : {}) });
  }
  return rows;
}

/**
 * What identifies a program besides its device id — shown on its card, stored at its device and compared to find a
 * program configured twice.
 *
 * @param cfg the row
 * @returns the URL the program is reached at (its default port and path filled in), or `<account>/<device>` for a
 *   program reached through a cloud account
 */
export function addressOf(
  cfg: Pick<ProgramConfig, "type" | "host" | "port" | "https" | "path" | "username" | "device">,
): string {
  if (!cfg.host) {
    return `${cfg.username}/${cfg.device}`;
  }
  return baseUrl(cfg, programInfo(cfg.type) ?? { port: 0, path: "" }).replace(/:0(?=\/|$)/, "");
}

/** The fields of a row that say which program it reaches. */
type Target = Pick<ProgramConfig, "type" | "host" | "port" | "https" | "path" | "username" | "device">;

/**
 * @param cfg a row
 * @returns what two rows share when they reach the same program: the address without its scheme (TLS or not, it is the
 *   same program), lower case — the settings dialog embeds these to refuse a second entry for one program
 */
export function programKey(cfg: Target): string {
  return addressOf(cfg)
    .replace(/^[a-z]+:\/\//, "")
    .toLowerCase();
}

/**
 * Two rows that reach the same program — the same host, port and path or the same account and device. The adapter would
 * ask it twice and build two devices for it.
 *
 * @param a one row
 * @param b the other
 * @returns whether both reach the same program
 */
export function sameProgram(a: Target, b: Target): boolean {
  return programKey(a) === programKey(b);
}

/**
 * @param raw `native.pollInterval` in seconds
 * @returns the poll interval in ms, 10 s to 1 h (a stored value below 10 s runs at 10 s), 10 s when unusable
 */
export function parsePollInterval(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return 10_000;
  }
  return Math.min(3600, Math.max(10, Math.round(n))) * 1000;
}

const TREE_SCOPES: readonly TreeScope[] = ["all", "withoutCompleted", "unfinished"];

/**
 * @param raw `native.treeScope`
 * @returns which downloads the object tree shows, `all` when unknown
 */
export function parseTreeScope(raw: unknown): TreeScope {
  return TREE_SCOPES.find(s => s === raw) ?? "all";
}

/**
 * @param raw `native.maxDownloads`
 * @returns how many downloads per program the object tree shows, 0 to 1000 (0 = all), 100 when unusable
 */
export function parseMaxDownloads(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return 100;
  }
  return Math.min(1000, Math.max(0, Math.floor(n)));
}
