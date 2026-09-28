import type { Mock } from "vitest";
import { AuthError, ProtocolError, UnreachableError } from "./errors";
import type { Command, ProgramDriver, ProgramSnapshot } from "./model";
import { ProgramRunner, type RunnerDeps, type RunnerTree } from "./runner";
import type { ProgramEvents } from "./tree";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

class ManualClock {
  private seq = 0;
  public readonly timers = new Map<number, () => void>();
  public setTimeout = (cb: () => void): ioBroker.Timeout => {
    const id = ++this.seq;
    this.timers.set(id, cb);
    return id as unknown as ioBroker.Timeout;
  };
  public clearTimeout = (t: ioBroker.Timeout | undefined): void => {
    this.timers.delete(t as unknown as number);
  };
  /** Fires every pending timer once. */
  public async tick(): Promise<void> {
    const due = [...this.timers.entries()];
    this.timers.clear();
    for (const [, cb] of due) {
      cb();
    }
    await flush();
  }
}

const SNAP: ProgramSnapshot = { status: { version: "1", paused: false, downloadBps: 0 }, items: [], complete: true };
const NO_EVENTS: ProgramEvents = { finished: [], failed: [], removedFromTree: 0 };

function makeDriver(poll: () => Promise<ProgramSnapshot>): ProgramDriver & { polls: number; commands: Command[] } {
  const d = {
    type: "fake",
    capabilities: new Set<never>(),
    extras: [],
    polls: 0,
    commands: [] as Command[],
    poll: async (): Promise<ProgramSnapshot> => {
      d.polls++;
      return poll();
    },
    command: (cmd: Command): Promise<void> => {
      d.commands.push(cmd);
      return Promise.resolve();
    },
    close: (): Promise<void> => Promise.resolve(),
  };
  return d;
}

function makeTree(): {
  sync: Mock<RunnerTree["sync"]>;
  markOffline: Mock<RunnerTree["markOffline"]>;
} {
  return {
    sync: vi.fn<RunnerTree["sync"]>(() => Promise.resolve(NO_EVENTS)),
    markOffline: vi.fn<RunnerTree["markOffline"]>(() => Promise.resolve()),
  };
}

function makeDeps(clock: ManualClock): RunnerDeps & {
  lines: { level: string; msg: string }[];
  reported: string[];
} {
  const lines: { level: string; msg: string }[] = [];
  const reported: string[] = [];
  return {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    log: {
      debug: m => void lines.push({ level: "debug", msg: m }),
      info: m => void lines.push({ level: "info", msg: m }),
      warn: m => void lines.push({ level: "warn", msg: m }),
    },
    problems: { report: key => void reported.push(key), resolve: () => undefined },
    lines,
    reported,
  };
}

