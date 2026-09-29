vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import { FakeAdapter } from "../../../test/helpers/fake-adapter";
import { AuthError, UnreachableError } from "./errors";
import { objectPauseStore, ProgramManager } from "./manager";
import type {
  Capability,
  Command,
  DownloadItem,
  DriverDeps,
  ProgramConfig,
  ProgramDriver,
  ProgramEntry,
  ProgramSnapshot,
} from "./model";
import type { TreeOptions } from "./tree";

const NS = "dl-manager.0";
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

interface FakeDriver extends ProgramDriver {
  polls: number;
  commands: Command[];
  closed: boolean;
  cfg: ProgramConfig;
}

/** How each configured program behaves, by host. */
type Behaviour = { snapshot: ProgramSnapshot } | { error: Error } | { pending: true };

const item = (key: string, status: DownloadItem["status"]): DownloadItem => ({
  key,
  name: `name-${key}`,
  status,
  sizeBytes: 100,
  doneBytes: 50,
  speedBps: null,
  etaSeconds: null,
  error: "",
});
const snap = (downloadBps: number, items: DownloadItem[] = [], paused = false): ProgramSnapshot => ({
  status: { version: "1.0", paused, downloadBps },
  items,
  complete: true,
});

function world(
  behaviour: Record<string, Behaviour>,
  capsFor: Record<string, Capability[]> = {},
): {
  a: FakeAdapter;
  drivers: FakeDriver[];
  manager: (opts?: Partial<TreeOptions>) => ProgramManager;
  reported: string[];
} {
  const a = new FakeAdapter(NS);
  const drivers: FakeDriver[] = [];
  const reported: string[] = [];
  const caps: Capability[] = ["globalPause", "itemPause", "itemRemove", "add"];
  const entry = (type: string): ProgramEntry => ({
    type,
    needs: ["host"],
    create: (cfg: ProgramConfig, _deps: DriverDeps): ProgramDriver => {
      const b = behaviour[cfg.host] ?? { error: new UnreachableError("no behaviour") };
      const d: FakeDriver = {
        type,
        capabilities: new Set(capsFor[cfg.host] ?? caps),
        extras: [],
        polls: 0,
        commands: [],
        closed: false,
        cfg,
        poll: () => {
          d.polls++;
          if ("pending" in b) {
            return new Promise<ProgramSnapshot>(() => undefined);
          }
          return "error" in b ? Promise.reject(b.error) : Promise.resolve(structuredClone(b.snapshot));
        },
        command: (cmd: Command): Promise<void> => {
          d.commands.push(cmd);
          return Promise.resolve();
        },
        close: (): Promise<void> => {
          d.closed = true;
          return Promise.resolve();
        },
      };
      drivers.push(d);
      return d;
    },
  });
  const entries: Record<string, ProgramEntry> = {
    qbittorrent: entry("qbittorrent"),
    sabnzbd: entry("sabnzbd"),
    "jdownloader-cloud": entry("jdownloader-cloud"),
  };
  const manager = (opts: Partial<TreeOptions> = {}): ProgramManager =>
    new ProgramManager(
      {
        adapter: a,
        timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
        find: type => entries[type],
        decrypt: v => v,
        problems: { report: key => void reported.push(key) },
      },
      { intervalMs: 10_000, scope: opts.scope ?? "all", limit: opts.limit ?? 0 },
    );
  return { a, drivers, manager, reported };
}

const row = (
  type: string,
  key: string,
  host: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  enabled: true,
  type,
  key,
  name: `${type} ${key}`,
  host,
  ...extra,
});

async function seedDevice(a: FakeAdapter, id: string, native: Record<string, unknown> = {}): Promise<void> {
  await a.setForeignObject(`${NS}.${id}`, {
    type: "device",
    common: { name: id },
    native: { type: id.split("-")[0], ...native },
  });
  await a.setForeignObject(`${NS}.${id}.online`, {
    type: "state",
    common: { name: "online", type: "boolean", role: "indicator.reachable", read: true, write: false },
    native: {},
  });
  await a.setState(`${id}.online`, { val: true, ack: true });
  await a.setState(`${id}.error`, { val: "", ack: true });
}

