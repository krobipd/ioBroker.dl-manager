vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import { FakeAdapter } from "../../../test/helpers/fake-adapter";
import type { DriverDeps, ProgramConfig, ProgramEntry } from "../programs/registry";
import { AuthError, UnreachableError } from "./errors";
import { ProgramManager } from "./manager";
import type { Capability, Command, DownloadItem, ProgramDriver, ProgramSnapshot } from "./model";

const NS = "download-manager.0";
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

function world(behaviour: Record<string, Behaviour>): {
  a: FakeAdapter;
  drivers: FakeDriver[];
  manager: (opts?: { removeFinished?: boolean }) => ProgramManager;
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
        capabilities: new Set(caps),
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
  const entries: Record<string, ProgramEntry> = { qbittorrent: entry("qbittorrent"), sabnzbd: entry("sabnzbd") };
  const manager = (opts: { removeFinished?: boolean } = {}): ProgramManager =>
    new ProgramManager(
      {
        adapter: a,
        timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
        find: type => entries[type],
        decrypt: v => v,
        problems: { report: key => void reported.push(key), resolve: () => undefined },
      },
      { intervalMs: 10_000, removeFinished: opts.removeFinished === true },
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
    await seedDevice(w.a, "qbittorrent-old", { address: "http://h1" });
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

describe("ProgramManager — connection test and stop", () => {
  it("asks every program of the unsaved form once and closes the test drivers", async () => {
    const w = world({
      h1: { snapshot: snap(0, [item("x", "queued")]) },
      h2: { error: new AuthError("401 Unauthorized") },
    });
    const text = await w
      .manager()
      .testConnections([
        row("qbittorrent", "a", "h1"),
        row("sabnzbd", "b", "h2"),
        row("qbittorrent", "c", ""),
        row("qbittorrent", "d", "h1", { enabled: false }),
      ]);
    expect(w.drivers.map(d => d.polls)).toEqual([1, 1]);
    expect(w.drivers.every(d => d.closed)).toBe(true);
    expect(text.split("\n")).toEqual([
      "qbittorrent-a: OK — version 1.0, 1 download(s)",
      "sabnzbd-b: login rejected — 401 Unauthorized",
      "qbittorrent-c: host missing",
    ]);
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
});
