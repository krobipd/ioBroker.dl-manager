// Fleet master — the release run requires this file byte for byte in every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
import { FAKE_SEALED, FakeAdapter, FakeTermination } from "./adapter-fake";
import { KnownObjects } from "./known-objects";
import { removeObject, REPORT_MS } from "./object-removal";
import { failStart, SETTINGS_CATEGORY, SettingsError } from "./start-failure";

/**
 * A state object.
 *
 * @param common more of its `common`
 * @returns the object
 */
function state(common: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "state", common: { name: "x", ...common }, native: {} };
}

/** A state a user records with history.0. */
const recorded = state({ custom: { "history.0": { enabled: true } } });

/**
 * The `common` of an object the fake holds.
 *
 * @param fake the adapter
 * @param id the full id
 * @returns its common
 */
function commonOf(fake: FakeAdapter, id: string): Record<string, unknown> | undefined {
  return fake.objects.get(id)?.common as Record<string, unknown> | undefined;
}

describe("FakeAdapter — start", () => {
  it("takes the namespace from the name, or as given, and copies the settings", () => {
    expect(new FakeAdapter().namespace).toBe("demo.0");
    const named = new FakeAdapter({ name: "other" });
    expect([named.namespace, named.name]).toEqual(["other.0", "other"]);
    expect(new FakeAdapter({ namespace: "lamp.3" }).name).toBe("lamp");
    const config = { deleteRecordedStates: false };
    const fake = new FakeAdapter({ config });
    expect(fake.config.deleteRecordedStates).toBe(false);
    config.deleteRecordedStates = true;
    expect(fake.config.deleteRecordedStates).toBe(false);
  });

  it("holds the start objects under their full id, each a copy with its id", () => {
    const start = state();
    const fake = new FakeAdapter({ objects: { a: start, "demo.0.b": state() } });
    expect([...fake.objects.keys()]).toEqual(["demo.0.a", "demo.0.b"]);
    expect(fake.objects.get("demo.0.a")?._id).toBe("demo.0.a");
    (start.common as Record<string, unknown>).name = "changed";
    expect(commonOf(fake, "demo.0.a")?.name).toBe("x");
  });
});

describe("FakeAdapter — reading the database", () => {
  it("lists every id between the keys, both included, sorted, each row a copy", async () => {
    const fake = new FakeAdapter({ objects: { c: state(), b: state(), "a.x": state(), a: state(), ab: state() } });
    const { rows } = await fake.getObjectListAsync({ startkey: "demo.0.a", endkey: "demo.0.b" });
    expect(rows.map(row => row.id)).toEqual(["demo.0.a", "demo.0.a.x", "demo.0.ab", "demo.0.b"]);
    ((rows[0].value as Record<string, unknown>).common as Record<string, unknown>).name = "changed";
    expect(commonOf(fake, "demo.0.a")?.name).toBe("x");
  });

  it("reads one object as a copy and answers null for a missing one", async () => {
    const fake = new FakeAdapter({ objects: { a: state() } });
    const read = await fake.getForeignObjectAsync("demo.0.a");
    expect(read?.type).toBe("state");
    (read?.common as Record<string, unknown>).name = "changed";
    expect(commonOf(fake, "demo.0.a")?.name).toBe("x");
    expect(await fake.getForeignObjectAsync("demo.0.missing")).toBeNull();
  });

  it("reads the objects of one type whose id matches the pattern, a dot only as a dot", async () => {
    const fake = new FakeAdapter({
      objects: {
        "enum.rooms.kitchen": { type: "enum", common: { members: [] } },
        "enum.rooms.hall": { type: "state", common: {} },
        enumX: { type: "enum", common: { members: [] } },
      },
    });
    const enums = await fake.getForeignObjectsAsync("demo.0.enum.*", "enum");
    expect(Object.keys(enums)).toEqual(["demo.0.enum.rooms.kitchen"]);
  });
});

describe("FakeAdapter — writing objects", () => {
  it("merges an extend into the stored object, or starts one", async () => {
    const fake = new FakeAdapter({ objects: { a: state() } });
    await fake.extendObject("a", { common: { role: "value" } });
    expect(commonOf(fake, "demo.0.a")).toEqual({ name: "x", role: "value" });
    await fake.extendObject("new", { type: "channel", common: { name: "n" } });
    expect(fake.objects.get("demo.0.new")).toEqual({ type: "channel", common: { name: "n" }, _id: "demo.0.new" });
  });

  it("keeps the user's recording when the whole object is replaced without it", async () => {
    const fake = new FakeAdapter({ objects: { a: recorded } });
    await fake.setForeignObject("demo.0.a", state({ role: "value" }));
    expect(commonOf(fake, "demo.0.a")).toEqual({
      name: "x",
      role: "value",
      custom: { "history.0": { enabled: true } },
    });
  });
});