describe("ProgramRunner", () => {
  it("polls at once, then on every interval, and hands the events on", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() => Promise.resolve(SNAP));
    const tree = makeTree();
    const onChange = vi.fn();
    const r = new ProgramRunner("fake-a", driver, tree, makeDeps(clock), 10_000, onChange);
    r.start();
    await flush();
    expect(driver.polls).toBe(1);
    expect(tree.sync).toHaveBeenCalledWith(SNAP);
    expect(onChange).toHaveBeenCalledWith(NO_EVENTS);
    expect(r.online).toBe(true);
    await clock.tick();
    expect(driver.polls).toBe(2);
  });

  it("stops calling the program after one rejected login", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() => Promise.reject(new AuthError("401 Unauthorized")));
    const tree = makeTree();
    const deps = makeDeps(clock);
    const r = new ProgramRunner("fake-a", driver, tree, deps, 10_000, vi.fn());
    r.start();
    await flush();
    await clock.tick();
    await clock.tick();
    expect(driver.polls).toBe(1);
    expect(r.lockedByAuth).toBe(true);
    expect(deps.reported).toEqual(["auth:fake-a"]);
    expect(deps.lines.filter(l => l.level === "warn")).toHaveLength(1);
    expect(tree.markOffline).toHaveBeenCalledWith("401 Unauthorized");
  });

  it("refuses commands while the login is rejected", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() => Promise.reject(new AuthError("401")));
    const r = new ProgramRunner("fake-a", driver, makeTree(), makeDeps(clock), 10_000, vi.fn());
    r.start();
    await flush();
    await expect(r.command({ kind: "pauseAll" })).rejects.toThrow(/login/);
    expect(driver.commands).toHaveLength(0);
  });

  it("marks offline without an info or warn line on a network error, and keeps asking", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() => Promise.reject(new UnreachableError("connect ECONNREFUSED")));
    const tree = makeTree();
    const deps = makeDeps(clock);
    const r = new ProgramRunner("fake-a", driver, tree, deps, 10_000, vi.fn());
    r.start();
    await flush();
    await clock.tick();
    expect(r.online).toBe(false);
    expect(driver.polls).toBe(2);
    expect(deps.lines.filter(l => l.level !== "debug")).toHaveLength(0);
    expect(tree.markOffline).toHaveBeenCalledWith("connect ECONNREFUSED");
  });

  it("warns once for a repeated protocol error, then only debug", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() => Promise.reject(new ProtocolError("unexpected answer")));
    const deps = makeDeps(clock);
    const r = new ProgramRunner("fake-a", driver, makeTree(), deps, 10_000, vi.fn());
    r.start();
    await flush();
    await clock.tick();
    await clock.tick();
    expect(deps.lines.filter(l => l.level === "warn")).toHaveLength(1);
    expect(deps.lines.filter(l => l.level === "debug" && l.msg.includes("unexpected answer")).length).toBeGreaterThan(
      0,
    );
  });

  it("keeps running when the tree throws, and another runner is untouched", async () => {
    const clock = new ManualClock();
    const badTree = makeTree();
    badTree.sync.mockImplementation(() => Promise.reject(new TypeError("boom")));
    const good = makeDriver(() => Promise.resolve(SNAP));
    const bad = makeDriver(() => Promise.resolve(SNAP));
    const r1 = new ProgramRunner("bad", bad, badTree, makeDeps(clock), 10_000, vi.fn());
    const r2 = new ProgramRunner("good", good, makeTree(), makeDeps(clock), 10_000, vi.fn());
    r1.start();
    r2.start();
    await flush();
    await clock.tick();
    expect(bad.polls).toBe(2);
    expect(good.polls).toBe(2);
    expect(r2.online).toBe(true);
  });

  it("never runs two polls at once", async () => {
    const clock = new ManualClock();
    let release: () => void = () => undefined;
    const driver = makeDriver(
      () =>
        new Promise<ProgramSnapshot>(resolve => {
          release = () => resolve(SNAP);
        }),
    );
    const r = new ProgramRunner("fake-a", driver, makeTree(), makeDeps(clock), 10_000, vi.fn());
    r.start();
    await flush();
    const second = r.pollNow();
    await flush();
    expect(driver.polls).toBe(1);
    release();
    await second;
    expect(driver.polls).toBe(1);
  });

  it("polls immediately after a command", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() => Promise.resolve(SNAP));
    const r = new ProgramRunner("fake-a", driver, makeTree(), makeDeps(clock), 10_000, vi.fn());
    r.start();
    await flush();
    await r.command({ kind: "pause", key: "k1" });
    await flush();
    expect(driver.commands).toEqual([{ kind: "pause", key: "k1" }]);
    expect(driver.polls).toBe(2);
  });

  it("stop clears the timer, closes the driver and marks the program Unknown", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() => Promise.resolve(SNAP));
    const close = vi.spyOn(driver, "close");
    const tree = makeTree();
    const r = new ProgramRunner("fake-a", driver, tree, makeDeps(clock), 10_000, vi.fn());
    r.start();
    await flush();
    await r.stop();
    expect(clock.timers.size).toBe(0);
    expect(close).toHaveBeenCalled();
    expect(tree.markOffline).toHaveBeenLastCalledWith("Unknown");
    await clock.tick();
    expect(driver.polls).toBe(1);
  });

  it("uses a push notification only to poll at once", async () => {
    const clock = new ManualClock();
    let push: () => void = () => undefined;
    const driver = makeDriver(() => Promise.resolve(SNAP));
    driver.subscribe = (cb: () => void): (() => void) => {
      push = cb;
      return () => undefined;
    };
    const r = new ProgramRunner("fake-a", driver, makeTree(), makeDeps(clock), 10_000, vi.fn());
    r.start();
    await flush();
    push();
    await flush();
    expect(driver.polls).toBe(2);
  });

  it("redacts credentials in the reason text", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() =>
      Promise.reject(new UnreachableError("GET http://u:secret@h/api?apikey=abc failed")),
    );
    const tree = makeTree();
    const r = new ProgramRunner("fake-a", driver, tree, makeDeps(clock), 10_000, vi.fn());
    r.start();
    await flush();
    expect(tree.markOffline).toHaveBeenCalledWith("GET http://***@h/api?apikey=*** failed");
  });
});
