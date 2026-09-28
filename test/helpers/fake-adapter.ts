/**
 * In-memory stand-in for the parts of the adapter the core uses (objects, states, log). Reads hand out COPIES
 * (`structuredClone`), like the real database — a test can then tell a missing write from a made one
 * (fleet package check `read-stub-copy`).
 */
export class FakeAdapter {
  public readonly objects = new Map<string, ioBroker.Object>();
  public readonly states = new Map<string, ioBroker.State>();
  public objectWrites = 0;
  public stateWrites = 0;
  public readonly logs: { level: string; msg: string }[] = [];
  public readonly log = {
    debug: (msg: string): void => void this.logs.push({ level: "debug", msg }),
    info: (msg: string): void => void this.logs.push({ level: "info", msg }),
    warn: (msg: string): void => void this.logs.push({ level: "warn", msg }),
    error: (msg: string): void => void this.logs.push({ level: "error", msg }),
  };

  /** @param namespace e.g. "download-manager.0" */
  public constructor(public readonly namespace: string) {}

  private full(id: string): string {
    return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
  }

  /**
   * Merges into an object like js-controller's extendObject.
   *
   * @param id own or full id
   * @param obj partial object
   */
  public extendObject(id: string, obj: ioBroker.PartialObject): Promise<void> {
    const key = this.full(id);
    const existing = this.objects.get(key);
    const merged = merge(
      (existing ? structuredClone(existing) : {}) as Record<string, unknown>,
      structuredClone(obj) as Record<string, unknown>,
    ) as unknown as ioBroker.Object;
    merged._id = key;
    this.objects.set(key, merged);
    this.objectWrites++;
    return Promise.resolve();
  }

  /**
   * Replaces an object completely.
   *
   * @param id full id
   * @param obj the object
   */
  public setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
    const copy = structuredClone(obj) as unknown as ioBroker.Object;
    copy._id = id;
    this.objects.set(id, copy);
    this.objectWrites++;
    return Promise.resolve();
  }

  /**
   * Deletes an object, with `recursive` also its children and their values.
   *
   * @param id own or full id
   * @param opts options
   * @param opts.recursive delete children too
   */
  public delObject(id: string, opts?: { recursive?: boolean }): Promise<void> {
    const key = this.full(id);
    for (const k of [...this.objects.keys()]) {
      if (k === key || (opts?.recursive && k.startsWith(`${key}.`))) {
        this.objects.delete(k);
        this.states.delete(k);
      }
    }
    this.objectWrites++;
    return Promise.resolve();
  }

  /**
   * Reads a copy of an object.
   *
   * @param id own or full id
   */
  public getObject(id: string): Promise<ioBroker.Object | null> {
    const obj = this.objects.get(this.full(id));
    return Promise.resolve(obj ? structuredClone(obj) : null);
  }

  /**
   * Reads copies of all objects with the prefix and type.
   *
   * @param pattern prefix with a trailing `*`
   * @param type object type
   */
  public getForeignObjects(pattern: string, type: ioBroker.ObjectType): Promise<Record<string, ioBroker.Object>> {
    const prefix = pattern.replace(/\*$/, "");
    const out: Record<string, ioBroker.Object> = {};
    for (const [k, v] of this.objects) {
      if (k.startsWith(prefix) && v.type === type) {
        out[k] = structuredClone(v);
      }
    }
    return Promise.resolve(out);
  }

  /**
   * Reads a copy of a state.
   *
   * @param id own or full id
   */
  public getState(id: string): Promise<ioBroker.State | null> {
    const st = this.states.get(this.full(id));
    return Promise.resolve(st ? structuredClone(st) : null);
  }

  /**
   * Writes a state.
   *
   * @param id own or full id
   * @param state the state
   */
  public setState(id: string, state: ioBroker.SettableState): Promise<void> {
    this.states.set(this.full(id), { ...(state as ioBroker.State), ts: Date.now(), lc: Date.now() });
    this.stateWrites++;
    return Promise.resolve();
  }

  /**
   * Writes a state only when value or ack changed.
   *
   * @param id own or full id
   * @param state the state
   */
  public setStateChanged(id: string, state: ioBroker.SettableState): Promise<void> {
    const old = this.states.get(this.full(id));
    if (old && old.val === state.val && old.ack === state.ack) {
      return Promise.resolve();
    }
    return this.setState(id, state);
  }

  /**
   * @param id state id without namespace
   * @returns the value or undefined
   */
  public val(id: string): ioBroker.StateValue | undefined {
    return this.states.get(this.full(id))?.val;
  }
}

function merge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object") {
      target[k] = merge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
  return target;
}
