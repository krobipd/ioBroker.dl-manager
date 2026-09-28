import { EmulatedPause, memoryPauseStore, type PauseState } from "./emulated-pause";

describe("EmulatedPause (plan § 5.3)", () => {
  it("stops what runs and remembers exactly those", async () => {
    const store = memoryPauseStore();
    const p = new EmulatedPause(store);
    const stopped: string[][] = [];
    await p.pause(["a", "b"], keys => {
      stopped.push(keys);
      return Promise.resolve();
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
    await p.pause([], () => Promise.resolve());
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

  it("forgets keys the program no longer lists", async () => {
    const store = memoryPauseStore({ paused: true, keys: ["gone", "a"] });
    const p = new EmulatedPause(store);
    await p.observe(new Set(), new Set(["a"]));
    expect(await store.load()).toEqual({ paused: true, keys: ["a"] });
  });
});
