// Fleet master — the release run requires this file byte for byte in every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
/**
 * How an adapter removes an own object it no longer provides — the fleet's two deletion options (krobi 2026-11-17
 * 20:38–20:44, after a review found that a delete takes the user's recording settings with it and leaves the recorded
 * data without its datapoint). Every adapter carries both options in its settings, directly before the support block:
 * `deleteRecordedStates` (default on) lets a vanished datapoint go although a user records it, and
 * `deleteRecordedHistory` (default off, shown only while the first one is on) has every recording instance delete the
 * recorded data first. With the first option off, a datapoint with a recording stays, with every object above it; what
 * records nothing goes as before. A datapoint records while one entry of its `common.custom` is enabled — the form every
 * recording adapter writes and reads (history 5.2.0, sql 4.5.1 and influxdb 5.3.1, the stable versions of 2026-11-17).
 *
 * The recorded data goes through the message `deleteAll` (`[{ id }]`), which history, sql and influxdb answer with
 * `{ success: true }` once the data is gone. An instance that answers otherwise, or not within {@link ANSWER_MS}, keeps
 * its datapoints — nothing a user recorded goes without a word. The removal reads the objects it removes at the moment
 * it removes them: a user switches a recording on at any time, and a copy read at the start does not know it. Each
 * datapoint kept is named once per process, in one info line per pass ("Object tree updated: removed 3 datapoint(s),
 * kept 10 datapoint(s) with recording (history.0, influxdb.0) — please check them manually"), written when no removal
 * came for {@link REPORT_MS}; nothing newly kept, no line.
 *
 * A move is no removal: the datapoint lives on under its new id, and the old one goes through the delete the caller
 * hands to `moveWithEnums`/`moveAllWithEnums` (`enum-carry.ts`). Every other delete of an own object goes through
 * {@link removeObject} — the release run (consistency level 2) reports one beside it.
 *
 * Fleet master: `Entwicklung/.consistency-master/src/lib/object-removal.ts`. Every adapter carries this file and its test
 * byte for byte — the release run (consistency level 1) reports any difference. Change the master, then copy; never the
 * copy.
 */
import { errText } from "./err-text";

/** How long a recording instance may take to answer `deleteAll`. */
export const ANSWER_MS = 30_000;

/** A pass ends when no removal came for this long; then its one line is written. */
export const REPORT_MS = 2_000;

/** What the removal needs of the adapter — the adapter class itself. */
export interface RemovalAdapter {
  /** e.g. "demo.0" */
  readonly namespace: string;
  /** The instance settings, with the two deletion options. */
  readonly config: { deleteRecordedStates?: unknown; deleteRecordedHistory?: unknown };
  /** The adapter's logger. */
  readonly log: {
    /** A relevant event. */
    info(message: string): void;
    /** A routine line. */
    debug(message: string): void;
  };
  /** Reads the objects between two ids. */
  getObjectListAsync(params: {
    startkey: string;
    endkey: string;
  }): Promise<{ rows: Array<{ id: string; value: unknown }> }>;
  /** Deletes an object (with `recursive` its children too). */
  delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<unknown>;
  /** Sends a message to another instance and waits for its answer, at most `options.timeout` ms. */
  sendToAsync(instance: string, command: string, message: unknown, options: { timeout: number }): Promise<unknown>;
  /**
   * A timer the adapter clears when it stops; none while it stops. A property, not a method: the repository checker reads
   * a method signature `setTimeout(` as a bare timer call (S5005), and every adapter carries this file unchanged.
   */
  readonly setTimeout: (callback: () => void, ms: number) => ioBroker.Timeout | undefined;
  /** Clears a timer of {@link RemovalAdapter.setTimeout}. */
  readonly clearTimeout: (timer: ioBroker.Timeout | undefined) => void;
}

/** What one removal did. */
export interface Removal {
  /** The full ids of the objects it deleted. */
  removed: string[];
  /** The full ids of the objects it found and left: each datapoint with a recording and every object above it. */
  kept: string[];
}

/** The pass of one adapter: what it removed and kept since its last line, and what it named before. */
interface Pass {
  removed: number;
  kept: Map<string, string[]>;
  named: Set<string>;
  timer: ioBroker.Timeout | undefined;
}

const passes = new WeakMap<RemovalAdapter, Pass>();

/**
 * The instances that record a datapoint: every key of its `common.custom` whose entry is enabled.
 *
 * @param obj the object as the database holds it
 * @returns the instance names, sorted
 */
export function recordingsOf(obj: unknown): string[] {
  const custom = (obj as { common?: { custom?: unknown } } | null | undefined)?.common?.custom;
  if (!custom || typeof custom !== "object") {
    return [];
  }
  return Object.entries(custom as Record<string, unknown>)
    .filter(([, entry]) => Boolean((entry as { enabled?: unknown } | null)?.enabled))
    .map(([instance]) => instance)
    .sort();
}

/**
 * The objects a removal would take, each with the instances that record it.
 *
 * @param adapter the adapter
 * @param full the full id of the object
 * @param recursive whether the objects below it go as well
 * @returns full id → recording instances, in the order the database lists them
 */
