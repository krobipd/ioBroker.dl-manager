import { FakeAdapter } from "../../../test/helpers/fake-adapter";
import { ID_SCHEME } from "./device-id";
import { keepHistoryUnder, moveObjects, type MoveAdapter } from "./move";

const NS = "dl-manager.0";
const OLD = `${NS}.transmission`;
const NEW = `${NS}.transmission-nas`;

/**
 * The fake adapter as a move sees it — values keep their `ts`, `lc` and `q` like the real database does.
 *
 * @param a the fake
 * @returns the move's access, and the deletes in order
 */
function mover(a: FakeAdapter): { m: MoveAdapter; deleted: string[] } {
  const deleted: string[] = [];
  const m: MoveAdapter = {
    namespace: NS,
    log: a.log,
    getObjectList: p => a.getObjectList(p),
    getForeignObjects: (p, t) => a.getForeignObjects(p, t),
    getForeignObjectAsync: id => a.getForeignObjectAsync(id),
    setForeignObject: (id, obj) => a.setForeignObject(id, obj),
    extendForeignObject: (id, patch) => a.extendObject(id, patch),
    getForeignStates: p =>
      Promise.resolve(
        Object.fromEntries(
          [...a.states].filter(([id]) => (p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : id === p)),
        ),
      ),
    setForeignState: (id, st) => {
      a.states.set(id, structuredClone(st) as ioBroker.State);
      return Promise.resolve();
    },
    delForeignObject: id => {
      deleted.push(id);
      a.objects.delete(id);
      a.states.delete(id);
      return Promise.resolve();
    },
  };
  return { m, deleted };
}

const state = (common: Record<string, unknown> = {}): ioBroker.SettableObject => ({
  type: "state",
  common: { name: "x", type: "string", role: "text", read: true, write: false, ...common },
  native: {},
});

async function oldTree(a: FakeAdapter): Promise<void> {
  await a.setForeignObject(OLD, { type: "device", common: { name: "T" }, native: { type: "transmission" } });
  await a.setForeignObject(`${OLD}.online`, state());
  await a.setForeignObject(`${OLD}.paused`, {
    ...state(),
    native: { emulatedPause: { paused: true, keys: ["k1"] } },
  } as ioBroker.SettableObject);
  await a.setForeignObject(`${OLD}.downloads`, { type: "folder", common: { name: "d" }, native: {} });
  await a.setForeignObject(`${OLD}.downloads.k1`, { type: "channel", common: { name: "k1" }, native: { key: "k1" } });
  await a.setForeignObject(
    `${OLD}.downloads.k1.status`,
    state({ custom: { "history.0": { enabled: true }, "sql.0": { enabled: false } } }),
  );
  a.states.set(`${OLD}.online`, { val: true, ack: true, ts: 111, lc: 100, q: 0, from: "x" });
  a.states.set(`${OLD}.downloads.k1.status`, {
    val: "seeding",
    ack: true,
    ts: 222,
    lc: 200,
    q: 1,
    from: "x",
  });
  // a similar id next to it — never part of the move
  await a.setForeignObject(`${NS}.transmission-2`, { type: "device", common: { name: "2" }, native: {} });
}

