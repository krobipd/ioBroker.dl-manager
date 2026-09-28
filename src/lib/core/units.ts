const MB = 1_000_000;
const GB = 1_000_000_000;

const round2 = (v: number): number => Math.round(v * 100) / 100;
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
