import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiCounterpart } from "../api-limits";
import { BUDGET_FILE, CallBudget, readHeldPlaces, writeHeldPlaces, type CallPlace } from "./call-budget";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};

const declared: ApiCounterpart[] = [
  { name: "local", match: { network: "private" }, limits: [{ max: 2, seconds: 60, per: "host", source: "test" }] },
  {
    name: "cloud",
    match: { host: "cloud.example" },
    limits: [
      { max: 3, seconds: 60, per: "account", source: "burst" },
      { max: 2, seconds: 60, per: "account", source: "average" },
      { max: 5, seconds: 3600, per: "account", source: "hour" },
    ],
  },
];

/**
 * @param promise a wait for a place
 * @returns whether it has settled after the pending microtasks ran
 */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CallBudget", () => {
  const signal = new AbortController().signal;

  it("lets max calls through and frees a place a window's length after its answer", async () => {
    const budget = new CallBudget(declared);
    const a = await budget.take("local", "nas", timers, signal);
    budget.sent(a);
    const b = await budget.take("local", "nas", timers, signal);
    await vi.advanceTimersByTimeAsync(500);
    budget.settle(a, true);
    budget.settle(b, true);
    const third = budget.take("local", "nas", timers, signal);
    expect(await settled(third)).toBe(false);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await settled(third)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(third)).toBe(true);
    expect((await third).sentAt).toBe(1_060_500);
  });

  it("frees the place of a call without an answer a window's length after its send", async () => {
    const budget = new CallBudget(declared);
    const a = await budget.take("local", "nas", timers, signal);
    await budget.take("local", "nas", timers, signal).then(b => budget.settle(b, false));
    await vi.advanceTimersByTimeAsync(10_000);
    budget.settle(a, false);
    // a second settle changes nothing — a socket reports its error and then its close
    budget.settle(a, true);
    const third = budget.take("local", "nas", timers, signal);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(await settled(third)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(third)).toBe(true);
    // a's place is free as well: its second settle did not move it
    expect(await settled(budget.take("local", "nas", timers, signal))).toBe(true);
  });

  it("holds the place of an open call until it settles, then a window's length after", async () => {
    const budget = new CallBudget(declared);
    const a = await budget.take("local", "nas", timers, signal);
    const b = await budget.take("local", "nas", timers, signal);
    budget.settle(b, true);
    // the answered call frees its place after the window, the open one keeps its own
    const third = budget.take("local", "nas", timers, signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled(third)).toBe(true);
    const fourth = budget.take("local", "nas", timers, signal);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await settled(fourth)).toBe(false);
    budget.settle(a, true);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await settled(fourth)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(fourth)).toBe(true);
  });

  it("gives every host its own lane and the account one for every call", async () => {
    const budget = new CallBudget(declared);
    for (const host of ["nas", "nas", "pc", "pc"]) {
      await budget.take("local", host, timers, signal);
    }
    expect(await settled(budget.take("local", "pc", timers, signal))).toBe(false);
    expect(await settled(budget.take("local", "seedbox", timers, signal))).toBe(true);
    await budget.take("cloud", "cloud.example", timers, signal);
    await budget.take("cloud", "other.example", timers, signal);
    expect(await settled(budget.take("cloud", "cloud.example", timers, signal))).toBe(false);
  });

  it("keeps the strictest entry of a window and every window at once", async () => {
    const budget = new CallBudget(declared);
    const places: CallPlace[] = [];
    for (let i = 0; i < 2; i++) {
      places.push(await budget.take("cloud", "cloud.example", timers, signal));
    }
    places.forEach(p => budget.settle(p, true));
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 2; i++) {
      budget.settle(await budget.take("cloud", "cloud.example", timers, signal), true);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    budget.settle(await budget.take("cloud", "cloud.example", timers, signal), true);
    await vi.advanceTimersByTimeAsync(60_000);
    // five within the hour: the sixth waits for the hour of the first, not for the minute
    const sixth = budget.take("cloud", "cloud.example", timers, signal);
    await vi.advanceTimersByTimeAsync(3_600_000 - 180_001);
    expect(await settled(sixth)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(sixth)).toBe(true);
  });

  it("waits for as many places to free as the window holds over its limit", async () => {
    // the previous process left three places, the limit of this one is two (a lowered limit after a restart)
    const budget = new CallBudget(declared);
    budget.takeOver([{ counterpart: "local", seconds: 60, lane: "nas", times: [950_000, 960_000, 970_000] }]);
    const next = budget.take("local", "nas", timers, signal);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(await settled(next)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(next)).toBe(true);
  });

  it("gives up a wait when its signal aborts", async () => {
    const budget = new CallBudget(declared);
    await budget.take("local", "nas", timers, signal);
    await budget.take("local", "nas", timers, signal);
    const quit = new AbortController();
    const third = budget.take("local", "nas", timers, quit.signal);
    const outcome = third.then(
      () => "taken",
      () => "aborted",
    );
    quit.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe("aborted");
  });

  it("names a counterpart the declaration does not know", async () => {
    await expect(new CallBudget(declared).take("nowhere", "nas", timers, signal)).rejects.toThrow(/'nowhere'/);
  });

  it("hands its places to the next process, which holds them like answered calls", async () => {
    const before = new CallBudget(declared);
    const a = await before.take("local", "nas", timers, signal);
    before.settle(a, true);
    await vi.advanceTimersByTimeAsync(20_000);
    await before.take("local", "nas", timers, signal);
    // the call still on its way at the stop counts from the stop
    await vi.advanceTimersByTimeAsync(5_000);
    const held = before.handOver();
    expect(held).toEqual([{ counterpart: "local", seconds: 60, lane: "nas", times: [1_000_000, 1_025_000] }]);
    const after = new CallBudget(declared);
    after.takeOver(held);
    const next = after.take("local", "nas", timers, signal);
    await vi.advanceTimersByTimeAsync(34_999);
    expect(await settled(next)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(next)).toBe(true);
    // what it took over counts once
    expect(after.handOver()).toEqual([
      { counterpart: "local", seconds: 60, lane: "nas", times: [1_025_000, 1_060_000] },
    ]);
    // what it took over and never used goes on to the process after it
    const third = new CallBudget(declared);
    third.takeOver([{ counterpart: "cloud", seconds: 60, lane: "", times: [Date.now() - 1000] }]);
    expect(third.handOver()).toEqual([{ counterpart: "cloud", seconds: 60, lane: "", times: [Date.now() - 1000] }]);
  });
});

