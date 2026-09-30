import { deviceIcon } from "../device-icons";
import { errText } from "../err-text";
import { routeState, type RouteTarget } from "./commands";
import { addressOf, parsePrograms, type ProgramRow } from "./config";
import { RESERVED_IDS } from "./device-id";
import { readDevices, stampOffline, type DevicesAdapter } from "./devices";
import { type PauseState, type PauseStore } from "./emulated-pause";
import { classify } from "./errors";
import type { Command, DriverDeps, ProgramDriver, ProgramEntry } from "./model";
import { redact } from "./redact";
import { ProgramRunner, type RunnerDeps } from "./runner";
import { computeSummary, type SummaryInput } from "./summary";
import { ProgramTree, writeLastEvents, type ProgramEvents, type TreeAdapter, type TreeScope } from "./tree";
import { toMBps } from "./units";

/** The adapter methods the manager uses on top of the tree's. */
export interface ManagerAdapter extends TreeAdapter, DevicesAdapter {}

/**
 * The emulated pause of one program keeps its state in the `native` of that program's `paused` datapoint — written
 * only on a change, read back after a restart (plan § 5.3). Nothing is stored while the object does not exist.
 *
 * @param adapter object access
 * @param id full id of the `paused` datapoint
 * @returns the store
 */
export function objectPauseStore(adapter: ManagerAdapter, id: string): PauseStore {
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

/** What a connection test found. */
export type TestResult =
  | { ok: true; version: string; downloads?: number }
  | { ok: false; kind: "setup" | "auth" | "unreachable" | "other"; text: string };

/** Everything the manager needs from outside. */
export interface ManagerDeps {
  /** Object and state access. */
  adapter: ManagerAdapter;
  /** The adapter's timers. */
  timers: Pick<RunnerDeps, "setTimeout" | "clearTimeout">;
  /** Registry lookup. */
  find: (type: string) => ProgramEntry | undefined;
  /** Actionable problems (rejected login): raised by a runner, resolved when the program's settings change. */
  problems: RunnerDeps["problems"] & { resolve(key: string, message: string): void };
  /** Moves a program's device with everything below it to a new id (`move.ts`). */
  moveDevice: (oldId: string, newId: string) => Promise<void>;
  /** My.JDownloader named the id of a program's instance (first connect) — the adapter stores it. */
  onDeviceId?: (programId: string, deviceId: string) => void;
}

/** Options from the adapter settings. */
export interface ManagerOptions {
  /** Poll interval in ms. */
  intervalMs: number;
  /** Which downloads the object tree shows. */
  scope: TreeScope;
  /** At most this many download channels per program, 0 = no limit. */
  limit: number;
}

interface Running {
  driver: ProgramDriver;
  tree: ProgramTree;
  runner: ProgramRunner;
}

/**
 * @param row a program row
 * @returns what decides how the program runs — a row whose signature changed is started anew
 */
const signature = (row: ProgramRow): string =>
  JSON.stringify([row.enabled, row.scheme, row.problem, row.entry ? row.cfg : row.cfg.type]);

/**
 * All configured programs: reads the program rows, keeps the device tree in line with them, runs one isolated
 * runner per program, routes user writes to them and keeps the adapter-wide summary. A change of the rows is taken
 * over while the adapter runs ({@link ProgramManager.apply}) — only the programs it touches start anew.
 */
export class ProgramManager {
  private readonly a: ManagerAdapter;
  private rows: ProgramRow[] = [];
  private readonly running = new Map<string, Running>();
  private stopped = false;
  /** Changes of the rows, one after the other. */
  private queue: Promise<void> = Promise.resolve();
  /** Summary writes, one after the other. */
  private summaryQueue: Promise<void> = Promise.resolve();

  /**
   * @param deps outside services
   * @param opts adapter options
   */
  public constructor(
    private readonly deps: ManagerDeps,
    private readonly opts: ManagerOptions,
  ) {
    this.a = deps.adapter;
  }

  /**
   * Stamps every known program offline, removes the devices no row keeps and starts one runner per usable program.
   *
   * @param raw the program rows (secrets readable)
   */
  public async start(raw: unknown): Promise<void> {
    this.rows = parsePrograms(raw, this.deps.find);
    const existing = await readDevices(this.a);
    await stampOffline(this.a, existing.keys());
    const ids = new Set(this.rows.map(r => r.id));
    for (const oldId of existing.keys()) {
      if (!ids.has(oldId)) {
        this.a.log.debug(`${oldId} is no longer configured — removing its objects`);
        await this.a.delObject(`${this.a.namespace}.${oldId}`, { recursive: true });
      }
    }
    for (const row of this.rows) {
      await this.startProgram(row);
    }
    await this.writeSummary();
    for (const r of this.running.values()) {
      r.runner.start();
    }
  }

  /**
   * Takes over changed program rows while the adapter runs: a removed program goes with its device, a moved one moves
   * its device first, a changed or switched one starts anew (its rejected login is forgotten), the others run on.
   *
   * @param raw the program rows (secrets readable)
   * @param moves old device id → new device id of the programs whose id changed
   * @returns when the change is through
   */
  public apply(raw: unknown, moves: ReadonlyMap<string, string> = new Map()): Promise<void> {
    const run = this.queue.then(() => this.applyNow(raw, moves));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyNow(raw: unknown, moves: ReadonlyMap<string, string>): Promise<void> {
    if (this.stopped) {
      return;
    }
    const next = parsePrograms(raw, this.deps.find);
    const before = new Map(this.rows.map(r => [r.id, r]));
    const nextIds = new Set(next.map(r => r.id));
    for (const [oldId, newId] of moves) {
      if (before.has(oldId) && nextIds.has(newId)) {
        await this.stopProgram(oldId);
        await this.deps.moveDevice(oldId, newId);
        before.delete(oldId);
      }
    }
    for (const oldId of before.keys()) {
      if (!nextIds.has(oldId)) {
        await this.stopProgram(oldId);
        this.a.log.debug(`${oldId} is no longer configured — removing its objects`);
        await this.a.delObject(`${this.a.namespace}.${oldId}`, { recursive: true });
      }
    }
    this.rows = next;
    for (const row of next) {
      const was = before.get(row.id);
      if (was && signature(was) === signature(row)) {
        continue;
      }
      await this.stopProgram(row.id);
      const started = await this.startProgram(row);
      started?.runner.start();
    }
    await this.writeSummary();
  }

  /**
   * Creates the device of one row and its runner (not started yet).
   *
   * @param row the row
   * @returns what runs the program, undefined for a switched-off or unusable row
   */
  private async startProgram(row: ProgramRow): Promise<Running | undefined> {
    if (!row.enabled) {
      return undefined;
    }
    if (RESERVED_IDS.has(row.id)) {
      this.a.log.warn(`${row.id}: this id belongs to the adapter itself — add the program again`);
      return undefined;
    }
    const name = row.cfg.name || row.id;
    if (!row.entry) {
      const bare = { type: row.cfg.type, capabilities: new Set<never>(), extras: [] };
      await new ProgramTree(this.a, row.id, name, bare, this.opts, row.scheme).ensureBareDevice(row.problem);
      this.a.log.warn(`${row.id}: ${row.problem} — check the program in the adapter settings`);
      return undefined;
    }
    const driver = row.entry.create(row.cfg, this.driverDeps(row.id));
    const tree = new ProgramTree(this.a, row.id, name, driver, this.opts, row.scheme);
    await tree.load();
    await tree.ensureDevice(deviceIcon(row.cfg.type), addressOf(row.cfg));
    const runner = new ProgramRunner(
      row.id,
      driver,
      tree,
      { ...this.deps.timers, log: this.a.log, problems: this.deps.problems },
      Math.max(this.opts.intervalMs, driver.minIntervalMs ?? 0),
      events => void this.changed(row.id, events),
    );
    const running = { driver, tree, runner };
    this.running.set(row.id, running);
    return running;
  }

  /**
   * Stops the runner of one program — a poll under way finishes first, so nothing writes into its device afterwards —
   * and forgets its rejected login.
   *
   * @param id the program's device id
   */
  private async stopProgram(id: string): Promise<void> {
    const r = this.running.get(id);
    this.running.delete(id);
    if (r) {
      await r.runner.stop();
    }
    this.deps.problems.resolve(`auth:${id}`, `${id}: settings changed — the program is asked again`);
  }

  /**
   * A user wrote a datapoint (`ack: false`).
   *
   * @param relId the state id below the instance
   * @param val the written value
   */
  public async onUserWrite(relId: string, val: ioBroker.StateValue): Promise<void> {
    const route = routeState(relId, val, id => this.target(id));
    if (route.kind === "ignore") {
      return;
    }
    if (route.kind === "pauseAll") {
      await this.pauseAll(route.on);
      return;
    }
    const p = this.running.get(route.program);
    if (!p) {
      return;
    }
    const what = this.describe(p, route.cmd);
    try {
      await p.runner.command(route.cmd);
      this.a.log.info(`${route.program}: ${what}`);
      if (route.confirm) {
        await this.a.setState(relId, { val: route.cmd.kind === "add" ? "" : val, ack: true });
      }
    } catch (err: unknown) {
      this.a.log.warn(`${route.program}: ${what} failed — ${redact(errText(err))}`);
    }
  }

  /**
   * The card's connection test: builds a driver for one settings row, asks the program once and closes the driver.
   * A switched-off row is tested all the same — the user asked for it.
   *
   * @param raw one program row (secrets readable)
   * @returns what the program answered
   */
  public async testProgram(raw: unknown): Promise<TestResult> {
    const [row] = parsePrograms([raw && typeof raw === "object" ? { ...raw, enabled: true } : raw], this.deps.find);
    if (!row?.entry) {
      return { ok: false, kind: "setup", text: row?.problem || "program type missing" };
    }
    const driver = row.entry.create(row.cfg, this.driverDeps());
    try {
      if (driver.test) {
        return { ok: true, version: await driver.test() };
      }
      const snap = await driver.poll();
      return { ok: true, version: snap.status.version, downloads: snap.items.length };
    } catch (err: unknown) {
      const kind = classify(err);
      return {
        ok: false,
        kind: kind === "auth" || kind === "unreachable" ? kind : "other",
        text: redact(errText(err)),
      };
    } finally {
      await driver.close().catch(() => undefined);
    }
  }

  /** Stops every runner (they mark their program Unknown) and marks the adapter disconnected. */
  public async stop(): Promise<void> {
    this.stopped = true;
    await this.queue;
    await Promise.allSettled([...this.running.values()].map(r => r.runner.stop()));
    this.running.clear();
    // nothing runs any more: every count and speed goes to nothing, the connection markers to false
    await this.writeSummary();
  }

  private driverDeps(programId?: string): DriverDeps {
    return {
      ...this.deps.timers,
      log: this.a.log,
      ...(programId
        ? {
            pauseStore: objectPauseStore(this.a, `${this.a.namespace}.${programId}.paused`),
            onDeviceId: (deviceId: string) => this.deps.onDeviceId?.(programId, deviceId),
          }
        : {}),
    };
  }

  private target(id: string): RouteTarget | undefined {
    const p = this.running.get(id);
    return p
      ? { capabilities: p.driver.capabilities, extras: p.driver.extras, itemKey: ch => p.tree.itemKey(ch) }
      : undefined;
  }

  private async pauseAll(on: boolean): Promise<void> {
    const targets = [...this.running.entries()].filter(([, p]) => p.driver.capabilities.has("globalPause"));
    if (!targets.length) {
      this.a.log.info(`${on ? "pause" : "resume"} all: no configured program can pause`);
      return;
    }
    let done = 0;
    const missed: string[] = [];
    for (const [id, p] of targets) {
      if (!p.runner.online) {
        missed.push(id);
        continue;
      }
      try {
        await p.runner.command({ kind: on ? "pauseAll" : "resumeAll" });
        done++;
      } catch (err: unknown) {
        this.a.log.debug(`${id}: ${on ? "pause" : "resume"} failed — ${redact(errText(err))}`);
        missed.push(id);
      }
    }
    const verb = on ? "pause all: paused" : "resume all: resumed";
    const tail = missed.length ? ` — not reachable: ${missed.join(", ")}` : "";
    this.a.log.info(`${verb} ${done} of ${targets.length} program(s)${tail}`);
  }

  private describe(p: Running, cmd: Command): string {
    const name = (key: string): string => p.runner.lastSnapshot?.items.find(i => i.key === key)?.name ?? key;
    const limit = (bps: number): string => (bps > 0 ? `${toMBps(bps)} MB/s` : "off");
    switch (cmd.kind) {
      case "pauseAll":
        return "paused";
      case "resumeAll":
        return "resumed";
      case "pause":
        return `paused "${name(cmd.key)}"`;
      case "resume":
        return `resumed "${name(cmd.key)}"`;
      case "remove":
        return `removed "${name(cmd.key)}" from the program's list`;
      case "add":
        return `added ${redact(cmd.url)}`;
      case "setSpeedLimit":
        return `download limit ${limit(cmd.bps)}`;
      case "setUploadLimit":
        return `upload limit ${limit(cmd.bps)}`;
      case "setAltSpeed":
        return `alternative speed limits ${cmd.on ? "on" : "off"}`;
      case "extra":
        return cmd.key ? `${cmd.name} for "${name(cmd.key)}"` : cmd.name;
    }
  }

  private async changed(programId: string, events: ProgramEvents): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (events.removedFromTree > 0) {
      this.a.log.info(
        `${programId}: removed ${events.removedFromTree} download(s) from the object tree (tree settings)`,
      );
    }
    try {
      await writeLastEvents((id, st) => this.a.setState(id, st), "summary", events);
      await this.writeSummary();
    } catch (err: unknown) {
      this.a.log.debug(`summary not written: ${errText(err)}`);
    }
  }

  /**
   * The summary over all programs, one write after the other: polls that end together would otherwise write their
   * summaries interleaved, and an older one could be written last. Each one is computed when it is its turn.
   *
   * @returns when this summary is written
   */
  private writeSummary(): Promise<void> {
    const run = this.summaryQueue.then(() => this.writeSummaryNow());
    this.summaryQueue = run.catch(() => undefined);
    return run;
  }

  private async writeSummaryNow(): Promise<void> {
    const inputs: SummaryInput[] = this.rows
      .filter(r => r.enabled)
      .map(r => {
        const p = this.running.get(r.id);
        return p
          ? {
              online: p.runner.online,
              canPause: p.driver.capabilities.has("globalPause"),
              snapshot: p.runner.lastSnapshot,
            }
          : { online: false, canPause: false, snapshot: null };
      });
    for (const [id, val] of Object.entries(computeSummary(inputs))) {
      await this.a.setStateChanged(id, { val, ack: true });
    }
  }
}
