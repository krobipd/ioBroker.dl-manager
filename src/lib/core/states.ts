/** The adapter methods the state store needs. */
export interface KnownStatesAdapter {
  /** e.g. "dl-manager.0" */
  namespace: string;
  /** Reads every state matching a pattern. */
  getStates(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>>;
  /** Writes a state. */
  setState(id: string, state: ioBroker.SettableState): Promise<unknown>;
  /** Writes a state only when it differs from the database. */
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<unknown>;
}

interface Written {
  val: ioBroker.StateValue;
  ack: boolean;
  q: number;
}

/**
 * The adapter's own states, read once at start. A read-only state (`common.write === false`) is written only by the
 * adapter, so it is compared here in memory — `setStateChangedAsync` would read it from the database on every call. A
 * writable state stays with the database compare: a user write there makes the next equal echo a change, which
 * corrects a lost command.
 */
export class KnownStates {
  private readonly last = new Map<string, Written>();

  /**
   * @param a the adapter
   * @param readOnly whether a full state id is read-only (from its object)
   */
  public constructor(
    private readonly a: KnownStatesAdapter,
    private readonly readOnly: (id: string) => boolean,
  ) {}

  private full(id: string): string {
    return id.startsWith(`${this.a.namespace}.`) ? id : `${this.a.namespace}.${id}`;
  }

  /** Reads every own state with one call, so a restart writes nothing blindly. */
  public async load(): Promise<void> {
    const states = await this.a.getStates(`${this.a.namespace}.*`);
    this.last.clear();
    for (const [id, st] of Object.entries(states)) {
      if (st) {
        this.last.set(id, { val: st.val, ack: st.ack, q: st.q ?? 0 });
      }
    }
  }

  /**
   * Writes a state only when it changes: read-only ones compared in memory, writable ones against the database.
   *
   * @param id own or full id
   * @param state the state
   */
  public async put(id: string, state: ioBroker.SettableState): Promise<void> {
    const key = this.full(id);
    if (!this.readOnly(key)) {
      await this.a.setStateChanged(id, state);
      return;
    }
    const was = this.last.get(key);
    const now: Written = { val: state.val ?? null, ack: state.ack === true, q: state.q ?? 0 };
    if (was && was.val === now.val && was.ack === now.ack && was.q === now.q) {
      return;
    }
    await this.a.setState(id, state);
    this.last.set(key, now);
  }

  /**
   * Writes a state unconditionally (an event, a command echo) and remembers it.
   *
   * @param id own or full id
   * @param state the state
   */
  public async set(id: string, state: ioBroker.SettableState): Promise<void> {
    await this.a.setState(id, state);
    this.last.set(this.full(id), { val: state.val ?? null, ack: state.ack === true, q: state.q ?? 0 });
  }
}
