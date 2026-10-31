import { countActive, countQueued, type ProgramSnapshot } from "./model";
import { toMBps } from "./units";

/** What the summary needs from one configured program. */
export interface SummaryInput {
  /** The last poll succeeded. */
  online: boolean;
  /** The program has a global pause. */
  canPause: boolean;
  /** The last successful poll, null before the first one. */
  snapshot: ProgramSnapshot | null;
}

const sum = (values: (number | null | undefined)[]): number | null => {
  const known = values.filter((v): v is number => typeof v === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

/** The values that tell reachability — the only ones an outage changes (fleet suite "counterpart gone and back"). */
export const REACHABILITY_IDS = ["info.connection", "info.programsOnline", "info.programsAllOnline"] as const;

/**
 * The sums over the given polls. Speeds are added in bytes per second and converted once.
 *
 * @param read the programs whose last poll counts
 * @returns value per `summary.*` datapoint
 */
function sums(read: readonly SummaryInput[]): Record<string, ioBroker.StateValue> {
  const items = read.flatMap(p => p.snapshot?.items ?? []);
  const active = countActive(items);
  const pausable = read.filter(p => p.canPause);
  return {
    "summary.downloading": active > 0,
    "summary.active": active,
    "summary.queued": countQueued(items),
    "summary.downloadSpeed": toMBps(sum(read.map(p => p.snapshot?.status.downloadBps))),
    "summary.uploadSpeed": toMBps(sum(read.map(p => p.snapshot?.status.uploadBps))),
    "summary.pauseAll": pausable.length > 0 && pausable.every(p => p.snapshot?.status.paused === true),
  };
}

/**
 * The adapter-wide values over all configured programs. Reachability counts the programs whose last poll succeeded;
 * the sums count the last poll of every program, reachable or not — an outage shows only on reachability, the values
 * it read stay (krobi 2026-10-06 17:55). Without any poll the sums are left out — the start has set them (idleSummary).
 * A speed no program reported readably is left out too: an answer whose fields drifted keeps the last sum, only stop
 * and start set it to nothing (CLAUDE.md design decision 27, fleet suite C26b).
 *
 * @param programs every enabled program, reachable or not
 * @returns value per datapoint id below the instance
 */
export function computeSummary(programs: readonly SummaryInput[]): Record<string, ioBroker.StateValue> {
  const online = programs.filter(p => p.online && p.snapshot);
  const read = programs.filter(p => p.snapshot);
  return {
    "info.connection": online.length > 0,
    "info.programsTotal": programs.length,
    "info.programsOnline": online.length,
    "info.programsAllOnline": programs.length > 0 && online.length === programs.length,
    ...(read.length ? Object.fromEntries(Object.entries(sums(read)).filter(([, v]) => v !== null)) : {}),
  };
}

/**
 * Nothing asked yet, or nothing asked any more: no connection, and no sums that look current — at the stop and, for a
 * crash, at the start (final review M6; `.claude/rules/coding.md`: what the shutdown sets offline belongs on startup too).
 *
 * @param total the enabled programs
 * @returns value per datapoint id below the instance
 */
export function idleSummary(total: number): Record<string, ioBroker.StateValue> {
  return { ...computeSummary(Array(total).fill({ online: false, canPause: false, snapshot: null })), ...sums([]) };
}
