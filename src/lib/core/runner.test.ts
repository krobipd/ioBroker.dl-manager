import type { Mock } from "vitest";
import { AuthError, ProtocolError, UnreachableError } from "./errors";
import type { Command, ProgramDriver, ProgramSnapshot } from "./model";
import { ProgramRunner, WARN_COOLDOWN_MS, WARN_MEMORY, type RunnerDeps, type RunnerTree } from "./runner";
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
    problems: { report: key => void reported.push(key) },
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
    expect(onChange).toHaveBeenCalledWith(NO_EVENTS, true);
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
    expect(deps.reported).toEqual(["auth:fake-a"]);
    expect(deps.lines.filter(l => l.level === "warn")).toHaveLength(0);
    expect(tree.markOffline).toHaveBeenCalledWith("401 Unauthorized");
  });

  it("after a rejected login neither schedules nor answers a poll request", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() => Promise.reject(new AuthError("401")));
    const r = new ProgramRunner("fake-a", driver, makeTree(), makeDeps(clock), 10_000, vi.fn());
    r.start();
    await flush();
    expect(clock.timers.size).toBe(0);
    await r.pollNow();
    expect(driver.polls).toBe(1);
  });

  it("drops a poll that finishes after stop", async () => {
    const clock = new ManualClock();
    let release: (s: ProgramSnapshot) => void = () => undefined;
    const driver = makeDriver(() => new Promise<ProgramSnapshot>(resolve => (release = resolve)));
    const tree = makeTree();
    const onChange = vi.fn();
    const r = new ProgramRunner("fake-a", driver, tree, makeDeps(clock), 10_000, onChange);
    r.start();
    await flush();
    const stopping = r.stop();
    release(SNAP);
    await stopping;
    await flush();
    expect(tree.sync).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stop waits for a tree write in progress and leaves the program Unknown (final review I1)", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() => Promise.resolve(SNAP));
    const tree = makeTree();
    const order: string[] = [];
    let release: () => void = () => undefined;
    tree.sync.mockImplementation(
      () =>
        new Promise<ProgramEvents>(resolve => {
          release = () => {
            order.push("sync");
            resolve(NO_EVENTS);
          };
        }),
    );
    tree.markOffline.mockImplementation(reason => {
      order.push(`offline:${reason}`);
      return Promise.resolve();
    });
    const r = new ProgramRunner("fake-a", driver, tree, makeDeps(clock), 10_000, vi.fn());
    r.start();
    await flush();
    const stopping = r.stop();
    await flush();
    release();
    await stopping;
    expect(order.at(-1)).toBe("offline:Unknown");
  });

  it("a poll that fails because stop closed the driver writes no reason of its own (final review I1)", async () => {
    const clock = new ManualClock();
    let fail: (e: Error) => void = () => undefined;
    const driver = makeDriver(() => new Promise<ProgramSnapshot>((_resolve, reject) => (fail = reject)));
    const tree = makeTree();
    const deps = makeDeps(clock);
    const r = new ProgramRunner("fake-a", driver, tree, deps, 10_000, vi.fn());
    r.start();
    await flush();
    const stopping = r.stop();
    fail(new UnreachableError("no answer within 10 s"));
    await stopping;
    await flush();
    expect(tree.markOffline.mock.calls.map(c => c[0])).toEqual(["Unknown"]);
  });

  it("warns the same problem once an hour — also when good polls come in between (no flapping in the log)", async () => {
    const clock = new ManualClock();
    let now = 0;
    let fail = true;
    const driver = makeDriver(() => (fail ? Promise.reject(new ProtocolError("bad answer")) : Promise.resolve(SNAP)));
    const deps = { ...makeDeps(clock), now: () => now };
    const r = new ProgramRunner("fake-a", driver, makeTree(), deps, 10_000, vi.fn());
    r.start();
    await flush();
    fail = false;
    await clock.tick();
    fail = true;
    now = WARN_COOLDOWN_MS - 1;
    await clock.tick();
    expect(deps.lines.filter(l => l.level === "warn").map(l => l.msg)).toEqual(["fake-a: bad answer"]);
    expect(deps.lines.filter(l => l.level === "debug").map(l => l.msg)).toContain("[fake-a] bad answer");
    now = WARN_COOLDOWN_MS;
    await clock.tick();
    expect(deps.lines.filter(l => l.level === "warn")).toHaveLength(2);
  });

  it("forgets the oldest text once it remembers the most — that text warns again inside the window", async () => {
    const clock = new ManualClock();
    let n = 0;
    const driver = makeDriver(() => Promise.reject(new ProtocolError(`answer ${n}`)));
    const deps = { ...makeDeps(clock), now: () => 0 };
    const r = new ProgramRunner("fake-a", driver, makeTree(), deps, 10_000, vi.fn());
    r.start();
    await flush();
    for (n = 1; n <= WARN_MEMORY; n++) {
      await clock.tick();
    }
    n = 0;
    await clock.tick();
    const warns = deps.lines.filter(l => l.level === "warn").map(l => l.msg);
    expect(warns).toHaveLength(WARN_MEMORY + 2);
    expect(warns.at(-1)).toBe("fake-a: answer 0");
  });

  it("warns a different problem at once", async () => {
    const clock = new ManualClock();
    let text = "bad answer";
    const driver = makeDriver(() => Promise.reject(new ProtocolError(text)));
    const deps = { ...makeDeps(clock), now: () => 0 };
    const r = new ProgramRunner("fake-a", driver, makeTree(), deps, 10_000, vi.fn());
    r.start();
    await flush();
    text = "other answer";
    await clock.tick();
    expect(deps.lines.filter(l => l.level === "warn").map(l => l.msg)).toEqual([
      "fake-a: bad answer",
      "fake-a: other answer",
    ]);
  });

  it("reports an empty change after a failed poll, so the summary sees the program go offline", async () => {
    const clock = new ManualClock();
    const driver = makeDriver(() => Promise.reject(new UnreachableError("timeout")));
    const onChange = vi.fn();
    const r = new ProgramRunner("fake-a", driver, makeTree(), makeDeps(clock), 10_000, onChange);
    r.start();
    await flush();
    expect(onChange).toHaveBeenCalledWith(NO_EVENTS, false);
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

describe("ProgramRunner — result of a card change and the login warning", () => {
  it("writes the first answer after a card change on info, once, with product and version", async () => {
    const clock = new ManualClock();
    const deps = makeDeps(clock);
    const r = new ProgramRunner(
      "fake-a",
      makeDriver(() => Promise.resolve(SNAP)),
      makeTree(),
      deps,
      10_000,
      vi.fn(),
    );
    r.announceNextResult("Fake");
    r.start();
    await flush();
    await clock.tick();
    expect(deps.lines.filter(l => l.level === "info").map(l => l.msg)).toEqual(["fake-a: answering (Fake 1)"]);
  });

  it("writes no answer line without a card change — reaching a program again is a state (debug)", async () => {
    const clock = new ManualClock();
    const deps = makeDeps(clock);
    const r = new ProgramRunner(
      "fake-a",
      makeDriver(() => Promise.resolve(SNAP)),
      makeTree(),
      deps,
      10_000,
      vi.fn(),
    );
    r.start();
    await flush();
    expect(deps.lines.filter(l => l.level === "info")).toHaveLength(0);
    expect(deps.lines.map(l => l.msg)).toContain("[fake-a] reachable");
    expect(deps.lines.map(l => l.msg)).toContain("[fake-a] polled: 0 download(s)");
  });

  it("leaves the product version out when the program names none", async () => {
    const clock = new ManualClock();
    const deps = makeDeps(clock);
    const snap = { ...SNAP, status: { ...SNAP.status, version: "" }, complete: false };
    const r = new ProgramRunner(
      "fake-a",
      makeDriver(() => Promise.resolve(snap)),
      makeTree(),
      deps,
      10_000,
      vi.fn(),
    );
    r.announceNextResult("Fake");
    r.start();
    await flush();
    expect(deps.lines.filter(l => l.level === "info").map(l => l.msg)).toEqual(["fake-a: answering (Fake)"]);
    expect(deps.lines.map(l => l.msg)).toContain("[fake-a] polled: 0 download(s), lists incomplete");
  });

  it("writes an unreachable program after a card change on info — later misses stay on debug", async () => {
    const clock = new ManualClock();
    const deps = makeDeps(clock);
    const driver = makeDriver(() => Promise.reject(new UnreachableError("timeout")));
    const r = new ProgramRunner("fake-a", driver, makeTree(), deps, 10_000, vi.fn());
    r.announceNextResult("Fake");
    r.start();
    await flush();
    await clock.tick();
    expect(deps.lines.filter(l => l.level === "info").map(l => l.msg)).toEqual(["fake-a: not reachable — timeout"]);
    expect(deps.lines.filter(l => l.level === "debug").map(l => l.msg)).toContain("[fake-a] not reachable: timeout");
  });

  it("warns a failure after a card change even inside the warn window of the same text", async () => {
    const clock = new ManualClock();
    const deps = { ...makeDeps(clock), now: () => 0 };
    const driver = makeDriver(() => Promise.reject(new ProtocolError("bad answer")));
    const r = new ProgramRunner("fake-a", driver, makeTree(), deps, 10_000, vi.fn());
    r.start();
    await flush();
    r.announceNextResult("Fake");
    await clock.tick();
    expect(deps.lines.filter(l => l.level === "warn")).toHaveLength(2);
  });

  it("names in the login warning what the card holds, and the action of its dialog", async () => {
    const clock = new ManualClock();
    const reports: [string, string, string][] = [];
    const deps = {
      ...makeDeps(clock),
      problems: { report: (k: string, t: string, a: string) => void reports.push([k, t, a]) },
    };
    const driver = makeDriver(() => Promise.reject(new AuthError("transmission: login rejected")));
    const hint = { cause: "no login is set on its card", action: "switch on the login on its card" };
    const r = new ProgramRunner("tr-a", driver, makeTree(), deps, 10_000, vi.fn(), hint);
    r.announceNextResult("Transmission");
    r.start();
    await flush();
    expect(reports).toEqual([
      [
        "auth:tr-a",
        "tr-a: transmission: login rejected (no login is set on its card) — not asked again until its card changes",
        "switch on the login on its card",
      ],
    ]);
    expect(deps.lines.filter(l => l.level === "info")).toHaveLength(0);
    await expect(r.command({ kind: "pauseAll" })).rejects.toThrow(
      "tr-a: the program refused the login — switch on the login on its card",
    );
  });

  it("leaves the cause out when the card holds a login", async () => {
    const clock = new ManualClock();
    const titles: string[] = [];
    const deps = { ...makeDeps(clock), problems: { report: (_k: string, t: string) => void titles.push(t) } };
    const driver = makeDriver(() => Promise.reject(new AuthError("401")));
    const r = new ProgramRunner("q-a", driver, makeTree(), deps, 10_000, vi.fn(), { action: "check it" });
    r.start();
    await flush();
    expect(titles).toEqual(["q-a: 401 — not asked again until its card changes"]);
  });
});
