// Fleet master — the release run requires this file byte for byte in every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
/**
 * The fleet's stand-in for the adapter in a test, over objects and states held in memory the way js-controller 7.2.5
 * holds them (krobi 2026-11-18 09:47 and 09:54: a change of a fleet master must reach every adapter without a Werkbank
 * step per adapter). A test or a sealed guard that builds its adapter on this class — directly, as a subclass, or as the
 * adapter base in place of `@iobroker/adapter-core` — does not break when a master widens its adapter type: the master
 * widens this class in the same round. The Werkbank holds this class against the adapter type of every fleet master
 * before a round lands; it imports only the masters every adapter carries, so it compiles in every adapter.
 *
 * What it keeps like js-controller 7.2.5 (`adapter.ts`, `objectsInRedisClient.ts`): `getObjectList` lists every id
 * between `startkey` and `endkey`, both included, sorted by id, as rows of `id` and `value`, each a copy; `extendObject`
 * and `setForeignObject` leave what `extendedWith` and `storedAfterSet` of `known-objects.ts` say; a delete of an id
 * that is not there changes nothing; a recursive delete takes the root first and then every id below it in list order,
 * leaves an object with `common.dontDelete`, deletes the state of every state object and takes the id out of every enum
 * that lists it (`removeIdFromAllEnums`). Timers fire only when the test runs them; messages are answered by `answer`;
 * events reach their listeners only through `emit`.
 *
 * Test code: nothing outside a test imports it. The adapter build (`build-adapter ts`) compiles every `src/**` source but
 * a test, so the file is part of the package without being loaded.
 *
 * Fleet master: `Entwicklung/.consistency-master/src/lib/adapter-fake.ts`. Every adapter carries this file and its test
 * byte for byte — the release run (consistency level 1) reports any difference. Change the master, then copy; never the
 * copy.
 */
import { extendedWith, storedAfterSet, type KnownObjectsAdapter } from "./known-objects";
import type { StartFailureAdapter } from "./start-failure";

/** A line the fake adapter logged. */
export interface FakeLogLine {
  /** The log level. */
  level: "debug" | "info" | "warn" | "error";
  /** The text. */
  message: string;
}

/** A timer of the fake adapter — it fires only when the test runs it ({@link FakeAdapter.runTimers}). */
export interface FakeTimer {
  /** What runs when it fires. */
  callback: () => void;
  /** The delay the caller asked for. */
  ms: number;
  /** Cleared before it fired. */
  cleared: boolean;
  /** Fired already. */
  fired: boolean;
}

/** A message the fake adapter sent to another instance. */
export interface FakeMessage {
  /** The receiving instance, e.g. `history.0`. */
  instance: string;
  /** The command. */
  command: string;
  /** The message. */
  message: unknown;
  /** How long the caller would wait for the answer. */
  timeout: number;
}

/** A notification the fake adapter registered. */
export interface FakeNotification {
  /** The scope (the adapter's name). */
  scope: string;
  /** The category. */
  category: string | null;
  /** The text. */
  message: string;
}

/** A state as the fake adapter holds it. */
export interface FakeState {
  /** The value. */
  val: unknown;
  /** Confirmed by the device. */
  ack: boolean;
}

/** How a test starts the fake adapter: its name, its instance, the objects it starts with and its settings. */
export interface FakeAdapterOptions {
  /** The adapter's name; the namespace is `<name>.0` unless given. */
  readonly name?: string;
  /** The instance, e.g. `demo.0`. */
  readonly namespace?: string;
  /** The objects the database holds at the start, by relative or full id. */
  readonly objects?: Record<string, unknown>;
  /** The instance settings. */
  readonly config?: Record<string, unknown>;
  /** Any other option of the adapter base. */
  readonly [option: string]: unknown;
}

