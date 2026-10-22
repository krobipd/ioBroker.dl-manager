import type { Status } from "./model";

/**
 * A raw status the adapter does not know shows as queued, and a debug line names it so it can be added (design
 * decision 5, core decision K3).
 *
 * @param program the program, e.g. `qbittorrent`
 * @param raw the raw status as the program reported it
 * @param debug debug log
 * @returns queued
 */
export function unknownStatus(program: string, raw: unknown, debug: (msg: string) => void): Status {
  debug(`${program}: unknown status ${String(raw)} — shown as queued`);
  return "queued";
}

/**
 * @param table the program's status table — a Map, so an inherited name like `constructor` is no status
 * @param raw the raw status, written as the table's keys
 * @param program the program, e.g. `qbittorrent`
 * @param debug debug log
 * @returns the table's status, queued for a raw status the table does not hold
 */
export function statusFrom(
  table: ReadonlyMap<string, Status>,
  raw: string,
  program: string,
  debug: (msg: string) => void,
): Status {
  return table.get(raw) ?? unknownStatus(program, raw, debug);
}