describe("FakeAdapter — deleting as js-controller 7.2.5", () => {
  it("changes nothing for an id that is not there", async () => {
    const fake = new FakeAdapter({ objects: { a: state() } });
    await fake.delObjectAsync("missing");
    expect([...fake.objects.keys()]).toEqual(["demo.0.a"]);
  });

  it("refuses an object with dontDelete without recursive, and keeps it with recursive", async () => {
    const fake = new FakeAdapter({
      objects: { a: state({ dontDelete: true }), "a.x": state(), "a.y": state({ dontDelete: true }) },
    });
    await expect(fake.delObjectAsync("a")).rejects.toThrow("not deletable");
    expect([...fake.objects.keys()]).toEqual(["demo.0.a", "demo.0.a.x", "demo.0.a.y"]);
    await fake.delObjectAsync("a", { recursive: true });
    expect([...fake.objects.keys()]).toEqual(["demo.0.a", "demo.0.a.y"]);
  });

  it("takes only the root without recursive, and with it every id below — never a sibling with a longer name", async () => {
    const fake = new FakeAdapter({ objects: { a: state(), "a.x": state(), ab: state() } });
    await fake.delObjectAsync("a");
    expect([...fake.objects.keys()]).toEqual(["demo.0.a.x", "demo.0.ab"]);
    const again = new FakeAdapter({ objects: { a: state(), "a.x": state(), "a.x.y": state(), ab: state() } });
    await again.delObjectAsync("a", { recursive: true });
    expect([...again.objects.keys()]).toEqual(["demo.0.ab"]);
  });

  it("deletes the state of every deleted object and takes it out of every enum", async () => {
    const fake = new FakeAdapter({
      objects: {
        a: state(),
        "a.x": state(),
        b: state(),
        "enum.rooms.kitchen": { type: "enum", common: { members: ["demo.0.a.x", "demo.0.b"] } },
        "group.g": { type: "channel", common: { members: ["demo.0.a.x"] } },
        "meta.m": { type: "meta" },
      },
    });
    fake.states.set("demo.0.a.x", { val: 1, ack: true });
    fake.states.set("demo.0.b", { val: 2, ack: true });
    await fake.delForeignObjectAsync("demo.0.a", { recursive: true });
    expect([...fake.states.keys()]).toEqual(["demo.0.b"]);
    expect(commonOf(fake, "demo.0.enum.rooms.kitchen")?.members).toEqual(["demo.0.b"]);
    expect(commonOf(fake, "demo.0.group.g")?.members).toEqual(["demo.0.a.x"]);
    expect(fake.objects.get("demo.0.meta.m")).toEqual({ type: "meta", _id: "demo.0.meta.m" });
  });
});

describe("FakeAdapter — timers, messages, notifications, the end", () => {
  it("records every log line with its level, in order", () => {
    const fake = new FakeAdapter();
    fake.log.debug("d");
    fake.log.info("i");
    fake.log.warn("w");
    fake.log.error("e");
    expect(fake.lines).toEqual([
      { level: "debug", message: "d" },
      { level: "info", message: "i" },
      { level: "warn", message: "w" },
      { level: "error", message: "e" },
    ]);
  });

  it("fires a timer only when the test runs it, a cleared one never, each once", () => {
    const fake = new FakeAdapter();
    const fired: string[] = [];
    fake.setTimeout(() => fired.push("a"), 10);
    const cleared = fake.setTimeout(() => fired.push("b"), 20);
    fake.setTimeout(() => {
      fired.push("c");
      fake.setTimeout(() => fired.push("d"), 5);
    }, 30);
    fake.clearTimeout(cleared);
    fake.clearTimeout(undefined);
    expect(fired).toEqual([]);
    expect(fake.runTimers()).toBe(2);
    expect(fired).toEqual(["a", "c"]);
    expect(fake.runTimers()).toBe(1);
    expect(fired).toEqual(["a", "c", "d"]);
    expect(fake.runTimers()).toBe(0);
    expect(fake.timers.map(timer => timer.ms)).toEqual([10, 20, 30, 5]);
  });

  it("records a message as sent and answers it — every recording instance confirms unless the test says otherwise", async () => {
    const fake = new FakeAdapter();
    const message = [{ id: "demo.0.a" }];
    expect(await fake.sendToAsync("history.0", "deleteAll", message, { timeout: 30 })).toEqual({ success: true });
    message[0].id = "changed";
    expect(fake.sent).toEqual([
      { instance: "history.0", command: "deleteAll", message: [{ id: "demo.0.a" }], timeout: 30 },
    ]);
    fake.answer = sent => ({ error: sent.instance });
    expect(await fake.sendToAsync("sql.0", "deleteAll", [], { timeout: 1 })).toEqual({ error: "sql.0" });
  });

  it("records notifications, subscriptions and certificates, and ends with the exit code", async () => {
    const fake = new FakeAdapter();
    await fake.registerNotification("demo", "userActionRequired", "text");
    await fake.subscribeForeignObjectsAsync("system.certificates");
    fake.certificates = { key: "k" };
    expect(fake.notifications).toEqual([{ scope: "demo", category: "userActionRequired", message: "text" }]);
    expect(fake.subscriptions).toEqual(["system.certificates"]);
    expect(await fake.getCertificatesAsync()).toEqual({ key: "k" });
    let ended: unknown;
    try {
      fake.terminate("why", 6);
    } catch (err) {
      ended = err;
    }
    expect(ended).toBeInstanceOf(FakeTermination);
    expect(ended).toMatchObject({ reason: "why", exitCode: 6 });
  });

  it("seals a text so that only it opens it again", () => {
    const fake = new FakeAdapter();
    const sealed = fake.encrypt("secret");
    expect(sealed.startsWith(FAKE_SEALED)).toBe(true);
    expect(sealed).not.toContain("secret");
    expect(fake.decrypt(sealed)).toBe("secret");
    expect(() => fake.decrypt("secret")).toThrow("not encrypted by this adapter");
  });
});

