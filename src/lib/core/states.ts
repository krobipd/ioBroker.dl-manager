import { ownId } from "./ids";
/** The adapter methods the state store needs. */
export interface KnownStatesAdapter {
  /** e.g. "dl-manager.0" */
  namespace: string;
  /** Reads every state matching a pattern. */
  getStates(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>>;
  /** Writes a state. */
  setState(id: string, state: ioBroker.SettableState): Promise<unknown>;
}

interface Written {
  val: ioBroker.StateValue;
  ack: boolean;
  q: number;
}

/**
 * The adapter's own states, read once at start and then known from its own writes — the one place that decides
 * whether a value has to be written. `setStateChangedAsync` would read the database on every call.
 *
 * What this instance did not write itself is forgotten the moment it happens: a user or script write
 * ({@link KnownStates.forget}), so the next poll writes the program's value even when it is the one written before and
 * a lost command gets corrected; and a deleted object ({@link KnownStates.remove}), whose value js-controller deletes
 * with it, so a channel that comes back gets every value again.
 */
export class KnownStates {
  private readonly last = new Map<string, Written>();

  /** @param a the adapter */
  public constructor(private readonly a: KnownStatesAdapter) {}

  private full(id: string): string {
    return ownId(this.a.namespace, id);
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
   * Writes a state only when it differs from what this instance knows of it.
   *
   * @param id own or full id
   * @param state the state
   */
  public async put(id: string, state: ioBroker.SettableState): Promise<void> {
    const was = this.last.get(this.full(id));
    const now: Written = { val: state.val ?? null, ack: state.ack === true, q: state.q ?? 0 };
    if (was && was.val === now.val && was.ack === now.ack && was.q === now.q) {
      return;
    }
    await this.set(id, state);
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

  /**
   * Someone else wrote this state — its next put writes, whatever this instance wrote before.
   *
   * @param id own or full id
   */
  public forget(id: string): void {
    this.last.delete(this.full(id));
  }

  /**
   * The object is deleted, and js-controller deletes its value with it (with `recursive` the children's as well).
   *
   * @param id own or full id
   * @param opts options of the delete
   * @param opts.recursive whether the children went too
   */
  public remove(id: string, opts: { recursive: boolean }): void {
    const key = this.full(id);
    for (const k of [...this.last.keys()]) {
      if (k === key || (opts.recursive && k.startsWith(`${key}.`))) {
        this.last.delete(k);
      }
    }
  }
}
