import { moveWithEnums, type EnumCarryAdapter } from "../enum-carry";
import { errText } from "../err-text";
import type { DriverDeps, ProgramEntry } from "../programs/registry";
import { routeState, type RouteTarget } from "./commands";
import { addressOf, parsePrograms, type ProgramRow } from "./config";
import { type PauseState, type PauseStore } from "./emulated-pause";
import { classify } from "./errors";
import type { Command, ProgramDriver } from "./model";
import { redact } from "./redact";
import { ProgramRunner, type RunnerDeps } from "./runner";
import { computeSummary, type SummaryInput } from "./summary";
import { ProgramTree, type ProgramEvents, type TreeAdapter } from "./tree";
import { toMBps } from "./units";

/** The adapter methods the manager uses on top of the tree's. */
export interface ManagerAdapter extends TreeAdapter {
  /** Reads an object by its full id (enums). */
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
}

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
  /** Take completed downloads out of the object tree. */
  removeFinished: boolean;
}

interface Running {
  driver: ProgramDriver;
  tree: ProgramTree;
  runner: ProgramRunner;
}

const NO_REACHABLE_STAMP: [string, ioBroker.StateValue][] = [
  ["info.connection", false],
  ["info.programsOnline", 0],
  ["info.programsAllOnline", false],
];

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
    const existing = await this.existingDevices();
    await this.stampOffline(existing.keys());

    const ids = new Set(this.rows.map(r => r.id));
    const carries = new Map<string, string>();
    for (const [oldId, native] of existing) {
      if (ids.has(oldId)) {
        continue;
      }
      const heir = this.rows.find(
        r =>
          r.enabled &&
          !r.problem &&
          !existing.has(r.id) &&
          !carries.has(r.id) &&
          r.cfg.type === native.type &&
          addressOf(r.cfg) === native.address,
      );
      if (heir) {
        carries.set(heir.id, oldId);
      } else {
        this.a.log.debug(`${oldId} is no longer configured — removing its objects`);
        await this.a.delObject(`${this.a.namespace}.${oldId}`, { recursive: true });
      }
    }

    for (const row of this.rows) {
      if (!row.enabled) {
        continue;
      }
      const name = row.cfg.name || row.id;
      if (row.problem) {
        const bare = { type: row.cfg.type, capabilities: new Set<never>(), extras: [] };
        await new ProgramTree(this.a, row.id, name, bare, this.opts).ensureBareDevice(row.problem);
        this.a.log.warn(`${row.id}: ${row.problem} — check the program in the adapter settings`);
        continue;
      }
      const entry = this.deps.find(row.cfg.type);
      if (!entry) {
        continue;
      }
      const driver = entry.create(row.cfg, this.driverDeps(row.id));
      const tree = new ProgramTree(this.a, row.id, name, driver, this.opts);
      await tree.load();
      await tree.ensureDevice(undefined, addressOf(row.cfg));
      const oldId = carries.get(row.id);
      if (oldId) {
        await this.carry(oldId, row.id);
      }
      const runner = new ProgramRunner(
        row.id,
        driver,
        tree,
        { ...this.deps.timers, log: this.a.log, problems: this.deps.problems },
        this.opts.intervalMs,
        events => void this.changed(events),
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
   * The settings page's connection test: asks every enabled program of the (unsaved) form once.
   *
   * @param rawPrograms the table as the form holds it
   * @returns one line per program
   */
  public async testConnections(rawPrograms: unknown): Promise<string> {
    const lines: string[] = [];
    for (const row of parsePrograms(rawPrograms, this.deps.decrypt, this.deps.find)) {
      if (!row.enabled) {
        continue;
      }
      const entry = this.deps.find(row.cfg.type);
      if (row.problem || !entry) {
        lines.push(`${row.id}: ${row.problem}`);
        continue;
      }
      const driver = entry.create(row.cfg, this.driverDeps());
      try {
        const snap = await driver.poll();
        lines.push(`${row.id}: OK — version ${snap.status.version}, ${snap.items.length} download(s)`);
      } catch (err: unknown) {
        const text = redact(errText(err));
        const kind = classify(err);
        const prefix = kind === "auth" ? "login rejected — " : kind === "unreachable" ? "not reachable — " : "";
        lines.push(`${row.id}: ${prefix}${text}`);
      } finally {
        await driver.close().catch(() => undefined);
      }
    }
    return lines.length ? lines.join("\n") : "no program is configured";
  }

  /** Stops every runner (they mark their program Unknown) and marks the adapter disconnected. */
  public async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.running.values()].map(r => r.runner.stop()));
    this.running.clear();
    for (const [id, val] of NO_REACHABLE_STAMP) {
      await this.a.setState(id, { val, ack: true });
    }
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

  /** @returns device id → its `native` for every device of this instance */
  private async existingDevices(): Promise<Map<string, { type?: unknown; address?: unknown }>> {
    const prefix = `${this.a.namespace}.`;
    const devices = await this.a.getForeignObjects(`${prefix}*`, "device");
    const out = new Map<string, { type?: unknown; address?: unknown }>();
    for (const [id, obj] of Object.entries(devices)) {
      const rel = id.slice(prefix.length);
      if (!rel.includes(".")) {
        out.set(rel, (obj.native ?? {}) as { type?: unknown; address?: unknown });
      }
    }
    return out;
  }

  private async stampOffline(deviceIds: Iterable<string>): Promise<void> {
    for (const id of deviceIds) {
      if (await this.a.getObject(`${id}.online`)) {
        await this.a.setStateChanged(`${id}.online`, { val: false, ack: true });
        await this.a.setStateChanged(`${id}.error`, { val: "Unknown", ack: true });
      }
    }
    for (const [id, val] of NO_REACHABLE_STAMP) {
      await this.a.setState(id, { val, ack: true });
    }
  }

  /**
   * The user changed the ID column of a program: carry room and function assignments of the device and its
   * datapoints to the new device, then remove the old one. Download channels are not carried — they come back with
   * the next poll under the new device.
   *
   * @param oldId previous device id
   * @param newId new device id (already created)
   */
  private async carry(oldId: string, newId: string): Promise<void> {
    const oldFull = `${this.a.namespace}.${oldId}`;
    const newFull = `${this.a.namespace}.${newId}`;
    const carrier: EnumCarryAdapter = {
      getForeignObjectsAsync: (pattern, type) => this.a.getForeignObjects(pattern, type),
      getForeignObjectAsync: id => this.a.getForeignObjectAsync(id),
      setForeignObject: (id, obj) => this.a.setForeignObject(id, obj as unknown as ioBroker.SettableObject),
      log: this.a.log,
    };
    const enums = await this.a.getForeignObjects("enum.*", "enum");
    const members = new Set<string>();
    for (const e of Object.values(enums)) {
      const list: unknown = (e.common as { members?: unknown }).members;
      if (Array.isArray(list)) {
        list.filter((m): m is string => typeof m === "string").forEach(m => members.add(m));
      }
    }
    const children = [...members].filter(m => m.startsWith(`${oldFull}.`)).sort((x, y) => y.length - x.length);
    for (const oldChild of children) {
      const newChild = newFull + oldChild.slice(oldFull.length);
      if (await this.a.getForeignObjectAsync(newChild)) {
        await moveWithEnums(
          carrier,
          oldChild,
          newChild,
          () => this.a.delObject(oldChild, { recursive: true }),
          errText,
        );
      }
    }
    const removeOld = (): Promise<unknown> => this.a.delObject(oldFull, { recursive: true });
    if (members.has(oldFull)) {
      await moveWithEnums(carrier, oldFull, newFull, removeOld, errText);
    } else {
      await removeOld();
    }
    this.a.log.info(`${oldId} is now ${newId} — room and function assignments carried over`);
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

  private async changed(events: ProgramEvents): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const last = events.finished.at(-1);
      if (last) {
        await this.a.setState("summary.lastFinished", { val: last.name, ack: true });
        await this.a.setState("summary.lastFinishedTime", { val: last.finishedMs ?? Date.now(), ack: true });
      }
      const failed = events.failed.at(-1);
      if (failed) {
        await this.a.setState("summary.lastFailed", { val: failed.name, ack: true });
        await this.a.setState("summary.lastFailedTime", { val: Date.now(), ack: true });
      }
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