/** Thrown by {@link FakeAdapter.terminate}: the process would end here. */
export class FakeTermination extends Error {
  /**
   * @param reason the reason the adapter gave
   * @param exitCode the exit code it ended with
   */
  constructor(
    public readonly reason: string,
    public readonly exitCode: number,
  ) {
    super(`terminated with exit code ${exitCode}: ${reason}`);
    this.name = "FakeTermination";
  }
}

/** The prefix of what {@link FakeAdapter.encrypt} makes of a text. */
export const FAKE_SEALED = "fake-encrypted:";

/**
 * Whether a value is an object with named fields.
 *
 * @param value any value
 * @returns whether it is a plain record
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The regular expression of an object id pattern (`*` for any text).
 *
 * @param pattern e.g. `enum.*`
 * @returns the expression matching whole ids
 */
function patternOf(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .split("*")
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
}

/** The adapter in a test. */
export class FakeAdapter implements KnownObjectsAdapter, StartFailureAdapter {
  /** The instance, e.g. `demo.0`. */
  public readonly namespace: string;
  /**
   * The instance settings — the two deletion options and whatever else the adapter reads. Named fields only from the
   * test: a declared field would make the settings type of a master that names none of them refuse this class.
   */
  public config: Record<string, unknown>;
  /** Every object by its full id. */
  public readonly objects = new Map<string, Record<string, unknown>>();
  /** Every state by its full id. */
  public readonly states = new Map<string, FakeState>();
  /** Every line logged, in order. */
  public readonly lines: FakeLogLine[] = [];
  /** Every timer set, in order. */
  public readonly timers: FakeTimer[] = [];
  /** Every message sent, in order. */
  public readonly sent: FakeMessage[] = [];
  /** Every notification registered, in order. */
  public readonly notifications: FakeNotification[] = [];
  /** Every pattern subscribed with `subscribeForeignObjectsAsync`. */
  public readonly subscriptions: string[] = [];
  /** What `getCertificatesAsync` answers. */
  public certificates: unknown = undefined;
  /** The answer of another instance to a message — every recording instance confirms `deleteAll` unless set. */
  public answer: (message: FakeMessage) => unknown = () => ({ success: true });
  /** The adapter's logger. */
  public readonly log = {
    debug: (message: string): void => void this.lines.push({ level: "debug", message }),
    info: (message: string): void => void this.lines.push({ level: "info", message }),
    warn: (message: string): void => void this.lines.push({ level: "warn", message }),
    error: (message: string): void => void this.lines.push({ level: "error", message }),
  };
  private readonly listeners = new Map<string, Array<(...args: never[]) => unknown>>();

  /** @param options the name or namespace, the objects at the start and the settings */
  constructor(options: FakeAdapterOptions = {}) {
    this.namespace = options.namespace ?? `${options.name ?? "demo"}.0`;
    this.config = { ...options.config };
    for (const [id, obj] of Object.entries(options.objects ?? {})) {
      const full = this.full(id);
      this.objects.set(full, { ...(structuredClone(obj) as Record<string, unknown>), _id: full });
    }
  }

  /** The adapter's name — the part of the namespace before the instance number. */
  public get name(): string {
    return this.namespace.replace(/\.\d+$/, "");
  }

  /**
   * The full id of an own id — js-controller puts the namespace in front of an id that does not start with it.
   *
   * @param id relative or full id
   * @returns the full id
   */
  public full(id: string): string {
    return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
  }

  /**
   * The objects between two ids, both included, sorted by id — each row a copy.
   *
   * @param params the range
   * @param params.startkey the first id
   * @param params.endkey the last id
   * @returns the rows
   */
  public getObjectListAsync(params: {
    startkey: string;
    endkey: string;
  }): Promise<{ rows: Array<{ id: string; value: unknown }> }> {
    const rows = [...this.objects.keys()]
      .filter(id => id >= params.startkey && id <= params.endkey)
      .sort()
      .map(id => ({ id, value: structuredClone(this.objects.get(id)) }));
    return Promise.resolve({ rows });
  }

