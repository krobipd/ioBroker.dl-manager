const MB = 1_000_000;
const GB = 1_000_000_000;

/**
 * @param v a number
 * @returns it rounded to two decimals
 */
export const round2 = (v: number): number => Math.round(v * 100) / 100;
const isNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Bytes per second → MB/s with two decimals (the fleet unit, like beszel).
 *
 * @param bps bytes per second as the program reports them
 * @returns MB/s, or null when the value is not a finite number ≥ 0
 */
export function toMBps(bps: unknown): number | null {
  return isNonNegative(bps) ? round2(bps / MB) : null;
}

/**
 * Bytes → GB with two decimals.
 *
 * @param bytes a size in bytes
 * @returns GB, or null when the value is not a finite number ≥ 0
 */
export function toGB(bytes: unknown): number | null {
  return isNonNegative(bytes) ? round2(bytes / GB) : null;
}

/**
 * MB/s from a datapoint → bytes per second for a program. Everything that is not a positive number means
 * "unlimited", which every program writes as 0.
 *
 * @param mbps the value a user wrote
 * @returns bytes per second, 0 = unlimited
 */
export function fromMBps(mbps: unknown): number {
  return typeof mbps === "number" && Number.isFinite(mbps) && mbps > 0 ? Math.round(mbps * MB) : 0;
}

/**
 * Bytes per second → a limit in the program's KiB/s. A set limit stays at least 1 — 0 would switch it off.
 *
 * @param bps a positive limit in bytes per second
 * @param unit bytes per KiB of the program (1024, or 1000 where the program says so)
 * @returns the limit in the program's unit
 */
export function toKiB(bps: number, unit = 1024): number {
  return Math.max(1, Math.round(bps / unit));
}

/**
 * A limit in the program's KiB/s → bytes per second.
 *
 * @param v the program's value
 * @param unit bytes per KiB of the program (1024, or 1000 where the program says so)
 * @returns bytes per second, 0 = no limit (also for 0 or a negative value)
 */
export function fromKiB(v: unknown, unit = 1024): number {
  const n = num(v);
  return n !== null && n > 0 ? Math.round(n * unit) : 0;
}

/**
 * Progress in percent with one decimal, capped at 100.
 *
 * @param done bytes done
 * @param size total bytes
 * @returns percent, or null while the size is unknown or 0
 */
export function percent(done: number | null, size: number | null): number | null {
  if (done === null || size === null || size <= 0) {
    return null;
  }
  return Math.min(100, Math.round((done / size) * 1000) / 10);
}

/**
 * Seconds left, rounded. The programs' own "unknown" markers (qBittorrent 8640000, Transmission -1/-2, Deluge 0/-1)
 * become null.
 *
 * @param seconds the raw value
 * @param sentinels the values this program uses for "unknown"
 * @returns seconds, or null
 */
export function eta(seconds: unknown, sentinels: readonly number[]): number | null {
  if (!isNonNegative(seconds) || sentinels.includes(seconds)) {
    return null;
  }
  return Math.round(seconds);
}

/**
 * A number from a program that may send numbers as strings (SABnzbd, aria2).
 *
 * @param v the raw value
 * @returns the number, or null for anything that is not a finite number
 */
export function num(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v !== "string" || v.trim() === "") {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * NZBGet sends 64-bit values as two unsigned 32-bit halves.
 *
 * @param hi the high half
 * @param lo the low half
 * @returns the joined value, or null when a half is missing
 */
export function hiLo(hi: unknown, lo: unknown): number | null {
  const h = num(hi);
  const l = num(lo);
  return h === null || l === null ? null : h * 2 ** 32 + l;
}

/**
 * @param v a part of a program's answer
 * @returns it as an object, {} when it is none (API boundary)
 */
export const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * @param v a list in a program's answer
 * @returns its entries as objects, [] when it is none
 */
export const asRecords = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(asRecord) : []);

/**
 * @param v a text in a program's answer
 * @returns it, "" when it is none
 */
export const asText = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * @param v a count, size or rate in a program's answer (a string of digits too)
 * @returns the number, null when it is none or negative (a program's "unknown")
 */
export function nonNegative(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
}

/**
 * @param v a point in time in seconds since 1970, as the programs send it
 * @returns milliseconds, null for none or 0 (the programs' "not yet")
 */
export function epochMs(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n * 1000 : null;
}

/**
 * @param size the download's size in bytes
 * @param left the bytes still to load
 * @returns the bytes loaded, null when either is unknown
 */
export function doneOf(size: number | null, left: number | null): number | null {
  return size !== null && left !== null ? Math.max(0, size - left) : null;
}