describe("held places file", () => {
  it("keeps what still counts and reads nothing from a missing or broken file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-budget-"));
    try {
      const data = join(dir, "sub");
      const file = join(data, BUDGET_FILE);
      expect(readHeldPlaces(data, 100_000)).toEqual([]);
      writeHeldPlaces(data, [{ counterpart: "local", seconds: 60, lane: "nas", times: [30_000, 50_000] }]);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        held: [{ counterpart: "local", seconds: 60, lane: "nas", times: [30_000, 50_000] }],
      });
      expect(readHeldPlaces(data, 100_000)).toEqual([
        { counterpart: "local", seconds: 60, lane: "nas", times: [50_000] },
      ]);
      writeFileSync(
        file,
        JSON.stringify({
          held: [
            { counterpart: 1, seconds: 60, lane: "", times: [99_000] },
            { counterpart: "s", seconds: "60", lane: "", times: [99_000] },
            { counterpart: "l", seconds: 60, times: [99_000] },
            { counterpart: "z", seconds: 60, lane: "", times: [1_000] },
            { counterpart: "x", seconds: 60, lane: "", times: ["a", 99_000, 200_000] },
          ],
        }),
      );
      expect(readHeldPlaces(data, 100_000)).toEqual([{ counterpart: "x", seconds: 60, lane: "", times: [99_000] }]);
      for (const text of ["{", "null", "{}", '{"held":5}']) {
        writeFileSync(file, text);
        expect(readHeldPlaces(data, 100_000)).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