async function objectsOf(adapter: RemovalAdapter, full: string, recursive: boolean): Promise<Map<string, string[]>> {
  const list = await adapter.getObjectListAsync({ startkey: full, endkey: `${full}.香` });
  const found = new Map<string, string[]>();
  for (const row of list.rows) {
    if (row.value && (row.id === full || (recursive && row.id.startsWith(`${full}.`)))) {
      found.set(row.id, recordingsOf(row.value));
    }
  }
  return found;
}

/**
 * Has every recording instance delete the recorded data of its datapoints, one message per instance.
 *
 * @param adapter the adapter
 * @param recorded full id → recording instances
 * @returns the full ids whose data an instance did not delete
 */
async function deleteRecordedData(adapter: RemovalAdapter, recorded: Map<string, string[]>): Promise<Set<string>> {
  const byInstance = new Map<string, string[]>();
  for (const [id, instances] of recorded) {
    for (const instance of instances) {
      byInstance.set(instance, [...(byInstance.get(instance) ?? []), id]);
    }
  }
  const failed = new Set<string>();
  for (const [instance, ids] of byInstance) {
    let problem: string;
    try {
      const answer = (await adapter.sendToAsync(
        instance,
        "deleteAll",
        ids.map(id => ({ id })),
        { timeout: ANSWER_MS },
      )) as { success?: unknown; error?: unknown } | null | undefined;
      if (answer?.success === true) {
        continue;
      }
      problem = typeof answer?.error === "string" ? answer.error : "no success in the answer";
    } catch (err) {
      problem = errText(err);
    }
    adapter.log.debug(`${instance} did not delete the recorded data of ${ids.length} datapoint(s): ${problem}`);
    ids.forEach(id => failed.add(id));
  }
  return failed;
}

/**
 * Writes the pass's line when something was newly kept, and starts the next pass.
 *
 * @param adapter the adapter
 * @param pass its pass
 */
function report(adapter: RemovalAdapter, pass: Pass): void {
  if (pass.kept.size > 0) {
    const instances = [...new Set([...pass.kept.values()].flat())].sort().join(", ");
    adapter.log.info(
      `Object tree updated: removed ${pass.removed} datapoint(s), kept ${pass.kept.size} datapoint(s) with recording ` +
        `(${instances}) — please check them manually`,
    );
  }
  pass.removed = 0;
  pass.kept = new Map();
  pass.timer = undefined;
}

/**
 * Counts one removal into the adapter's pass and moves the end of the pass behind it.
 *
 * @param adapter the adapter
 * @param removed how many objects the removal deleted
 * @param kept full id → recording instances of each datapoint it kept
 */
function count(adapter: RemovalAdapter, removed: number, kept: Map<string, string[]>): void {
  const pass = passes.get(adapter) ?? { removed: 0, kept: new Map(), named: new Set(), timer: undefined };
  passes.set(adapter, pass);
  pass.removed += removed;
  for (const [id, instances] of kept) {
    if (!pass.named.has(id)) {
      pass.named.add(id);
      pass.kept.set(id, instances);
    }
  }
  adapter.clearTimeout(pass.timer);
  pass.timer = adapter.setTimeout(() => report(adapter, pass), REPORT_MS);
  if (pass.timer === undefined) {
    report(adapter, pass);
  }
}

/**
 * Removes an own object that the adapter no longer provides, the way the user's two deletion options say: a datapoint
 * with a recording goes only while `deleteRecordedStates` is on, and with `deleteRecordedHistory` on only after every
 * recording instance deleted its data; a datapoint that stays keeps every object above it.
 *
 * @param adapter the adapter
 * @param id relative or full id
 * @param options delete the children too
 * @param options.recursive whether the children go as well
 * @returns what it deleted and what it left
 */
export async function removeObject(
  adapter: RemovalAdapter,
  id: string,
  options: { recursive: boolean } = { recursive: false },
): Promise<Removal> {
  const ns = `${adapter.namespace}.`;
  const full = id.startsWith(ns) ? id : `${ns}${id}`;
  const found = await objectsOf(adapter, full, options.recursive);
  const recorded = new Map([...found].filter(([, instances]) => instances.length > 0));
  let held = new Set<string>();
  if (adapter.config.deleteRecordedStates === false) {
    held = new Set(recorded.keys());
  } else if (adapter.config.deleteRecordedHistory === true) {
    held = await deleteRecordedData(adapter, recorded);
  }
  const kept = new Set<string>();
  for (const stays of held) {
    // the object itself and every one between it and the removed root
    const below = stays.slice(full.length + 1).split(".");
    below.forEach((_, depth) => kept.add([full, ...below.slice(0, depth)].join(".")));
    kept.add(stays);
  }
  const removed = [...found.keys()].filter(other => !kept.has(other));
  if (kept.size === 0 && removed.length > 0) {
    await adapter.delObjectAsync(id, options);
  } else {
    // deepest first: a channel goes after its states
    for (const other of [...removed].sort((a, b) => b.split(".").length - a.split(".").length)) {
      await adapter.delObjectAsync(other);
    }
  }
  count(adapter, removed.length, new Map([...recorded].filter(([other]) => held.has(other))));
  return { removed, kept: [...found.keys()].filter(other => kept.has(other)) };
}
