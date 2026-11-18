// Fleet master — the release run requires this file byte for byte in every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
import { ANSWER_MS, recordingsOf, removeObject, REPORT_MS, type RemovalAdapter } from "./object-removal";

/** How the fake answers `deleteAll` per instance: an answer, a rejection, or nothing it understands. */
type Answers = Record<string, unknown>;

/**
 * An adapter over an object database in memory that writes every call it gets, in order, into `calls`; its timer runs
 * only when the test fires it.
 *
 * @param objects full id → object
 * @param config the two deletion options
 * @param answers what each recording instance answers to `deleteAll`; an Error rejects
 * @param timers whether the adapter hands out timers (false: it stops)
 * @returns the adapter, its calls, the database and a way to fire the pending timer
 */
function fakeAdapter(
  objects: Record<string, unknown>,
  config: RemovalAdapter["config"] = {},
  answers: Answers = {},
  timers = true,
): { adapter: RemovalAdapter; calls: string[]; db: Map<string, unknown>; fire: () => void } {
  const calls: string[] = [];
  const db = new Map<string, unknown>(Object.entries(objects));
  let pending: (() => void) | undefined;
  let next = 0;
  const adapter: RemovalAdapter = {
    namespace: "demo.0",
    config,
    log: {
      info: message => calls.push(`info ${message}`),
      debug: message => calls.push(`debug ${message}`),
    },
    getObjectListAsync: params => {
      calls.push(`list ${params.startkey} ${params.endkey}`);
      // the database answers every id between the keys — a sibling with a longer name sorts in there too
      const rows = [...db]
        .filter(([id]) => id >= params.startkey && id <= params.endkey)
        .map(([id, value]) => ({ id, value: structuredClone(value) }));
      return Promise.resolve({ rows });
    },
    delObjectAsync: (id, options) => {
      calls.push(`del ${id}${options?.recursive ? " recursive" : ""}`);
      const key = id.startsWith("demo.0.") ? id : `demo.0.${id}`;
      for (const known of [...db.keys()]) {
        if (known === key || (options?.recursive && known.startsWith(`${key}.`))) {
          db.delete(known);
        }
      }
      return Promise.resolve();
    },
    sendToAsync: (instance, command, message, options) => {
      calls.push(`send ${instance} ${command} ${JSON.stringify(message)} ${options.timeout}`);
      const answer = answers[instance];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    setTimeout: (callback, ms) => {
      if (!timers) {
        return undefined;
      }
      next++;
      calls.push(`timer ${next} ${ms}`);
      pending = callback;
      return next as unknown as ioBroker.Timeout;
    },
    clearTimeout: timer => {
      if (timer !== undefined) {
        calls.push(`clear ${String(timer)}`);
      }
    },
  };
  const fire = (): void => {
    const run = pending;
    pending = undefined;
    run?.();
  };
  return { adapter, calls, db, fire };
}

const recorded = (...instances: string[]): unknown => ({
  type: "state",
  common: { name: "x", custom: Object.fromEntries(instances.map(i => [i, { enabled: true, retention: 0 }])) },
});
const plain = { type: "state", common: { name: "x" } };
const device = { type: "device", common: { name: "Dev" } };
const channel = { type: "channel", common: { name: "Ch" } };

/**
 * A device with a channel, a recorded datapoint and a plain one, and a sibling whose id starts with the same text.
 *
 * @param record the object of the recorded datapoint
 * @returns full id → object
 */
const tree = (record: unknown): Record<string, unknown> => ({
  "demo.0.dev": device,
  "demo.0.dev.ch": channel,
  "demo.0.dev.ch.power": record,
  "demo.0.dev.ch.name": plain,
  "demo.0.dev.on": plain,
  "demo.0.dev-2": device,
  "demo.0.dev2": device,
});

const actions = (calls: string[]): string[] => calls.filter(c => !c.startsWith("list") && !c.startsWith("timer"));

describe("recordingsOf — the instances whose recording is switched on", () => {
  it("names every enabled entry of common.custom, sorted", () => {
    expect(recordingsOf(recorded("influxdb.0", "history.0"))).toEqual(["history.0", "influxdb.0"]);
  });

  it("leaves out a switched-off entry, an empty one and a value that is no entry", () => {
    const custom = {
      "history.0": { enabled: false },
      "sql.0": null,
      "influxdb.0": true,
      "history.1": { enabled: true },
    };
    expect(recordingsOf({ common: { custom } })).toEqual(["history.1"]);
  });

  it("finds none without custom, without common or without an object", () => {
    expect(recordingsOf(plain)).toEqual([]);
    expect(recordingsOf({ common: { custom: "history.0" } })).toEqual([]);
    expect(recordingsOf({ type: "state" })).toEqual([]);
    expect(recordingsOf(null)).toEqual([]);
    expect(recordingsOf(undefined)).toEqual([]);
  });
});

describe("removeObject — the two deletion options", () => {
  it("with the defaults deletes a recorded datapoint with its device in one call, the data stays", async () => {
    const { adapter, calls, db, fire } = fakeAdapter(tree(recorded("history.0")));
    const removal = await removeObject(adapter, "dev", { recursive: true });
    expect(removal).toEqual({
      removed: ["demo.0.dev", "demo.0.dev.ch", "demo.0.dev.ch.power", "demo.0.dev.ch.name", "demo.0.dev.on"],
      kept: [],
    });
    expect(actions(calls)).toEqual(["del dev recursive"]);
    expect(calls[0]).toBe("list demo.0.dev demo.0.dev.香");
    expect([...db.keys()]).toEqual(["demo.0.dev-2", "demo.0.dev2"]);
    fire();
    expect(calls.filter(c => c.startsWith("info"))).toEqual([]);
  });

  it("with deleteRecordedStates off keeps the recorded datapoint and every object above it, the rest goes deepest first", async () => {
    const { adapter, calls, db, fire } = fakeAdapter(tree(recorded("history.0", "influxdb.0")), {
      deleteRecordedStates: false,
      deleteRecordedHistory: true,
    });
    const removal = await removeObject(adapter, "demo.0.dev", { recursive: true });
    expect(removal).toEqual({
      removed: ["demo.0.dev.ch.name", "demo.0.dev.on"],
      kept: ["demo.0.dev", "demo.0.dev.ch", "demo.0.dev.ch.power"],
    });
    expect(actions(calls)).toEqual(["del demo.0.dev.ch.name", "del demo.0.dev.on"]);
    expect(db.has("demo.0.dev.ch.power")).toBe(true);
    fire();
    expect(calls.filter(c => c.startsWith("info"))).toEqual([
      "info Object tree updated: removed 2 datapoint(s), kept 1 datapoint(s) with recording (history.0, influxdb.0) " +
        "— please check them manually",
    ]);
  });

  it("keeps a single recorded datapoint with deleteRecordedStates off and deletes a plain one beside it", async () => {
    const { adapter, calls, db } = fakeAdapter(tree(recorded("history.0")), { deleteRecordedStates: false });
    expect(await removeObject(adapter, "dev.ch.power")).toEqual({ removed: [], kept: ["demo.0.dev.ch.power"] });
    expect(await removeObject(adapter, "dev.ch.name")).toEqual({ removed: ["demo.0.dev.ch.name"], kept: [] });
    expect(actions(calls)).toEqual(["del dev.ch.name", "clear 1"]);
    expect(db.has("demo.0.dev.ch.power")).toBe(true);
  });

  it("with deleteRecordedHistory on has each recording instance delete the data first, one message per instance", async () => {
    const answers = { "history.0": { success: true }, "influxdb.0": { success: true, connection: true } };
    const objects = { ...tree(recorded("history.0", "influxdb.0")), "demo.0.dev.on": recorded("history.0") };
    const { adapter, calls, db, fire } = fakeAdapter(objects, { deleteRecordedHistory: true }, answers);
    const removal = await removeObject(adapter, "dev", { recursive: true });
    expect(removal.kept).toEqual([]);
    expect(actions(calls)).toEqual([
      `send history.0 deleteAll [{"id":"demo.0.dev.ch.power"},{"id":"demo.0.dev.on"}] ${ANSWER_MS}`,
      `send influxdb.0 deleteAll [{"id":"demo.0.dev.ch.power"}] ${ANSWER_MS}`,
      "del dev recursive",
    ]);
    expect(db.has("demo.0.dev")).toBe(false);
    fire();
    expect(calls.filter(c => c.startsWith("info"))).toEqual([]);
  });

  it("keeps the datapoints whose data an instance did not delete, and says why in a debug line", async () => {
    const answers = {
      "history.0": { success: false, error: "database is locked" },
      "sql.0": new Error("timeout"),
      "influxdb.0": { error: 42 },
    };
    const objects = {
      "demo.0.a": recorded("history.0"),
      "demo.0.a.b": recorded("sql.0"),
      "demo.0.a.c": recorded("influxdb.0"),
      "demo.0.a.d": recorded("history.1"),
    };
    const { adapter, calls, fire } = fakeAdapter(
      objects,
      { deleteRecordedStates: true, deleteRecordedHistory: true },
      { ...answers, "history.1": { success: true } },
    );
    const removal = await removeObject(adapter, "a", { recursive: true });
    expect(removal).toEqual({ removed: ["demo.0.a.d"], kept: ["demo.0.a", "demo.0.a.b", "demo.0.a.c"] });
    expect(calls.filter(c => c.startsWith("debug"))).toEqual([
      "debug history.0 did not delete the recorded data of 1 datapoint(s): database is locked",
      "debug sql.0 did not delete the recorded data of 1 datapoint(s): timeout",
      "debug influxdb.0 did not delete the recorded data of 1 datapoint(s): no success in the answer",
    ]);
    expect(calls.filter(c => c.startsWith("del"))).toEqual(["del demo.0.a.d"]);
    fire();
    expect(calls.filter(c => c.startsWith("info"))).toEqual([
      "info Object tree updated: removed 1 datapoint(s), kept 3 datapoint(s) with recording (history.0, influxdb.0, " +
        "sql.0) — please check them manually",
    ]);
  });

  it("an instance without any answer keeps its datapoint too", async () => {
    const { adapter, calls } = fakeAdapter({ "demo.0.x": recorded("statistics.0") }, { deleteRecordedHistory: true });
    expect(await removeObject(adapter, "x")).toEqual({ removed: [], kept: ["demo.0.x"] });
    expect(calls.filter(c => c.startsWith("debug"))).toEqual([
      "debug statistics.0 did not delete the recorded data of 1 datapoint(s): no success in the answer",
    ]);
  });
});

describe("removeObject — what it reads and what it leaves alone", () => {
  it("without recursive takes only the object itself and leaves its children", async () => {
    const { adapter, calls, db } = fakeAdapter(tree(recorded("history.0")), { deleteRecordedStates: false });
    expect(await removeObject(adapter, "dev")).toEqual({ removed: ["demo.0.dev"], kept: [] });
    expect(actions(calls)).toEqual(["del dev"]);
    expect(db.has("demo.0.dev.ch.power")).toBe(true);
  });

  it("deletes nothing and sends nothing when nothing is there, and skips a row without an object", async () => {
    const { adapter, calls } = fakeAdapter({ "demo.0.gone": null, "demo.0.gone.child": plain });
    expect(await removeObject(adapter, "missing", { recursive: true })).toEqual({ removed: [], kept: [] });
    expect(await removeObject(adapter, "gone")).toEqual({ removed: [], kept: [] });
    expect(calls.filter(c => c.startsWith("del") || c.startsWith("send"))).toEqual([]);
  });

  it("deletes what goes deepest first: a channel after its datapoints", async () => {
    const objects = {
      "demo.0.d": device,
      "demo.0.d.x": channel,
      "demo.0.d.x.y": plain,
      "demo.0.d.r": recorded("history.0"),
    };
    const { adapter, calls } = fakeAdapter(objects, { deleteRecordedStates: false });
    expect(await removeObject(adapter, "d", { recursive: true })).toEqual({
      removed: ["demo.0.d.x", "demo.0.d.x.y"],
      kept: ["demo.0.d", "demo.0.d.r"],
    });
    expect(calls.filter(c => c.startsWith("del"))).toEqual(["del demo.0.d.x.y", "del demo.0.d.x"]);
  });

  it("deletes the children of a root that has no object of its own in one recursive call", async () => {
    const { adapter, calls, db } = fakeAdapter({ "demo.0.gone": null, "demo.0.gone.child": plain });
    expect(await removeObject(adapter, "gone", { recursive: true })).toEqual({
      removed: ["demo.0.gone.child"],
      kept: [],
    });
    expect(actions(calls)).toEqual(["del gone recursive"]);
    expect(db.has("demo.0.gone.child")).toBe(false);
  });
});

describe("removeObject — one line per pass", () => {
  it("counts every removal of a pass into its one line, written when the pass ends", async () => {
    const { adapter, calls, fire } = fakeAdapter(
      { ...tree(recorded("history.0")), "demo.0.other": recorded("sql.0"), "demo.0.loose": plain },
      { deleteRecordedStates: false },
    );
    await removeObject(adapter, "dev", { recursive: true });
    await removeObject(adapter, "loose");
    await removeObject(adapter, "other");
    expect(calls.filter(c => c.startsWith("timer") || c.startsWith("clear"))).toEqual([
      `timer 1 ${REPORT_MS}`,
      "clear 1",
      `timer 2 ${REPORT_MS}`,
      "clear 2",
      `timer 3 ${REPORT_MS}`,
    ]);
    expect(calls.filter(c => c.startsWith("info"))).toEqual([]);
    fire();
    expect(calls.filter(c => c.startsWith("info"))).toEqual([
      "info Object tree updated: removed 3 datapoint(s), kept 2 datapoint(s) with recording (history.0, sql.0) " +
        "— please check them manually",
    ]);
  });

  it("names a kept datapoint once per process: the next pass that keeps it again stays silent", async () => {
    const { adapter, calls, fire } = fakeAdapter(tree(recorded("history.0")), { deleteRecordedStates: false });
    await removeObject(adapter, "dev", { recursive: true });
    fire();
    await removeObject(adapter, "dev", { recursive: true });
    fire();
    expect(calls.filter(c => c.startsWith("info"))).toHaveLength(1);
  });

  it("writes the line at once while the adapter stops and hands out no timer", async () => {
    const { adapter, calls } = fakeAdapter(tree(recorded("history.0")), { deleteRecordedStates: false }, {}, false);
    await removeObject(adapter, "dev", { recursive: true });
    expect(calls.filter(c => c.startsWith("info"))).toEqual([
      "info Object tree updated: removed 2 datapoint(s), kept 1 datapoint(s) with recording (history.0) " +
        "— please check them manually",
    ]);
  });

  it("the limits are the fleet's", () => {
    expect(ANSWER_MS).toBe(30_000);
    expect(REPORT_MS).toBe(2_000);
  });
});
