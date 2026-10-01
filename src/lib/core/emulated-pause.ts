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

/** The object access an emulated pause needs to keep its state. */
export interface PauseObjectAdapter {
  /** Reads an object by its full id. */
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Replaces an object completely — a merge would keep stale keys in the list. */
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<unknown>;
}

/**
 * The emulated pause of one program keeps its state in the `native` of that program's `paused` datapoint — written
 * only on a change, read back after a restart (plan § 5.3). Nothing is stored while the object does not exist.
 *
 * @param adapter object access
 * @param id full id of the `paused` datapoint
 * @returns the store
 */
export function objectPauseStore(adapter: PauseObjectAdapter, id: string): PauseStore {
  return {
    load: async () => {
      const saved: unknown = (await adapter.getForeignObjectAsync(id))?.native?.emulatedPause;
      const s = saved && typeof saved === "object" ? (saved as Partial<PauseState>) : {};
      return {
        paused: s.paused === true,
        keys: Array.isArray(s.keys) ? s.keys.filter((k): k is string => typeof k === "string") : [],
      };
    },
    save: async state => {
      const obj = await adapter.getForeignObjectAsync(id);
      if (!obj) {
        return;
      }
      obj.native = { ...obj.native, emulatedPause: { paused: state.paused, keys: [...state.keys] } };
      await adapter.setForeignObject(id, obj);
    },
  };
}