describe("ProgramManager — start", () => {
  it("stamps every known program offline/Unknown and the adapter disconnected BEFORE the first poll", async () => {
    const w = world({ h1: { pending: true } });
    await seedDevice(w.a, "qbittorrent-nas");
    await w.a.setState("info.connection", { val: true, ack: true });
    await w.a.setState("info.programsOnline", { val: 3, ack: true });
    await w.a.setState("info.programsAllOnline", { val: true, ack: true });
    await w.manager().start([row("qbittorrent", "nas", "h1")]);
    expect(w.drivers[0].polls).toBe(1);
    expect(w.a.val("qbittorrent-nas.online")).toBe(false);
    expect(w.a.val("qbittorrent-nas.error")).toBe("Unknown");
    expect(w.a.val("info.connection")).toBe(false);
    expect(w.a.val("info.programsOnline")).toBe(0);
    expect(w.a.val("info.programsAllOnline")).toBe(false);
  });

  it("shows a row that cannot run on its device and starts no driver for it", async () => {
    const w = world({});
    await w.manager().start([row("qbittorrent", "a", ""), row("emule", "b", "h")]);
    expect(w.drivers).toHaveLength(0);
    expect(w.a.val("qbittorrent-a.error")).toBe("host missing");
    expect(w.a.val("emule-b.error")).toBe("unknown program type: emule");
    expect(w.a.val("info.programsTotal")).toBe(2);
  });

  it("gives each program's device its pictogram as an inline data URI", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await w.manager().start([row("qbittorrent", "nas", "h1")]);
    expect(String(w.a.objects.get(`${NS}.qbittorrent-nas`)?.common.icon)).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("deletes the device of a program that is no longer configured", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await seedDevice(w.a, "sabnzbd-old");
    await w.manager().start([row("qbittorrent", "nas", "h1")]);
    expect(w.a.objects.has(`${NS}.sabnzbd-old`)).toBe(false);
    expect(w.a.objects.has(`${NS}.sabnzbd-old.online`)).toBe(false);
    expect(w.a.objects.has(`${NS}.qbittorrent-nas`)).toBe(true);
  });

  it("keeps the device of a disabled program, offline and Unknown, and does not count it", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await seedDevice(w.a, "sabnzbd-off");
    await w.manager().start([row("sabnzbd", "off", "h9", { enabled: false }), row("qbittorrent", "nas", "h1")]);
    await flush();
    expect(w.a.objects.has(`${NS}.sabnzbd-off`)).toBe(true);
    expect(w.a.val("sabnzbd-off.online")).toBe(false);
    expect(w.a.val("sabnzbd-off.error")).toBe("Unknown");
    expect(w.a.val("info.programsTotal")).toBe(1);
    expect(w.a.val("info.programsAllOnline")).toBe(true);
  });

  it("carries the room of a program whose key changed (same type and address)", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await seedDevice(w.a, "qbittorrent-old", { address: "http://h1:8080" });
    await w.a.setForeignObject("enum.rooms.office", {
      type: "enum",
      common: { name: "Office", members: [`${NS}.qbittorrent-old`, `${NS}.qbittorrent-old.online`, "other.0.x"] },
      native: {},
    });
    await w.manager().start([row("qbittorrent", "new", "h1")]);
    expect(w.a.objects.has(`${NS}.qbittorrent-old`)).toBe(false);
    expect((w.a.objects.get("enum.rooms.office")?.common as { members: string[] }).members.sort()).toEqual(
      ["other.0.x", `${NS}.qbittorrent-new`, `${NS}.qbittorrent-new.online`].sort(),
    );
  });

  it("hands a device on only to an enabled, sound row of the same type and address", async () => {
    const office = async (w: ReturnType<typeof world>, member: string): Promise<void> => {
      await w.a.setForeignObject("enum.rooms.office", {
        type: "enum",
        common: { name: "Office", members: [member] },
        native: {},
      });
    };
    const members = (w: ReturnType<typeof world>): string[] =>
      (w.a.objects.get("enum.rooms.office")?.common as { members: string[] }).members;
    const cases: [string, Record<string, unknown>, Record<string, unknown>[]][] = [
      ["sabnzbd-old", { address: "http://h1:8080" }, [row("qbittorrent", "new", "h1")]],
      ["qbittorrent-old", { address: "http://h2:8080" }, [row("qbittorrent", "new", "h1")]],
      ["qbittorrent-old", { address: "http://h1:8080" }, [row("qbittorrent", "new", "h1", { enabled: false })]],
      [
        "qbittorrent-old",
        { address: "http://h1:8080" },
        [row("qbittorrent", "new", "h9"), row("qbittorrent", "new", "h1")],
      ],
    ];
    for (const [old, native, rows] of cases) {
      const w = world({ h1: { snapshot: snap(0) }, h9: { snapshot: snap(0) } });
      await seedDevice(w.a, old, native);
      await office(w, `${NS}.${old}`);
      await w.manager().start(rows);
      expect([old, members(w)]).toEqual([old, [`${NS}.${old}`]]);
      expect([old, w.a.objects.has(`${NS}.${old}`)]).toEqual([old, false]);
    }
  });

  it("never hands a device to a program that already has one, and one device per row", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await seedDevice(w.a, "qbittorrent-new", { address: "http://h1:8080" });
    await seedDevice(w.a, "qbittorrent-old", { address: "http://h1:8080" });
    await w.a.setForeignObject("enum.rooms.office", {
      type: "enum",
      common: { name: "Office", members: [`${NS}.qbittorrent-old`] },
      native: {},
    });
    await w.manager().start([row("qbittorrent", "new", "h1")]);
    expect((w.a.objects.get("enum.rooms.office")?.common as { members: string[] }).members).toEqual([
      `${NS}.qbittorrent-old`,
    ]);

    const w2 = world({ h1: { snapshot: snap(0) } });
    await seedDevice(w2.a, "qbittorrent-o1", { address: "http://h1:8080" });
    await seedDevice(w2.a, "qbittorrent-o2", { address: "http://h1:8080" });
    await w2.manager().start([row("qbittorrent", "new", "h1")]);
    expect(w2.a.objects.has(`${NS}.qbittorrent-o1`)).toBe(false);
    expect(w2.a.objects.has(`${NS}.qbittorrent-o2`)).toBe(false);
  });

  it("carries the room of a JDownloader switched between local and My.JDownloader under the same ID", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await seedDevice(w.a, "jdownloader-keller", { type: "jdownloader", address: "http://h1:3128" });
    await w.a.setForeignObject("enum.rooms.office", {
      type: "enum",
      common: { name: "Office", members: [`${NS}.jdownloader-keller`] },
      native: {},
    });
    await w.manager().start([row("jdownloader-cloud", "keller", "h1", { username: "me@x", device: "PC" })]);
    expect(w.a.objects.has(`${NS}.jdownloader-keller`)).toBe(false);
    expect((w.a.objects.get("enum.rooms.office")?.common as { members: string[] }).members).toEqual([
      `${NS}.jdownloader-cloud-keller`,
    ]);
  });

  it("carries no assignment into a datapoint the new device does not have", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await seedDevice(w.a, "qbittorrent-old", { address: "http://h1:8080" });
    await w.a.setForeignObject(`${NS}.qbittorrent-old.foo`, {
      type: "state",
      common: { name: "foo", type: "number", role: "value", read: true, write: false },
      native: {},
    });
    await w.a.setForeignObject("enum.functions.x", {
      type: "enum",
      common: { name: "X", members: [`${NS}.qbittorrent-old.foo`] },
      native: {},
    });
    await w.manager().start([row("qbittorrent", "new", "h1")]);
    const members = (w.a.objects.get("enum.functions.x")?.common as { members: string[] }).members;
    expect(members).not.toContain(`${NS}.qbittorrent-new.foo`);
  });

  it("treats only top-level devices as programs and stamps no value into a missing object", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await w.a.extendObject("qbittorrent-nas.child", { type: "device", common: { name: "child" }, native: {} });
    await w.a.setForeignObject(`${NS}.sabnzbd-old`, { type: "device", common: { name: "old" }, native: {} });
    await w.manager().start([row("qbittorrent", "nas", "h1")]);
    expect(w.a.objects.has(`${NS}.qbittorrent-nas.child`)).toBe(true);
    expect(w.a.orphanWrites.filter(id => id.includes("sabnzbd-old"))).toEqual([]);
  });

  it("writes the summary over reachable programs only", async () => {
    const w = world({
      h1: { snapshot: snap(1_000_000, [item("a", "downloading")]) },
      h2: { snapshot: snap(2_000_000, [item("b", "downloading"), item("c", "queued")]) },
      h3: { error: new UnreachableError("down") },
    });
    await w.manager().start([row("qbittorrent", "a", "h1"), row("sabnzbd", "b", "h2"), row("qbittorrent", "c", "h3")]);
    await flush();
    expect(w.a.val("info.connection")).toBe(true);
    expect(w.a.val("info.programsTotal")).toBe(3);
    expect(w.a.val("info.programsOnline")).toBe(2);
    expect(w.a.val("info.programsAllOnline")).toBe(false);
    expect(w.a.val("summary.downloadSpeed")).toBe(3);
    expect(w.a.val("summary.active")).toBe(2);
    expect(w.a.val("summary.queued")).toBe(1);
  });

  it("reports a rejected login once as an actionable problem", async () => {
    const w = world({ h1: { error: new AuthError("401") } });
    await w.manager().start([row("qbittorrent", "nas", "h1")]);
    await flush();
    expect(w.reported).toEqual(["auth:qbittorrent-nas"]);
  });
});