describe("moveObjects — a device", () => {
  it("moves every object with its native, every value with ack/ts/lc/q, and marks the new device", async () => {
    const a = new FakeAdapter(NS);
    await oldTree(a);
    const { m } = mover(a);
    const r = await moveObjects(m, [[OLD, NEW]], { device: true });
    expect([...a.objects.keys()].filter(id => id.startsWith(`${OLD}.`) || id === OLD)).toEqual([]);
    expect(a.objects.has(`${NS}.transmission-2`)).toBe(true);
    expect(a.objects.get(NEW)?.native).toEqual({ type: "transmission", idScheme: ID_SCHEME });
    expect(a.objects.get(`${NEW}.paused`)?.native).toEqual({ emulatedPause: { paused: true, keys: ["k1"] } });
    expect(a.states.get(`${NEW}.downloads.k1.status`)).toMatchObject({
      val: "seeding",
      ack: true,
      ts: 222,
      lc: 200,
      q: 1,
    });
    expect(a.states.get(`${NEW}.online`)).toMatchObject({ val: true, ts: 111, lc: 100 });
    expect(r.objects).toBe(6);
  });

  it("keeps a recording with its datapoint and its history under the old id — an inactive one stays as it is", async () => {
    const a = new FakeAdapter(NS);
    await oldTree(a);
    const r = await moveObjects(mover(a).m, [[OLD, NEW]], { device: true });
    expect(a.objects.get(`${NEW}.downloads.k1.status`)?.common.custom).toEqual({
      "history.0": { enabled: true, aliasId: `${OLD}.downloads.k1.status` },
      "sql.0": { enabled: false },
    });
    expect(r.recordings).toBe(1);
  });

  it("carries rooms and functions once, and points aliases at the new ids", async () => {
    const a = new FakeAdapter(NS);
    await oldTree(a);
    await a.setForeignObject("enum.rooms.office", {
      type: "enum",
      common: { name: "Office", members: [OLD, `${OLD}.online`, "other.0.x"] },
      native: {},
    });
    await a.setForeignObject("alias.0.online", {
      ...state({ alias: { id: `${OLD}.online` } }),
    });
    await a.setForeignObject("alias.0.pair", {
      ...state({ alias: { id: { read: `${OLD}.online`, write: "other.0.y" } } }),
    });
    await a.setForeignObject("alias.0.foreign", {
      ...state({ alias: { id: "other.0.z" } }),
    });
    const r = await moveObjects(mover(a).m, [[OLD, NEW]], { device: true });
    expect((a.objects.get("enum.rooms.office")?.common as { members: string[] }).members.sort()).toEqual(
      ["other.0.x", NEW, `${NEW}.online`].sort(),
    );
    expect((a.objects.get("alias.0.online")?.common as { alias: unknown }).alias).toEqual({ id: `${NEW}.online` });
    expect((a.objects.get("alias.0.pair")?.common as { alias: unknown }).alias).toEqual({
      id: { read: `${NEW}.online`, write: "other.0.y" },
    });
    expect((a.objects.get("alias.0.foreign")?.common as { alias: unknown }).alias).toEqual({ id: "other.0.z" });
    expect(r.enums).toBe(2);
    expect(r.aliases).toBe(2);
  });

  it("deletes the children first and the old device with its journal last", async () => {
    const a = new FakeAdapter(NS);
    await oldTree(a);
    const { m, deleted } = mover(a);
    await moveObjects(m, [[OLD, NEW]], { device: true });
    expect(deleted.at(-1)).toBe(OLD);
    expect(deleted.indexOf(`${OLD}.downloads.k1.status`)).toBeLessThan(deleted.indexOf(`${OLD}.downloads.k1`));
  });

  it("copies anew after a stop before the copy was complete — the journal stays on the old device only", async () => {
    const a = new FakeAdapter(NS);
    await oldTree(a);
    await a.extendObject(OLD, { native: { movingTo: NEW } });
    await moveObjects(mover(a).m, [[OLD, NEW]], { device: true });
    expect(a.objects.get(NEW)?.native).toEqual({ type: "transmission", idScheme: ID_SCHEME });
    expect(a.objects.has(OLD)).toBe(false);
  });

  it("finishes a move a stop interrupted: the copy is complete, only aliases and the delete are left", async () => {
    const a = new FakeAdapter(NS);
    await oldTree(a);
    const { m } = mover(a);
    // the first run stopped after the copy and the mark
    await a.extendObject(OLD, { native: { movingTo: NEW } });
    await a.setForeignObject(NEW, { type: "device", common: { name: "T" }, native: { idScheme: ID_SCHEME } });
    await a.setForeignObject(`${NEW}.online`, state());
    // older than the old value: only the finished copy keeps the value from being written again
    a.states.set(`${NEW}.online`, { val: false, ack: true, ts: 50, lc: 50, q: 0, from: "x" });
    a.objectLog.length = 0;
    const r = await moveObjects(m, [[OLD, NEW]], { device: true });
    expect(r.objects).toBe(0);
    expect(a.states.get(`${NEW}.online`)?.val).toBe(false);
    expect(a.objects.has(OLD)).toBe(false);
    expect(a.objects.has(`${NEW}.downloads.k1`)).toBe(false);
  });

  it("writes the journal on the old device before it copies anything", async () => {
    const a = new FakeAdapter(NS);
    await oldTree(a);
    a.objectLog.length = 0;
    await moveObjects(mover(a).m, [[OLD, NEW]], { device: true });
    expect(a.objectLog[0]).toBe(OLD);
  });

  it("moves nothing when there is nothing to move", async () => {
    const a = new FakeAdapter(NS);
    expect(await moveObjects(mover(a).m, [[OLD, NEW]], { device: true })).toEqual({
      objects: 0,
      enums: 0,
      aliases: 0,
      recordings: 0,
    });
    expect(a.objectWrites).toBe(0);
  });
});