  /**
   * One object, a copy.
   *
   * @param id the full id
   * @returns the object, null when there is none
   */
  public getForeignObjectAsync(id: string): Promise<Record<string, unknown> | null> {
    const obj = this.objects.get(id);
    return Promise.resolve(obj ? structuredClone(obj) : null);
  }

  /**
   * Every object of a type whose id matches the pattern, copies by full id.
   *
   * @param pattern e.g. `enum.*`
   * @param type the object type
   * @returns the objects
   */
  public getForeignObjectsAsync(pattern: string, type: "enum" | "state"): Promise<Record<string, unknown>> {
    const match = patternOf(pattern);
    const found: Record<string, unknown> = {};
    for (const [id, obj] of this.objects) {
      if (match.test(id) && obj.type === type) {
        found[id] = structuredClone(obj);
      }
    }
    return Promise.resolve(found);
  }

  /**
   * Merges into an own object as the database merges.
   *
   * @param id relative or full id
   * @param obj what is written
   * @returns the id
   */
  public extendObject(id: string, obj: unknown): Promise<{ id: string }> {
    return this.extendForeignObjectAsync(this.full(id), obj);
  }

  /**
   * Merges into any object as the database merges.
   *
   * @param id the full id
   * @param obj what is written
   * @returns the id
   */
  public extendForeignObjectAsync(id: string, obj: unknown): Promise<{ id: string }> {
    const after = extendedWith(this.objects.get(id) ?? {}, structuredClone(obj)) as Record<string, unknown>;
    this.objects.set(id, { ...after, _id: id });
    return Promise.resolve({ id });
  }

  /**
   * Replaces an object as the database stores it.
   *
   * @param id the full id
   * @param obj the whole object
   * @returns the id
   */
  public setForeignObject(id: string, obj: unknown): Promise<{ id: string }> {
    this.objects.set(id, storedAfterSet(id, this.objects.get(id), obj) as Record<string, unknown>);
    return Promise.resolve({ id });
  }

  /**
   * Deletes an own object (with `recursive` everything below it).
   *
   * @param id relative or full id
   * @param options delete the children too
   * @param options.recursive whether the children go as well
   * @returns nothing
   */
  public delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<void> {
    return this.delForeignObjectAsync(this.full(id), options);
  }

  /**
   * Deletes any object as js-controller 7.2.5 does: the root first, then every id below it in list order, never one
   * with `common.dontDelete`, each with its state and out of every enum.
   *
   * @param id the full id
   * @param options delete the children too
   * @param options.recursive whether the children go as well
   * @returns nothing; refused for an object with `common.dontDelete` deleted without `recursive`
   */
  public delForeignObjectAsync(id: string, options?: { recursive?: boolean }): Promise<void> {
    const keep = (obj: Record<string, unknown> | undefined): boolean =>
      isRecord(obj?.common) && Boolean(obj.common.dontDelete);
    const root = this.objects.get(id);
    if (!options?.recursive && root && keep(root)) {
      return Promise.reject(new Error("not deletable"));
    }
    const tasks = root && !keep(root) ? [id] : [];
    if (options?.recursive) {
      for (const below of [...this.objects.keys()].filter(other => other.startsWith(`${id}.`)).sort()) {
        if (!keep(this.objects.get(below))) {
          tasks.push(below);
        }
      }
    }
    for (const task of tasks) {
      this.objects.delete(task);
      this.states.delete(task);
      for (const [enumId, obj] of this.objects) {
        const common = isRecord(obj.common) ? obj.common : undefined;
        const members = common?.members;
        if (obj.type === "enum" && common && Array.isArray(members) && members.includes(task)) {
          this.objects.set(enumId, { ...obj, common: { ...common, members: members.filter(m => m !== task) } });
        }
      }
    }
    return Promise.resolve();
  }

