vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import { FakeAdapter } from "../../../test/helpers/fake-adapter";
import { AuthError, UnreachableError } from "./errors";
import { objectPauseStore, ProgramManager, startLine } from "./manager";
import { KnownStates } from "./states";
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
  resolved: string[];
  moved: [string, string][];
  learned: [string, string][];
} {
  const a = new FakeAdapter(NS);
  const drivers: FakeDriver[] = [];
  const reported: string[] = [];
  const resolved: string[] = [];
  const moved: [string, string][] = [];
  const learned: [string, string][] = [];
  const caps: Capability[] = ["globalPause", "itemPause", "itemRemove", "add"];
  const entry = (type: string): ProgramEntry => ({
    type,
    needs: ["host"],
    create: (cfg: ProgramConfig, deps: DriverDeps): ProgramDriver => {
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
          deps.onDeviceId?.(`id-of-${cfg.host}`);
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
        problems: {
          report: key => void reported.push(key),
          forget: key => void resolved.push(key),
        },
        moveDevice: async (from, to) => {
          moved.push([from, to]);
          for (const [id, obj] of [...a.objects]) {
            if (id === `${NS}.${from}` || id.startsWith(`${NS}.${from}.`)) {
              a.objects.delete(id);
              a.objects.set(`${NS}.${to}${id.slice(`${NS}.${from}`.length)}`, obj);
            }
          }
          return Promise.resolve();
        },
        onDeviceId: (programId, deviceId) => void learned.push([programId, deviceId]),
      },
      { intervalMs: 10_000, scope: opts.scope ?? "all", limit: opts.limit ?? 0 },
    );
  return { a, drivers, manager, reported, resolved, moved, learned };
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
    // the reason is the fleet's one word — what is wrong with the card goes to the log and onto the card
    expect(w.a.val("qbittorrent-a.error")).toBe("Unknown");
    expect(w.a.val("emule-b.error")).toBe("Unknown");
    const warned = w.a.logs.filter(l => l.level === "warn").map(l => l.msg);
    expect(warned.some(m => m.startsWith("qbittorrent-a: host missing"))).toBe(true);
    expect(warned.some(m => m.startsWith("emule-b: unknown program type: emule"))).toBe(true);
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
    // a switched-off program is no row that cannot run — no warning about it
    expect(w.a.logs.filter(l => l.level === "warn" && l.msg.startsWith("sabnzbd-off"))).toEqual([]);
  });

  it("treats only top-level devices as programs and stamps no value into a missing object", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await w.a.extendObject("qbittorrent-nas.child", { type: "device", common: { name: "child" }, native: {} });
    await w.a.setForeignObject(`${NS}.sabnzbd-old`, { type: "device", common: { name: "old" }, native: {} });
    await w.a.setForeignObject(`${NS}.summary`, { type: "channel", common: { name: "summary" }, native: {} });
    await w.manager().start([row("qbittorrent", "nas", "h1")]);
    expect(w.a.objects.has(`${NS}.qbittorrent-nas.child`)).toBe(true);
    expect(w.a.orphanWrites.filter(id => id.includes("sabnzbd-old"))).toEqual([]);
    // a device without a program type is not the adapter's — it stays
    expect(w.a.objects.has(`${NS}.sabnzbd-old`)).toBe(true);
    expect(w.a.objects.has(`${NS}.summary`)).toBe(true);
  });

  it("writes the summary one poll after the other — the last value written is the current one, none twice", async () => {
    const a = new FakeAdapter(NS);
    // polls that end together, and a database that answers each write at its own pace: two summaries would otherwise
    // interleave and the older one could be written last
    const gate: { open: () => void; ready: Promise<void> } = { open: () => undefined, ready: Promise.resolve() };
    gate.ready = new Promise<void>(resolve => (gate.open = resolve));
    const setState = a.setState.bind(a);
    let calls = 0;
    const known = new KnownStates({
      namespace: NS,
      getStates: () => Promise.resolve({}),
      setState: async (id, st) => {
        for (let n = (calls++ * 7) % 5; n >= 0; n--) {
          await new Promise(resolve => setImmediate(resolve));
        }
        return setState(id, st);
      },
    });
    a.setStateChanged = (id, st) => known.put(id, st);
    const speed: Record<string, number> = { h1: 1_000_000, h2: 2_000_000, h3: 4_000_000 };
    const m = new ProgramManager(
      {
        adapter: a,
        timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
        find: () => ({
          type: "qbittorrent",
          needs: ["host"],
          create: (cfg: ProgramConfig): ProgramDriver => ({
            type: "qbittorrent",
            capabilities: new Set(),
            extras: [],
            poll: async () => {
              await gate.ready;
              return snap(speed[cfg.host]);
            },
            command: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        }),
        problems: { report: () => undefined, forget: () => undefined },
        moveDevice: () => Promise.resolve(),
      },
      { intervalMs: 10_000, scope: "all", limit: 0 },
    );
    await m.start([row("qbittorrent", "a", "h1"), row("qbittorrent", "b", "h2"), row("qbittorrent", "c", "h3")]);
    gate.open();
    for (let i = 0; i < 300; i++) {
      await flush();
    }
    const speeds = a.writeLog.filter(l => l.id === "summary.downloadSpeed").map(l => l.val);
    // every poll adds a program: each summary written is larger than the one before, none comes back stale
    expect(speeds[0]).toBeNull();
    const sums = speeds.slice(1) as number[];
    expect(sums).toEqual([...new Set(sums)].sort((x, y) => x - y));
    expect(sums.at(-1)).toBe(7);
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

  it("never builds a device under an id that belongs to the instance itself", async () => {
    const w = world({});
    await w.manager().start([row("emule", "", "h", { id: "summary" })]);
    expect(w.a.objects.has(`${NS}.summary`)).toBe(false);
    expect(w.a.logs.some(l => l.level === "warn" && l.msg.startsWith("summary:"))).toBe(true);
  });

  it("hands the id My.JDownloader names on to the adapter", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await w.manager().start([row("qbittorrent", "nas", "h1")]);
    await flush();
    expect(w.learned).toEqual([["qbittorrent-nas", "id-of-h1"]]);
  });
});

describe("ProgramManager — apply (changed rows while running)", () => {
  it("starts a new program, removes a deleted one with its device, and leaves an unchanged one running", async () => {
    const w = world({ h1: { snapshot: snap(0) }, h2: { snapshot: snap(0) }, h3: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1"), row("qbittorrent", "b", "h2")]);
    await flush();
    const [first, second] = w.drivers;
    await m.apply([row("qbittorrent", "a", "h1"), row("sabnzbd", "c", "h3")]);
    await flush();
    expect(first.closed).toBe(false);
    expect(second.closed).toBe(true);
    expect(w.a.objects.has(`${NS}.qbittorrent-b`)).toBe(false);
    expect(w.a.objects.has(`${NS}.sabnzbd-c`)).toBe(true);
    expect(w.drivers).toHaveLength(3);
    expect(w.drivers[2].polls).toBeGreaterThan(0);
    expect(w.a.val("info.programsTotal")).toBe(2);
  });

  it("starts a changed program anew and forgets its rejected login", async () => {
    const w = world({ h1: { error: new AuthError("401") }, h9: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    await m.apply([row("qbittorrent", "a", "h9")]);
    await flush();
    expect(w.drivers[0].closed).toBe(true);
    expect(w.drivers[1].cfg.host).toBe("h9");
    expect(w.resolved).toContain("auth:qbittorrent-a");
    expect(w.a.val("qbittorrent-a.online")).toBe(true);
  });

  it("switches a program off: its device stays, offline and Unknown", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    await m.apply([row("qbittorrent", "a", "h1", { enabled: false })]);
    expect(w.drivers[0].closed).toBe(true);
    expect(w.a.objects.has(`${NS}.qbittorrent-a`)).toBe(true);
    expect(w.a.val("qbittorrent-a.online")).toBe(false);
    expect(w.a.val("qbittorrent-a.error")).toBe("Unknown");
  });

  it("moves the device of a program whose id changed before it starts under the new id", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1", { id: "qbittorrent-old" })]);
    await flush();
    await m.apply(
      [row("qbittorrent", "a", "h1", { id: "qbittorrent-new" })],
      new Map([["qbittorrent-old", "qbittorrent-new"]]),
    );
    await flush();
    expect(w.moved).toEqual([["qbittorrent-old", "qbittorrent-new"]]);
    expect(w.drivers[0].closed).toBe(true);
    expect(w.a.objects.has(`${NS}.qbittorrent-old`)).toBe(false);
    expect(w.a.val("qbittorrent-new.online")).toBe(true);
  });

  it("waits for a poll under way before the device goes — nothing writes into it afterwards", async () => {
    let release: (s: ProgramSnapshot) => void = () => undefined;
    const w = world({});
    const m = new ProgramManager(
      {
        adapter: w.a,
        timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
        find: () => ({
          type: "qbittorrent",
          needs: ["host"],
          create: (): ProgramDriver => ({
            type: "qbittorrent",
            capabilities: new Set(),
            extras: [],
            poll: () => new Promise<ProgramSnapshot>(r => (release = r)),
            command: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        }),
        problems: { report: () => undefined, forget: () => undefined },
        moveDevice: () => Promise.resolve(),
      },
      { intervalMs: 10_000, scope: "all", limit: 0 },
    );
    await m.start([row("qbittorrent", "a", "h1")]);
    const applied = m.apply([]);
    await flush();
    release(snap(0, [item("x", "downloading")]));
    await applied;
    await flush();
    expect([...w.a.objects.keys()].filter(id => id.includes("qbittorrent-a"))).toEqual([]);
    expect(w.a.orphanWrites.filter(id => id.includes("qbittorrent-a"))).toEqual([]);
  });

  it("takes changes one after the other", async () => {
    const w = world({ h1: { snapshot: snap(0) }, h2: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([]);
    await Promise.all([m.apply([row("qbittorrent", "a", "h1")]), m.apply([row("qbittorrent", "a", "h2")])]);
    await flush();
    expect(w.drivers.map(d => [d.cfg.host, d.closed])).toEqual([
      ["h1", true],
      ["h2", false],
    ]);
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
        problems: { report: () => undefined, forget: () => undefined },
        moveDevice: () => Promise.resolve(),
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

  it("says on info what a changed tree setting took out at the start — later removals are routine (debug)", async () => {
    const b = { snapshot: snap(0, [item("c1", "completed"), item("c2", "completed"), item("d1", "downloading")]) };
    const w = world({ h1: b });
    const before = w.manager();
    await before.start([row("qbittorrent", "a", "h1")]);
    await flush();
    await before.stop();
    const m = w.manager({ scope: "withoutCompleted" });
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    const line = "qbittorrent-a: removed 2 download(s) from the object tree (tree settings)";
    expect(w.a.logs.filter(l => l.level === "info").map(l => l.msg)).toContain(line);
    b.snapshot = snap(0, [item("d1", "completed")]);
    await m.onUserWrite("qbittorrent-a.paused", true);
    await flush();
    const later = "qbittorrent-a: removed 1 download(s) from the object tree (tree settings)";
    expect(w.a.logs.filter(l => l.msg === later).map(l => l.level)).toEqual(["debug"]);
  });

  it("keeps the start's info line for the first sync that succeeds, also after a failed first poll", async () => {
    const b: { snapshot?: ProgramSnapshot; error?: Error } = {
      snapshot: snap(0, [item("c1", "completed"), item("d1", "downloading")]),
    };
    const w = world({ h1: b as Behaviour });
    const before = w.manager();
    await before.start([row("qbittorrent", "a", "h1")]);
    await flush();
    await before.stop();
    b.error = new UnreachableError("down");
    const m = w.manager({ scope: "withoutCompleted" });
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    delete b.error;
    await m.onUserWrite("qbittorrent-a.paused", true);
    await flush();
    const line = "qbittorrent-a: removed 1 download(s) from the object tree (tree settings)";
    expect(w.a.logs.filter(l => l.msg === line).map(l => l.level)).toEqual(["info"]);
  });

  it("hands scope and limit to the tree", async () => {
    const items = [item("q1", "queued"), item("q2", "queued"), item("q3", "queued"), item("c1", "completed")];
    const w = world({ h1: { snapshot: snap(0, items) } });
    await w.manager({ scope: "unfinished", limit: 2 }).start([row("qbittorrent", "a", "h1")]);
    await flush();
    const channels = [...w.a.objects]
      .filter(([id, o]) => o.type === "channel" && id.includes(".downloads."))
      .map(([, o]) => o);
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
    expect(w.a.val("summary.last.finished")).toBe("name-k2");
    expect(w.a.val("summary.last.failed")).toBe("name-k4");
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
        problems: { report: () => undefined, forget: () => undefined },
        moveDevice: () => Promise.resolve(),
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

describe("ProgramManager — log lines of the start and of card changes", () => {
  const infos = (w: ReturnType<typeof world>): string[] => w.a.logs.filter(l => l.level === "info").map(l => l.msg);

  it("names at the start in one info line which programs are asked and which are switched off", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    await w.manager().start([row("qbittorrent", "a", "h1"), row("sabnzbd", "b", "h2", { enabled: false })]);
    await flush();
    expect(infos(w)).toEqual(["1 program(s) asked: qbittorrent-a — switched off: sabnzbd-b"]);
  });

  it("says at the start when no program is configured — and when every program is switched off", async () => {
    expect(startLine([])).toBe("no program configured — add one on the settings page of the instance");
    const w = world({});
    await w.manager().start([row("qbittorrent", "a", "h1", { enabled: false })]);
    expect(infos(w)).toEqual(["0 program(s) asked — switched off: qbittorrent-a"]);
  });

  it("writes the first answer of a program added on its card on info", async () => {
    const w = world({ h1: { snapshot: snap(0) }, h2: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    await m.apply([row("qbittorrent", "a", "h1"), row("sabnzbd", "b", "h2")]);
    await flush();
    expect(infos(w)).toContain("sabnzbd-b: answering (SABnzbd 1.0)");
    expect(infos(w).some(l => l.startsWith("qbittorrent-a: answering"))).toBe(false);
  });

  it("writes no answer line when the adapter itself stored the rows (learned My.JDownloader id)", async () => {
    const w = world({ h1: { snapshot: snap(0) }, h9: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    await m.apply([row("qbittorrent", "a", "h9")], new Map(), false);
    await flush();
    expect(infos(w).some(l => l.includes("answering"))).toBe(false);
  });

  it("writes no answer line for a program the adapter moved to its new id — the move has its own line", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1", { id: "qbittorrent-old" })]);
    await flush();
    await m.apply(
      [row("qbittorrent", "a", "h1", { id: "qbittorrent-new" })],
      new Map([["qbittorrent-old", "qbittorrent-new"]]),
    );
    await flush();
    expect(infos(w).some(l => l.includes("answering"))).toBe(false);
  });

  it("says on info that a deleted program went and how many datapoints — also for one whose login was rejected", async () => {
    const w = world({ h1: { error: new AuthError("401") } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    const states = [...w.a.objects].filter(([id, o]) => id.startsWith(`${NS}.qbittorrent-a.`) && o.type === "state");
    await m.apply([]);
    await flush();
    expect(infos(w)).toContain(`qbittorrent-a: deleted — removed ${states.length} datapoint(s)`);
    expect(states.length).toBeGreaterThan(0);
    expect(w.resolved).toContain("auth:qbittorrent-a");
    expect(infos(w).some(l => l.includes("asked again"))).toBe(false);
  });

  it("says on info that a program was switched off on its card — editing the switched-off card changes nothing", async () => {
    const w = world({ h1: { snapshot: snap(0) } });
    const m = w.manager();
    await m.start([row("qbittorrent", "a", "h1")]);
    await flush();
    await m.apply([row("qbittorrent", "a", "h1", { enabled: false })]);
    await m.apply([row("qbittorrent", "a", "h1", { enabled: false, name: "renamed" })]);
    expect(infos(w).filter(l => l.includes("switched off —"))).toEqual([
      "qbittorrent-a: switched off — the program is no longer asked",
    ]);
  });
});
