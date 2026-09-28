import { ACTIVE, type ProgramSnapshot } from "./model";
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

/**
 * The adapter-wide values over all configured programs. Only reachable programs count — an unreachable program's
 * last values are stale. Speeds are added in bytes per second and converted once.
 *
 * @param programs every enabled program, reachable or not
 * @returns value per datapoint id below the instance
 */
export function computeSummary(programs: readonly SummaryInput[]): Record<string, ioBroker.StateValue> {
  const online = programs.filter(p => p.online && p.snapshot);
  const items = online.flatMap(p => p.snapshot?.items ?? []);
  const active = items.filter(i => ACTIVE.has(i.status)).length;
  const pausable = online.filter(p => p.canPause);
  return {
    "info.connection": online.length > 0,
    "info.programsTotal": programs.length,
    "info.programsOnline": online.length,
    "info.programsAllOnline": programs.length > 0 && online.length === programs.length,
    "summary.downloading": active > 0,
    "summary.active": active,
    "summary.queued": items.filter(i => i.status === "queued").length,
    "summary.downloadSpeed": toMBps(sum(online.map(p => p.snapshot?.status.downloadBps))),
    "summary.uploadSpeed": toMBps(sum(online.map(p => p.snapshot?.status.uploadBps))),
    "summary.pauseAll": pausable.length > 0 && pausable.every(p => p.snapshot?.status.paused === true),
  };
}