describe("ProgramManager — poll interval", () => {
  it("never polls a program faster than its driver allows (My.JDownloader: 30 s)", async () => {
    const a = new FakeAdapter(NS);
    const delays: number[] = [];
    const m = new ProgramManager(
      {
        adapter: a,
        timers: {
          setTimeout: (_cb, ms) => {
            delays.push(ms);
            return undefined;
          },
          clearTimeout: () => undefined,
        },
        find: () => ({
          type: "jdownloader-cloud",
          needs: ["host"],
          create: (): ProgramDriver => ({
            type: "jdownloader-cloud",
            minIntervalMs: 30_000,
            capabilities: new Set(),
            extras: [],
            poll: () => Promise.resolve(snap(0)),
            command: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        }),
        decrypt: v => v,
        problems: { report: () => undefined },
      },
      { intervalMs: 10_000, scope: "all", limit: 0 },
    );
    await m.start([row("jdownloader-cloud", "c", "h")]);
    await flush();
    expect(delays).toContain(30_000);
    expect(delays).not.toContain(10_000);
  });
});

describe("ProgramManager — user writes", () => {
  it("pause all reaches only reachable programs and says how many", async () => {
    const w = world({ h1: { snapshot: snap(0) }, h2: { snapshot: snap(0) }, h3: { error: new UnreachableError("x") } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1"), row("sabnzbd", "b", "h2"), row("qbittorrent", "c", "h3")]);
    await flush();
    await m.onUserWrite("summary.pauseAll", true);
    expect(w.drivers.map(d => d.commands)).toEqual([[{ kind: "pauseAll" }], [{ kind: "pauseAll" }], []]);
    const info = w.a.logs.filter(l => l.level === "info").map(l => l.msg);
    expect(info).toContain("pause all: paused 2 of 3 program(s) — not reachable: qbittorrent-c");
  });

  it("resume all resumes, and pause all leaves programs without a pause alone", async () => {
    const w = world({ h1: { snapshot: snap(0) }, h2: { snapshot: snap(0) } }, { h2: ["add"] });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1"), row("sabnzbd", "b", "h2")]);
    await flush();
    await m.onUserWrite("summary.pauseAll", false);
    expect(w.drivers.map(d => d.commands)).toEqual([[{ kind: "resumeAll" }], []]);
  });

  it("sets a value the user wrote back when the program did not follow (final review M1)", async () => {
    const w = world({ h1: { snapshot: snap(0, [item("aaaa11112222", "downloading")]) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "nas", "h1")]);
    await flush();
    await w.a.setState("qbittorrent-nas.downloads.11112222.paused", { val: true, ack: false });
    await m.onUserWrite("qbittorrent-nas.downloads.11112222.paused", true);
    await flush();
    expect(w.a.states.get(`${NS}.qbittorrent-nas.downloads.11112222.paused`)).toMatchObject({ val: false, ack: true });
  });

  it("says in one info line how many download channels the tree settings took out (final review M4)", async () => {
    const b = { snapshot: snap(0, [item("c1", "downloading"), item("c2", "downloading"), item("d1", "downloading")]) };
    const w = world({ h1: b });
    const m = w.manager({ scope: "withoutCompleted" });
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    b.snapshot = snap(0, [item("c1", "completed"), item("c2", "completed"), item("d1", "downloading")]);
    await m.onUserWrite("qbittorrent-a.paused", true);
    await flush();
    expect(w.a.logs.filter(l => l.level === "info").map(l => l.msg)).toContain(
      "qbittorrent-a: removed 2 download(s) from the object tree (tree settings)",
    );
  });

  it("hands scope and limit to the tree", async () => {
    const items = [item("q1", "queued"), item("q2", "queued"), item("q3", "queued"), item("c1", "completed")];
    const w = world({ h1: { snapshot: snap(0, items) } });
    await w.manager({ scope: "unfinished", limit: 2 }).start([row("qbittorrent", "a", "h1")]);
    await flush();
    const channels = [...w.a.objects.values()].filter(o => o.type === "channel");
    expect(channels).toHaveLength(2);
    expect(channels.map(o => o.native.key)).not.toContain("c1");
  });

  it("says so when no configured program can pause", async () => {
    const w = world({ h1: { snapshot: snap(0) } }, { h1: ["add"] });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    await m.onUserWrite("summary.pauseAll", true);
    expect(w.a.logs.map(l => l.msg)).toContain("pause all: no configured program can pause");
  });

  it("puts the last of several finishes and failures of one poll into the summary", async () => {
    const b = { snapshot: snap(0, [item("k1", "downloading"), item("k2", "downloading"), item("k3", "queued")]) };
    b.snapshot.items.push(item("k4", "queued"));
    const w = world({ h1: b });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    b.snapshot = snap(0, [
      item("k1", "completed"),
      item("k2", "completed"),
      item("k3", "failed"),
      item("k4", "failed"),
    ]);
    await m.onUserWrite("qbittorrent-a.paused", true);
    await flush();
    expect(w.a.val("summary.lastFinished")).toBe("name-k2");
    expect(w.a.val("summary.lastFailed")).toBe("name-k4");
  });

  it("writes no summary for a poll that ends after stop", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    // the first poll hangs in its tree write; stop then hangs in marking the program offline — the poll ends
    // while the manager still holds its runner
    let openPoll: () => void = () => undefined;
    let openStop: () => void = () => undefined;
    const pollGate = new Promise<void>(resolve => (openPoll = resolve));
    const stopGate = new Promise<void>(resolve => (openStop = resolve));
    let stopArmed = false;
    const plain = w.a.setStateChanged.bind(w.a);
    w.a.setStateChanged = (id, st) => {
      if (id.endsWith(".version")) {
        return pollGate.then(() => plain(id, st));
      }
      if (stopArmed && id.endsWith(".online") && st.val === false) {
        return stopGate.then(() => plain(id, st));
      }
      return plain(id, st);
    };
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    stopArmed = true;
    const stopping = m.stop();
    await flush();
    const from = w.a.writeLog.length;
    openPoll();
    await flush();
    openStop();
    await stopping;
    await flush();
    expect(w.a.writeLog.slice(from).filter(x => x.id === "info.connection" && x.val === true)).toEqual([]);
  });

  it("confirms a button with ack after the command, leaves a switch to the next poll", async () => {
    const w = world({ h1: { snapshot: snap(0, [item("aaaa11112222", "downloading")]) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "nas", "h1")]);
    await flush();
    await w.a.setState("qbittorrent-nas.downloads.11112222.remove", { val: true, ack: false });
    await m.onUserWrite("qbittorrent-nas.downloads.11112222.remove", true);
    expect(w.drivers[0].commands).toContainEqual({ kind: "remove", key: "aaaa11112222" });
    expect(w.a.states.get(`${NS}.qbittorrent-nas.downloads.11112222.remove`)?.ack).toBe(true);

    await w.a.setState("qbittorrent-nas.paused", { val: true, ack: false });
    await m.onUserWrite("qbittorrent-nas.paused", true);
    expect(w.drivers[0].commands).toContainEqual({ kind: "pauseAll" });
    expect(w.a.states.get(`${NS}.qbittorrent-nas.paused`)?.ack).toBe(false);
  });

  it("empties add after sending it, and never logs a secret of the link", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "nas", "h1")]);
    await flush();
    await m.onUserWrite("qbittorrent-nas.add", "https://u:secret@host/file?apikey=abc");
    expect(w.drivers[0].commands).toContainEqual({ kind: "add", url: "https://u:secret@host/file?apikey=abc" });
    expect(w.a.states.get(`${NS}.qbittorrent-nas.add`)).toMatchObject({ val: "", ack: true });
    expect(w.a.logs.map(l => l.msg).join("\n")).not.toContain("secret");
  });

  it("ignores a write to a program that does not run", async () => {
    const w = world({});
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "")]);
    const before = w.a.logs.length;
    await m.onUserWrite("qbittorrent-a.paused", true);
    expect(w.a.logs.slice(before)).toEqual([]);
  });
});