describe("moveObjects — single datapoints", () => {
  it("renames a datapoint into another channel, value, recording and room with it, without a journal", async () => {
    const a = new FakeAdapter(NS);
    await a.setForeignObject(`${NS}.dev.lastFinished`, state({ custom: { "history.0": { enabled: true } } }));
    a.states.set(`${NS}.dev.lastFinished`, {
      val: "a.mkv",
      ack: true,
      ts: 5,
      lc: 5,
      q: 0,
      from: "x",
    });
    await a.setForeignObject("enum.functions.media", {
      type: "enum",
      common: { name: "M", members: [`${NS}.dev.lastFinished`] },
      native: {},
    });
    await moveObjects(mover(a).m, [[`${NS}.dev.lastFinished`, `${NS}.dev.last.finished`]]);
    expect(a.objects.has(`${NS}.dev.lastFinished`)).toBe(false);
    expect(a.objects.get(`${NS}.dev.last.finished`)?.common.custom).toEqual({
      "history.0": { enabled: true, aliasId: `${NS}.dev.lastFinished` },
    });
    expect(a.objects.get(`${NS}.dev.last.finished`)?.native).toEqual({});
    expect(a.states.get(`${NS}.dev.last.finished`)?.val).toBe("a.mkv");
    expect((a.objects.get("enum.functions.media")?.common as { members: string[] }).members).toEqual([
      `${NS}.dev.last.finished`,
    ]);
  });

  it("hands a manifest datapoint that exists already the value and a recording it lacks — never an older value", async () => {
    const a = new FakeAdapter(NS);
    await a.setForeignObject(`${NS}.summary.lastFailed`, state({ custom: { "history.0": { enabled: true } } }));
    a.states.set(`${NS}.summary.lastFailed`, {
      val: "old",
      ack: true,
      ts: 50,
      lc: 50,
      q: 0,
      from: "x",
    });
    await a.setForeignObject(`${NS}.summary.last.failed`, state({ name: "manifest" }));
    a.states.set(`${NS}.summary.last.failed`, {
      val: "",
      ack: true,
      ts: 10,
      lc: 10,
      q: 0,
      from: "x",
    });
    await a.setForeignObject(`${NS}.summary.lastFailedTime`, state());
    a.states.set(`${NS}.summary.lastFailedTime`, {
      val: 1,
      ack: true,
      ts: 50,
      lc: 50,
      q: 0,
      from: "x",
    });
    await a.setForeignObject(`${NS}.summary.last.failedTime`, state());
    a.states.set(`${NS}.summary.last.failedTime`, {
      val: 2,
      ack: true,
      ts: 60,
      lc: 60,
      q: 0,
      from: "x",
    });
    await moveObjects(mover(a).m, [
      [`${NS}.summary.lastFailed`, `${NS}.summary.last.failed`],
      [`${NS}.summary.lastFailedTime`, `${NS}.summary.last.failedTime`],
    ]);
    expect(a.objects.get(`${NS}.summary.last.failed`)?.common).toMatchObject({
      name: "manifest",
      custom: { "history.0": { enabled: true, aliasId: `${NS}.summary.lastFailed` } },
    });
    expect(a.states.get(`${NS}.summary.last.failed`)?.val).toBe("old");
    expect(a.states.get(`${NS}.summary.last.failedTime`)?.val).toBe(2);
    expect(a.objects.has(`${NS}.summary.lastFailed`)).toBe(false);
  });
});

describe("keepHistoryUnder", () => {
  it("gives an active recording without aliasId the old id and leaves the others", () => {
    expect(
      keepHistoryUnder(
        { "history.0": { enabled: true }, "influxdb.0": { enabled: true, aliasId: "keep" }, "sql.0": null },
        "old.id",
      ),
    ).toEqual({
      custom: {
        "history.0": { enabled: true, aliasId: "old.id" },
        "influxdb.0": { enabled: true, aliasId: "keep" },
        "sql.0": null,
      },
      kept: 1,
    });
  });
});
