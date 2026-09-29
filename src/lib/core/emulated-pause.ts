/** What an emulated pause has to remember across a restart. */
export interface PauseState {
  /** The adapter paused the program. */
  paused: boolean;
  /** The downloads the pause stopped — only these are resumed. */
  keys: string[];
}

/** Where the state lives (the `paused` datapoint's object `native`, written only on a change). */
export interface PauseStore {
  /** Reads the state. */
  load(): Promise<PauseState>;
  /** Writes the state. */
  save(state: PauseState): Promise<void>;
}

/**
 * @param initial starting state
 * @returns a store in memory (tests, or a program without an object yet)
 */
export function memoryPauseStore(initial: PauseState = { paused: false, keys: [] }): PauseStore {
  let state: PauseState = { paused: initial.paused, keys: [...initial.keys] };
  return {
    load: () => Promise.resolve({ paused: state.paused, keys: [...state.keys] }),
    save: s => {
      state = { paused: s.paused, keys: [...s.keys] };
      return Promise.resolve();
    },
  };
}

/**
 * A global pause for programs that do not have one (Transmission, aria2, qBittorrent < 5.3 — plan § 5.3): stop what
 * runs, remember exactly those, resume exactly those. A download the user starts in the program itself ends it.
 */
export class EmulatedPause {
  private state: PauseState | null = null;
  /** The poll right after a pause may still list the downloads as running (aria2 unregisters from trackers first). */
  private settling = false;

  /** @param store where the state survives a restart */
  public constructor(private readonly store: PauseStore) {}

  /** @returns whether the adapter holds the program paused */
  public async isPaused(): Promise<boolean> {
    return (await this.load()).paused;
  }

  /**
   * @param running keys of the downloads that run or wait now
   * @param stop stops these downloads in the program
   */
  public async pause(running: readonly string[], stop: (keys: string[]) => Promise<void>): Promise<void> {
    const s = await this.load();
    const add = running.filter(k => !s.keys.includes(k));
    if (add.length) {
      await stop(add);
    }
    this.settling = true;
    await this.write({ paused: true, keys: [...s.keys, ...add] });
  }

  /** @param start starts these downloads in the program */
  public async resume(start: (keys: string[]) => Promise<void>): Promise<void> {
    const s = await this.load();
    if (s.keys.length) {
      await start([...s.keys]);
    }
    await this.write({ paused: false, keys: [] });
  }

  /**
   * One poll's view: ends the pause when the user started a remembered download himself, forgets gone ones.
   *
   * @param running keys that run or wait now
   * @param listed every key the program lists (omit when unknown)
   * @returns whether the program counts as paused
   */
  public async observe(running: ReadonlySet<string>, listed?: ReadonlySet<string>): Promise<boolean> {
    const s = await this.load();
    if (!s.paused) {
      return false;
    }
    const settling = this.settling;
    this.settling = false;
    if (!settling && s.keys.some(k => running.has(k))) {
      await this.write({ paused: false, keys: [] });
      return false;
    }
    const kept = listed ? s.keys.filter(k => listed.has(k)) : s.keys;
    if (kept.length !== s.keys.length) {
      await this.write({ paused: true, keys: kept });
    }
    return true;
  }

  private async load(): Promise<PauseState> {
    if (!this.state) {
      const s = await this.store.load();
      this.state = { paused: s.paused, keys: [...s.keys] };
    }
    return this.state;
  }

  private async write(next: PauseState): Promise<void> {
    const s = this.state;
    if (
      s &&
      s.paused === next.paused &&
      s.keys.length === next.keys.length &&
      s.keys.every((k, i) => k === next.keys[i])
    ) {
      return;
    }
    this.state = next;
    await this.store.save(next);
  }
}
