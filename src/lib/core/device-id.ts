import { programInfo } from "../programs/catalog";
import { sanitize } from "./ids";

/**
 * The device id of a program: `<program>-<piece>`, the scheme of the fleet's device adapters (yamaha, govee,
 * homeconnect: model + the last four characters of the piece's own number). Decided once when the program is added,
 * stored in its settings row and never derived again — a new name, a new address or a switch between local and
 * My.JDownloader keeps the device where it is.
 */

/** Marks a device object whose id follows this scheme (`native.idScheme`), as in the sister adapters. */
export const ID_SCHEME = 3;

/** Roots of the instance that are never a program's device. */
export const RESERVED_IDS: ReadonlySet<string> = new Set(["info", "summary", "programs"]);

/** Longest piece taken from an address. */
const MAX_PIECE = 20;

/** What decides a program's device id. */
export interface IdSource {
  /** Program type as stored. */
  type: string;
  /** Host name or IP address (local programs). */
  host: string;
  /** Port, 0 = the program's default. */
  port: number;
  /** My.JDownloader: the id the account lists for the JDownloader instance. */
  deviceId: string;
}

/**
 * @param type a program type
 * @returns the program part of the id — without the way the program is reached (`jdownloader` for both connections)
 */
export function programPart(type: string): string {
  const info = programInfo(type);
  if (info) {
    return info.family === "jdownloader" ? "jdownloader" : info.type;
  }
  return sanitize(type) || "program";
}

/**
 * The machine a local program runs on, as an id piece: the first label of a host name, an IP address with dashes, the
 * ioBroker host for the machine ioBroker itself runs on.
 *
 * @param host host name or IP address as typed
 * @param iobHost the name of the ioBroker host this instance runs on
 * @returns the piece, "" when the address gives none
 */
export function hostPiece(host: string, iobHost: string): string {
  const raw = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  let piece: string;
  if (raw === "localhost" || raw === "::1" || /^127\.\d+\.\d+\.\d+$/.test(raw)) {
    piece = sanitize(iobHost) || "localhost";
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(raw) || raw.includes(":")) {
    piece = sanitize(raw);
  } else {
    piece = sanitize(raw.split(".")[0]);
  }
  return piece.slice(0, MAX_PIECE).replace(/-+$/, "");
}

/**
 * @param deviceId the id My.JDownloader lists
 * @returns its letters and digits, lower case
 */
function cloudPiece(deviceId: string): string {
  return deviceId.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * @param base the id to count on
 * @param free whether an id is still free
 * @returns the base with the first free counter, from `-2` on
 */
function counted(base: string, free: (id: string) => boolean): string {
  for (let n = 2; ; n++) {
    if (free(`${base}-${n}`)) {
      return `${base}-${n}`;
    }
  }
}

/**
 * The device id of a new program. My.JDownloader: the last four characters of the account's id for the instance, on a
 * clash the whole id, then a counter. A local program: the machine it runs on, on a clash with the port, then a
 * counter — none of the programs reports a number of its own.
 *
 * @param src the row's type, address and My.JDownloader id
 * @param taken device ids other rows hold
 * @param iobHost the name of the ioBroker host this instance runs on
 * @returns the id, undefined for My.JDownloader while the instance's id is not known yet
 */
export function deviceIdFor(src: IdSource, taken: ReadonlySet<string>, iobHost: string): string | undefined {
  const free = (id: string): boolean => !taken.has(id) && !RESERVED_IDS.has(id);
  const prog = programPart(src.type);
  const info = programInfo(src.type);
  if (info?.login === "account") {
    const piece = cloudPiece(src.deviceId);
    if (!piece) {
      return undefined;
    }
    const candidates = [`${prog}-${piece.slice(-4)}`, `${prog}-${piece}`];
    return candidates.find(free) ?? counted(candidates[1], free);
  }
  const piece = hostPiece(src.host, iobHost) || "device";
  const port = src.port > 0 ? src.port : (info?.port ?? 0);
  const candidates = [`${prog}-${piece}`, port > 0 ? `${prog}-${piece}-${port}` : `${prog}-${piece}`];
  return candidates.find(free) ?? counted(candidates[1], free);
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * @param row a stored program row
 * @returns what decides its device id
 */
export function idSourceOf(row: Record<string, unknown>): IdSource {
  const port = typeof row.port === "number" && Number.isInteger(row.port) && row.port > 0 ? row.port : 0;
  return { type: text(row.type), host: text(row.host), port, deviceId: text(row.deviceId) };
}

/**
 * Gives every row its device id: a row from before 0.3.0 (no `id`) gets one by the scheme and names the move of its
 * device; a My.JDownloader row whose instance id is not known yet keeps its old id, marked `idPending`, until the
 * account names the id. A row that has its id keeps it.
 *
 * @param rows the stored rows
 * @param iobHost the name of the ioBroker host this instance runs on
 * @param legacyId the device id a row had up to 0.2.0
 * @returns the rows with their ids, and old device id → new device id of each device to move
 */
export function settleIds(
  rows: readonly Record<string, unknown>[],
  iobHost: string,
  legacyId: (row: Record<string, unknown>) => string,
): { rows: Record<string, unknown>[]; moves: Map<string, string> } {
  const open = (r: Record<string, unknown>): boolean => typeof r.id !== "string" || !r.id || r.idPending === true;
  // every id in use now — a stored one, or the old id of a device still to move
  const taken = new Set(rows.map(r => (open(r) && !text(r.id) ? legacyId(r) : text(r.id))));
  const moves = new Map<string, string>();
  const out = rows.map(r => {
    if (!open(r)) {
      return r;
    }
    const oldId = text(r.id) || legacyId(r);
    // the row's own old id is no clash — its device may keep it
    const others = new Set([...taken].filter(id => id !== oldId));
    const fresh = deviceIdFor(idSourceOf(r), others, iobHost);
    const { idPending: _pending, key: _key, ...rest } = r;
    if (!fresh) {
      return { ...rest, id: oldId, idPending: true };
    }
    taken.add(fresh);
    if (fresh !== oldId) {
      moves.set(oldId, fresh);
    }
    return { ...rest, id: fresh };
  });
  return { rows: out, moves };
}