  /**
   * Sends a message and answers it with {@link FakeAdapter.answer}.
   *
   * @param instance the receiving instance
   * @param command the command
   * @param message the message
   * @param options how long the caller waits
   * @param options.timeout the wait in ms
   * @returns the answer
   */
  public sendToAsync(
    instance: string,
    command: string,
    message: unknown,
    options: { timeout: number },
  ): Promise<unknown> {
    const sent = { instance, command, message: structuredClone(message), timeout: options.timeout };
    this.sent.push(sent);
    return Promise.resolve(this.answer(sent));
  }

  /**
   * A timer that fires only when the test runs it. A property, not a method: the repository checker reads a method
   * named like the timer as a bare timer call (S5005), and every adapter carries this file unchanged.
   *
   * @param callback what runs
   * @param ms the delay
   * @returns the timer
   */
  public readonly setTimeout = (callback: () => void, ms: number): ioBroker.Timeout | undefined => {
    const timer: FakeTimer = { callback, ms, cleared: false, fired: false };
    this.timers.push(timer);
    return timer as unknown as ioBroker.Timeout;
  };

  /**
   * Clears a timer of {@link FakeAdapter.setTimeout}.
   *
   * @param timer the timer, or undefined
   */
  public readonly clearTimeout = (timer: ioBroker.Timeout | undefined): void => {
    const own = this.timers.find(t => (t as unknown) === timer);
    if (own) {
      own.cleared = true;
    }
  };

  /**
   * Fires every timer that is due now — set, not cleared, not fired; one a callback sets fires at the next call.
   *
   * @returns how many fired
   */
  public runTimers(): number {
    const due = this.timers.filter(t => !t.cleared && !t.fired);
    for (const timer of due) {
      timer.fired = true;
      timer.callback();
    }
    return due.length;
  }

  /**
   * Registers a notification.
   *
   * @param scope the scope
   * @param category the category
   * @param message the text
   * @returns nothing
   */
  public registerNotification(scope: string, category: string | null, message: string): Promise<void> {
    this.notifications.push({ scope, category, message });
    return Promise.resolve();
  }

  /**
   * Ends the process — here by throwing a {@link FakeTermination}.
   *
   * @param reason the reason
   * @param exitCode the exit code
   */
  public terminate(reason: string, exitCode: number): never {
    throw new FakeTermination(reason, exitCode);
  }

  /**
   * The controller's certificates — {@link FakeAdapter.certificates}.
   *
   * @returns what the test set
   */
  public getCertificatesAsync(): Promise<unknown> {
    return Promise.resolve(this.certificates);
  }

  /**
   * Subscribes foreign objects.
   *
   * @param pattern the pattern
   * @returns nothing
   */
  public subscribeForeignObjectsAsync(pattern: string): Promise<void> {
    this.subscriptions.push(pattern);
    return Promise.resolve();
  }

  /**
   * Adds a listener for an event of the adapter (`ready`, `objectChange`, `unload`, …).
   *
   * @param event the event
   * @param listener the listener
   * @returns the adapter
   */
  public on(event: string, listener: (...args: never[]) => unknown): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  /**
   * Hands an event to its listeners, one after the other, each awaited.
   *
   * @param event the event
   * @param args what the listeners get
   * @returns once every listener ended
   */
  public async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) {
      await (listener as (...given: unknown[]) => unknown)(...args);
    }
  }

  /**
   * Encrypts a text — reversibly, marked with {@link FAKE_SEALED}.
   *
   * @param value the text
   * @returns the sealed text
   */
  public encrypt(value: string): string {
    return FAKE_SEALED + Buffer.from(value, "utf8").toString("base64");
  }

  /**
   * Decrypts what {@link FakeAdapter.encrypt} made.
   *
   * @param value the sealed text
   * @returns the text
   */
  public decrypt(value: string): string {
    if (!value.startsWith(FAKE_SEALED)) {
      throw new Error("not encrypted by this adapter");
    }
    return Buffer.from(value.slice(FAKE_SEALED.length), "base64").toString("utf8");
  }
}
