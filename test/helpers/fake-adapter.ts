/**
 * In-memory stand-in for the parts of the adapter the core uses (objects, states, log). Reads hand out COPIES
 * (`structuredClone`), like the real database — a test can then tell a missing write from a made one
 * (fleet package check `read-stub-copy`).
 */
export class FakeAdapter {
  public readonly objects = new Map<string, ioBroker.Object>();
  public readonly states = new Map<string, ioBroker.State>();
  public objectWrites = 0;
  /** The full id of every object write in order. */
  public readonly objectLog: string[] = [];
  public stateWrites = 0;
  /** Reads `setStateChanged` makes to compare — the real controller reads the state from the database each time. */
  public changedChecks = 0;
  /** The id of every `setStateChanged` call — each one is a database read in the real controller. */
  public readonly changedLog: string[] = [];
  /** State writes to an id that has no object — the real database warns about every one of them. */
  public readonly orphanWrites: string[] = [];
  /** Every state write in order (id without namespace as given, value). */
  public readonly writeLog: { id: string; val: ioBroker.StateValue }[] = [];
  public readonly logs: { level: string; msg: string }[] = [];
  public readonly log = {
    debug: (msg: string): void => void this.logs.push({ level: "debug", msg }),
    info: (msg: string): void => void this.logs.push({ level: "info", msg }),
    warn: (msg: string): void => void this.logs.push({ level: "warn", msg }),
    error: (msg: string): void => void this.logs.push({ level: "error", msg }),
  };

  /** @param namespace e.g. "dl-manager.0" */
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
    this.objectLog.push(key);
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
    this.objectLog.push(id);
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
   * Reads copies of all objects between two ids, like the object database's getObjectList.
   *
   * @param params the range
   * @param params.startkey first id
   * @param params.endkey last id
   */
  public getObjectList(params: {
    startkey: string;
    endkey: string;
  }): Promise<{ rows: { id: string; value: ioBroker.Object }[] }> {
    const rows = [...this.objects]
      .filter(([k]) => k >= params.startkey && k <= params.endkey)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([id, v]) => ({ id, value: structuredClone(v) }));
    return Promise.resolve({ rows });
  }

  /**
   * The …Async name the fleet's KnownObjects master calls.
   *
   * @param params the range
   * @param params.startkey first id
   * @param params.endkey last id
   * @returns copies of the objects in the range
   */
  public getObjectListAsync(params: {
    startkey: string;
    endkey: string;
  }): Promise<{ rows: { id: string; value: ioBroker.Object }[] }> {
    return this.getObjectList(params);
  }

  /**
   * The …Async name the fleet's KnownObjects master calls.
   *
   * @param id own or full id
   * @param opts delete options
   * @param opts.recursive delete children too
   */
  public delObjectAsync(id: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.delObject(id, opts);
  }

  /**
   * Reads a copy of an object by its full id (no namespace added).
   *
   * @param id full id
   */
  public getForeignObjectAsync(id: string): Promise<ioBroker.Object | null> {
    const obj = this.objects.get(id);
    return Promise.resolve(obj ? structuredClone(obj) : null);
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
   * Reads copies of every state whose id starts with the pattern's prefix.
   *
   * @param pattern prefix with a trailing `*`
   */
  public getStates(pattern: string): Promise<Record<string, ioBroker.State>> {
    const prefix = pattern.replace(/\*$/, "");
    const out: Record<string, ioBroker.State> = {};
    for (const [k, v] of this.states) {
      if (k.startsWith(prefix)) {
        out[k] = structuredClone(v);
      }
    }
    return Promise.resolve(out);
  }

  /**
   * Writes a state.
   *
   * @param id own or full id
   * @param state the state
   */
  public setState(id: string, state: ioBroker.SettableState): Promise<void> {
    const key = this.full(id);
    if (!this.objects.has(key)) {
      this.orphanWrites.push(key);
    }
    this.writeLog.push({ id, val: state.val ?? null });
    this.states.set(key, { ...(state as ioBroker.State), ts: Date.now(), lc: Date.now() });
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
    this.changedChecks++;
    this.changedLog.push(this.full(id));
    const old = this.states.get(this.full(id));
    if (old && old.val === state.val && old.ack === state.ack) {
      return Promise.resolve();
    }
    return this.setState(id, state);
  }

  /**
   * @param id own or full id
   * @returns the object as held — what the adapter's object memory gives without a database read
   */
  public knownObject(id: string): unknown {
    return this.objects.get(this.full(id));
  }

  /**
   * @param id own or full id
   * @returns the value as held — what the adapter's value memory gives without a database read
   */
  public knownValue(id: string): ioBroker.StateValue | undefined {
    return this.val(id);
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