describe("FakeAdapter — events and the adapter base", () => {
  it("hands an event to its listeners in order, each awaited, and to no other event", async () => {
    const fake = new FakeAdapter();
    const heard: string[] = [];
    expect(
      fake.on("objectChange", async (id: string) => {
        await Promise.resolve();
        heard.push(`first ${id}`);
      }),
    ).toBe(fake);
    fake.on("objectChange", (id: string) => heard.push(`second ${id}`));
    fake.on("unload", () => heard.push("unload"));
    await fake.emit("objectChange", "system.certificates");
    await fake.emit("ready");
    expect(heard).toEqual(["first system.certificates", "second system.certificates"]);
  });

  it("serves as the base of the adapter class", async () => {
    class Demo extends FakeAdapter {
      public started = false;
      constructor() {
        super({ name: "demo", objects: { info: { type: "channel", common: { name: "i" } } } });
        this.on("ready", () => {
          this.started = true;
        });
      }
    }
    const demo = new Demo();
    await demo.emit("ready");
    expect([demo.started, demo.namespace, demo.objects.has("demo.0.info")]).toEqual([true, "demo.0", true]);
  });
});

describe("the masters every adapter carries, on the FakeAdapter", () => {
  it("removeObject keeps a recorded datapoint while the first deletion option is off", async () => {
    const fake = new FakeAdapter({
      objects: { c: { type: "channel", common: { name: "c" } }, "c.s": recorded, "c.t": state() },
      config: { deleteRecordedStates: false },
    });
    const removal = await removeObject(fake, "c", { recursive: true });
    expect([...fake.objects.keys()]).toEqual(["demo.0.c", "demo.0.c.s"]);
    expect(removal.kept).toContain("demo.0.c.s");
    expect(fake.timers.map(timer => timer.ms)).toEqual([REPORT_MS]);
    fake.runTimers();
    expect(fake.lines.filter(line => line.level === "info")).toHaveLength(1);
  });

  it("removeObject has history.0 delete the recorded data first with the second option on", async () => {
    const fake = new FakeAdapter({
      objects: { s: recorded },
      config: { deleteRecordedStates: true, deleteRecordedHistory: true },
    });
    await removeObject(fake, "s");
    expect(fake.sent.map(sent => [sent.instance, sent.command, sent.message])).toEqual([
      ["history.0", "deleteAll", [{ id: "demo.0.s" }]],
    ]);
    expect(fake.objects.has("demo.0.s")).toBe(false);
  });

  it("KnownObjects loads, writes only a change, removes through the options and deletes a move past them", async () => {
    const fake = new FakeAdapter({ objects: { a: state(), b: recorded }, config: { deleteRecordedStates: false } });
    const known = new KnownObjects(fake);
    await known.load();
    expect(known.ids()).toEqual(["demo.0.a", "demo.0.b"]);
    expect(await known.extend("a", { common: { name: "x" } })).toBe(false);
    expect(await known.extend("a", { common: { name: "y" } })).toBe(true);
    await known.remove("b");
    expect(fake.objects.has("demo.0.b")).toBe(true);
    await known.deleteMoved("b");
    expect([fake.objects.has("demo.0.b"), known.get("b")]).toEqual([false, undefined]);
  });

  it("failStart ends a settings error with a notification and exit code 11", async () => {
    const fake = new FakeAdapter();
    const ended = await failStart(fake, new SettingsError("set the host"), { stopping: false }).catch(
      (err: unknown) => err,
    );
    expect(ended).toBeInstanceOf(FakeTermination);
    expect((ended as FakeTermination).exitCode).toBe(11);
    expect(fake.notifications).toEqual([{ scope: "demo", category: SETTINGS_CATEGORY, message: "set the host" }]);
    expect(fake.lines).toEqual([{ level: "error", message: "Settings: set the host" }]);
  });
});