describe("objectPauseStore", () => {
  it("keeps the pause state in the native of the paused datapoint, and nothing while that object is missing", async () => {
    const a = new FakeAdapter(NS);
    const store = objectPauseStore(a, `${NS}.qbittorrent-nas.paused`);
    expect(await store.load()).toEqual({ paused: false, keys: [] });
    await store.save({ paused: true, keys: ["h1"] });
    expect(a.objects.has(`${NS}.qbittorrent-nas.paused`)).toBe(false);
    await a.setForeignObject(`${NS}.qbittorrent-nas.paused`, {
      type: "state",
      common: { name: "paused", type: "boolean", role: "switch", read: true, write: true },
      native: { other: 1 },
    });
    await store.save({ paused: true, keys: ["h1", "h2"] });
    expect(a.objects.get(`${NS}.qbittorrent-nas.paused`)?.native).toEqual({
      other: 1,
      emulatedPause: { paused: true, keys: ["h1", "h2"] },
    });
    expect(await objectPauseStore(a, `${NS}.qbittorrent-nas.paused`).load()).toEqual({
      paused: true,
      keys: ["h1", "h2"],
    });
  });
});

describe("ProgramManager — connection test and stop", () => {
  it("asks the program once, closes the test driver and reports version and downloads", async () => {
    const w = world({ h1: { snapshot: snap(0, [item("x", "queued")]) } });
    expect(await w.manager().testProgram(row("qbittorrent", "a", "h1"))).toEqual({
      ok: true,
      version: "1.0",
      downloads: 1,
    });
    expect(w.drivers.map(d => [d.polls, d.closed])).toEqual([[1, true]]);
  });

  it("tells a rejected login, an unreachable program and any other failure apart", async () => {
    const w = world({
      h1: { error: new AuthError("401 Unauthorized") },
      h2: { error: new UnreachableError("ECONNREFUSED") },
      h3: { error: new Error("odd answer") },
    });
    const m = w.manager();
    expect(await m.testProgram(row("sabnzbd", "b", "h1"))).toEqual({
      ok: false,
      kind: "auth",
      text: "401 Unauthorized",
    });
    expect(await m.testProgram(row("sabnzbd", "b", "h2"))).toEqual({
      ok: false,
      kind: "unreachable",
      text: "ECONNREFUSED",
    });
    expect(await m.testProgram(row("sabnzbd", "b", "h3"))).toEqual({ ok: false, kind: "other", text: "odd answer" });
    expect(w.drivers.every(d => d.closed)).toBe(true);
  });

  it("reports a row that cannot run without asking anything", async () => {
    const w = world({});
    expect(await w.manager().testProgram(row("qbittorrent", "c", ""))).toEqual({
      ok: false,
      kind: "setup",
      text: "host missing",
    });
    expect(await w.manager().testProgram(row("emule", "c", "h1"))).toEqual({
      ok: false,
      kind: "setup",
      text: "unknown program type: emule",
    });
    expect(await w.manager().testProgram(null)).toEqual({ ok: false, kind: "setup", text: "program type missing" });
    expect(w.drivers).toEqual([]);
  });

  it("tests a switched-off row all the same", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    expect(await w.manager().testProgram(row("qbittorrent", "a", "h1", { enabled: false }))).toMatchObject({
      ok: true,
    });
  });

  it("hands the driver the stored secrets through decrypt", async () => {
    const seen: string[] = [];
    const m = new ProgramManager(
      {
        adapter: new FakeAdapter(NS),
        timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
        find: () => ({
          type: "qbittorrent",
          needs: ["host"],
          create: (cfg: ProgramConfig): ProgramDriver => {
            seen.push(cfg.password);
            return {
              type: "qbittorrent",
              capabilities: new Set(),
              extras: [],
              poll: () => Promise.resolve(snap(0)),
              command: () => Promise.resolve(),
              close: () => Promise.resolve(),
            };
          },
        }),
        decrypt: v => `plain(${v})`,
        problems: { report: () => undefined },
      },
      { intervalMs: 10_000, scope: "all", limit: 0 },
    );
    await m.testProgram(row("qbittorrent", "a", "h1", { password: "stored" }));
    expect(seen).toEqual(["plain(stored)"]);
  });

  it("uses a driver's own quiet check instead of a poll when it has one", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    const m = new ProgramManager(
      {
        adapter: w.a,
        timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
        find: () => ({
          type: "sabnzbd",
          needs: ["host"],
          create: (): ProgramDriver => ({
            type: "sabnzbd",
            capabilities: new Set(),
            extras: [],
            poll: () => Promise.reject(new Error("must not poll")),
            test: () => Promise.resolve("5.1.3"),
            command: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        }),
        decrypt: v => v,
        problems: { report: () => undefined },
      },
      { intervalMs: 10_000, scope: "all", limit: 0 },
    );
    expect(await m.testProgram(row("sabnzbd", "b", "h1"))).toEqual({ ok: true, version: "5.1.3" });
  });

  it("stop closes every driver, marks every program Unknown and the adapter disconnected", async () => {
    const w = world({ h1: { snapshot: snap(0) }, h2: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1"), row("sabnzbd", "b", "h2")]);
    await flush();
    expect(w.a.val("info.connection")).toBe(true);
    await m.stop();
    expect(w.drivers.every(d => d.closed)).toBe(true);
    expect(w.a.val("qbittorrent-a.online")).toBe(false);
    expect(w.a.val("sabnzbd-b.error")).toBe("Unknown");
    expect(w.a.val("info.connection")).toBe(false);
    expect(w.a.val("info.programsOnline")).toBe(0);
  });

  it("leaves no stale summary on a stopped adapter (final review M6)", async () => {
    const w = world({ h1: { snapshot: snap(1_000_000, [item("a", "downloading")]) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    expect(w.a.val("summary.active")).toBe(1);
    await m.stop();
    expect(w.a.val("summary.active")).toBe(0);
    expect(w.a.val("summary.downloading")).toBe(false);
    expect(w.a.val("summary.downloadSpeed")).toBeNull();
  });
});
