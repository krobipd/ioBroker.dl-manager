import { EmulatedPause, memoryPauseStore, type PauseState } from "./emulated-pause";

describe("EmulatedPause (plan § 5.3)", () => {
  it("stops what runs and remembers exactly those", async () => {
    const store = memoryPauseStore();
    const p = new EmulatedPause(store);
    const stopped: string[][] = [];
    await p.pause(["a", "b"], keys => {
      stopped.push(keys);
      return Promise.resolve(keys);
    });
    expect(stopped).toEqual([["a", "b"]]);
    expect(await store.load()).toEqual({ paused: true, keys: ["a", "b"] });
    expect(await p.observe(new Set())).toBe(true);
  });

  it("resumes only the remembered ones, never those the user had paused before", async () => {
    const store = memoryPauseStore({ paused: true, keys: ["a"] });
    const started: string[][] = [];
    await new EmulatedPause(store).resume(keys => {
      started.push(keys);
      return Promise.resolve();
    });
    expect(started).toEqual([["a"]]);
    expect(await store.load()).toEqual({ paused: false, keys: [] });
  });

  it("is paused even when nothing ran — new downloads must then be added stopped", async () => {
    const p = new EmulatedPause(memoryPauseStore());
    await p.pause([], keys => Promise.resolve(keys));
    expect(await p.isPaused()).toBe(true);
  });

  it("falls back to not paused when the user starts one of them in the program itself", async () => {
    const store = memoryPauseStore({ paused: true, keys: ["a", "b"] });
    const p = new EmulatedPause(store);
    expect(await p.observe(new Set(["b"]))).toBe(false);
    expect(await store.load()).toEqual({ paused: false, keys: [] });
  });

  it("survives a restart through its store and writes only on a change", async () => {
    const saved: PauseState[] = [];
    const store = {
      load: () => Promise.resolve({ paused: true, keys: ["x"] }),
      save: (s: PauseState): Promise<void> => {
        saved.push(s);
        return Promise.resolve();
      },
    };
    const p = new EmulatedPause(store);
    expect(await p.observe(new Set())).toBe(true);
    expect(await p.observe(new Set())).toBe(true);
    expect(saved).toEqual([]);
  });

  it("a second pause stops only what is new, and nothing is stopped or started for nothing", async () => {
    const store = memoryPauseStore();
    const p = new EmulatedPause(store);
    const calls: string[][] = [];
    const record = (keys: string[]): Promise<string[]> => {
      calls.push(keys);
      return Promise.resolve(keys);
    };
    await p.pause([], record);
    expect(calls).toEqual([]);
    await p.pause(["a"], record);
    await p.pause(["a", "b"], record);
    expect(calls).toEqual([["a"], ["b"]]);
    expect(await store.load()).toEqual({ paused: true, keys: ["a", "b"] });
    const idle = new EmulatedPause(memoryPauseStore({ paused: true, keys: [] }));
    await idle.resume(async keys => {
      await record(keys);
    });
    expect(calls).toHaveLength(2);
  });

  it("survives the poll right after the pause, while the program still lists the downloads as running (final review I2)", async () => {
    const store = memoryPauseStore();
    const p = new EmulatedPause(store);
    await p.pause(["a"], keys => Promise.resolve(keys));
    expect(await p.observe(new Set(["a"]))).toBe(true);
    expect(await p.observe(new Set(["a"]))).toBe(false);
  });

  it("is not paused while nobody paused it", async () => {
    const p = new EmulatedPause(memoryPauseStore());
    expect(await p.observe(new Set(["x"]))).toBe(false);
  });

  it("forgets keys the program no longer lists", async () => {
    const store = memoryPauseStore({ paused: true, keys: ["gone", "a"] });
    const p = new EmulatedPause(store);
    await p.observe(new Set(), new Set(["a"]));
    expect(await store.load()).toEqual({ paused: true, keys: ["a"] });
  });
  it("remembers only what the program really stopped — one that ended meanwhile does not lose the others (review B7)", async () => {
    const store = memoryPauseStore();
    await new EmulatedPause(store).pause(["a", "done", "b"], keys => Promise.resolve(keys.filter(k => k !== "done")));
    expect(await store.load()).toEqual({ paused: true, keys: ["a", "b"] });
  });

  it("resumes a download added stopped during the pause with the others (review B6)", async () => {
    const store = memoryPauseStore();
    const p = new EmulatedPause(store);
    await p.hold("x");
    expect(await store.load()).toEqual({ paused: false, keys: [] });
    await p.pause(["a"], keys => Promise.resolve(keys));
    await p.hold("n");
    await p.hold("n");
    expect(await store.load()).toEqual({ paused: true, keys: ["a", "n"] });
    const started: string[][] = [];
    await p.resume(keys => {
      started.push(keys);
      return Promise.resolve();
    });
    expect(started).toEqual([["a", "n"]]);
  });

  it("takes the next new stopped downloads when the program names no key — as many as were added, never a running one (review B6)", async () => {
    const store = memoryPauseStore();
    const p = new EmulatedPause(store);
    await p.observe(new Set(), new Set(["old"]));
    await p.pause([], keys => Promise.resolve(keys));
    await p.holdNext();
    await p.observe(new Set(), new Set(["old"]));
    expect(await store.load()).toEqual({ paused: true, keys: [] });
    await p.observe(new Set(["run"]), new Set(["old", "run", "new", "other"]));
    expect(await store.load()).toEqual({ paused: true, keys: ["new"] });
    await p.observe(new Set(), new Set(["old", "run", "new", "other", "later"]));
    expect(await store.load()).toEqual({ paused: true, keys: ["new"] });
  });

  it("expects nothing outside the pause and forgets an expected download when the pause ends (review B6)", async () => {
    const store = memoryPauseStore();
    const p = new EmulatedPause(store);
    await p.observe(new Set(), new Set());
    await p.holdNext();
    await p.pause([], keys => Promise.resolve(keys));
    await p.observe(new Set(), new Set(["early"]));
    expect(await store.load()).toEqual({ paused: true, keys: [] });
    await p.holdNext();
    await p.resume(() => Promise.resolve());
    await p.pause([], keys => Promise.resolve(keys));
    await p.observe(new Set(), new Set(["early", "mine"]));
    expect(await store.load()).toEqual({ paused: true, keys: [] });
  });
});
