import { deviceIcon } from "../device-icons";
import { errText } from "../err-text";
import { routeState, type RouteTarget } from "./commands";
import { addressOf, parsePrograms, type ProgramRow } from "./config";
import { carryAssignments, planHandover, readDevices, stampOffline, type DevicesAdapter } from "./devices";
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
  /** The adapter's decrypt for the table's secret columns. */
  decrypt: (value: string) => string;
  /** Actionable problems (rejected login). */
  problems: RunnerDeps["problems"];
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
 * All configured programs: reads the settings table, keeps the device tree in line with it, runs one isolated
 * runner per program, routes user writes to them and keeps the adapter-wide summary.
 */
export class ProgramManager {
  private readonly a: ManagerAdapter;
  private rows: ProgramRow[] = [];
  private readonly running = new Map<string, Running>();
  private stopped = false;

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
   * Stamps every known program offline, aligns the device tree with the settings and starts one runner per usable
   * program.
   *
   * @param rawPrograms `native.programs`
   */
  public async start(rawPrograms: unknown): Promise<void> {
    this.rows = parsePrograms(rawPrograms, this.deps.decrypt, this.deps.find);
    const existing = await readDevices(this.a);
    await stampOffline(this.a, existing.keys());
    const { carries, orphans } = planHandover(this.rows, existing);
    for (const oldId of orphans) {
      this.a.log.debug(`${oldId} is no longer configured — removing its objects`);
      await this.a.delObject(`${this.a.namespace}.${oldId}`, { recursive: true });
    }

    for (const row of this.rows) {
      if (!row.enabled) {
        continue;
      }
      const name = row.cfg.name || row.id;
      if (!row.entry) {
        const bare = { type: row.cfg.type, capabilities: new Set<never>(), extras: [] };
        await new ProgramTree(this.a, row.id, name, bare, this.opts).ensureBareDevice(row.problem);
        this.a.log.warn(`${row.id}: ${row.problem} — check the program in the adapter settings`);
        continue;
      }
      const driver = row.entry.create(row.cfg, this.driverDeps(row.id));
      const tree = new ProgramTree(this.a, row.id, name, driver, this.opts);
      await tree.load();
      await tree.ensureDevice(deviceIcon(row.cfg.type), addressOf(row.cfg));
      const oldId = carries.get(row.id);
      if (oldId) {
        await carryAssignments(this.a, oldId, row.id);
      }
      const runner = new ProgramRunner(
        row.id,
        driver,
        tree,
        { ...this.deps.timers, log: this.a.log, problems: this.deps.problems },
        Math.max(this.opts.intervalMs, driver.minIntervalMs ?? 0),
        events => void this.changed(row.id, events),
      );
      this.running.set(row.id, { driver, tree, runner });
    }
    await this.writeSummary();
    for (const r of this.running.values()) {
      r.runner.start();
    }
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
   * @param raw one entry of `native.programs`
   * @returns what the program answered
   */
  public async testProgram(raw: unknown): Promise<TestResult> {
    const [row] = parsePrograms(
      [raw && typeof raw === "object" ? { ...raw, enabled: true } : raw],
      this.deps.decrypt,
      this.deps.find,
    );
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
    await Promise.allSettled([...this.running.values()].map(r => r.runner.stop()));
    this.running.clear();
    // nothing runs any more: every count and speed goes to nothing, the connection markers to false
    await this.writeSummary();
  }

  private driverDeps(programId?: string): DriverDeps {
    return {
      ...this.deps.timers,
      log: this.a.log,
      ...(programId ? { pauseStore: objectPauseStore(this.a, `${this.a.namespace}.${programId}.paused`) } : {}),
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

  private async writeSummary(): Promise<void> {
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
