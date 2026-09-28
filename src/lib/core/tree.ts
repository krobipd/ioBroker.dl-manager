import { tDesc, tName, tState, type I18nKey } from "../i18n";
import { forCapabilities, ITEM_DATAPOINTS, PROGRAM_DATAPOINTS, type DatapointDef } from "./datapoints";
import { ItemIds } from "./ids";
import {
  STATUSES,
  type Capability,
  type DownloadItem,
  type ExtraDefinition,
  type ProgramSnapshot,
  type Status,
} from "./model";
import { percent, toGB, toMBps } from "./units";

/** The adapter methods the tree uses — a seam, so the tests run against an in-memory store. */
export interface TreeAdapter {
  /** e.g. "download-manager.0" */
  namespace: string;
  /** The adapter log. */
  log: { debug(msg: string): void; info(msg: string): void; warn(msg: string): void };
  /** Merges into an object (own namespace or full id). */
  extendObject(id: string, obj: ioBroker.PartialObject): Promise<unknown>;
  /** Replaces an object completely — needed where a merge would keep stale list entries. */
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<unknown>;
  /** Deletes an object (and with `recursive` its children and their values). */
  delObject(id: string, opts: { recursive: boolean }): Promise<unknown>;
  /** Reads an object (own namespace or full id). */
  getObject(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Reads objects by pattern and type. */
  getForeignObjects(pattern: string, type: ioBroker.ObjectType): Promise<Record<string, ioBroker.Object>>;
  /** Reads a state. */
  getState(id: string): Promise<ioBroker.State | null | undefined>;
  /** Writes a state. */
  setState(id: string, state: ioBroker.SettableState): Promise<unknown>;
  /** Writes a state only when the value or ack changed. */
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<unknown>;
}

/** What one sync reports back. */
export interface ProgramEvents {
  /** Downloads that finished (completed or started seeding) in this sync. */
  finished: DownloadItem[];
  /** Downloads that failed in this sync. */
  failed: DownloadItem[];
  /** Downloads taken out of the object tree by the "remove finished" option. */
  removedFromTree: number;
}

/** The driver facts the tree needs. */
export interface TreeDriver {
  /** Program type. */
  readonly type: string;
  /** Capabilities. */
  readonly capabilities: ReadonlySet<Capability>;
  /** Program-specific datapoints. */
  readonly extras: readonly ExtraDefinition[];
}

const DONE: ReadonlySet<Status> = new Set<Status>(["completed", "seeding"]);
const ACTIVE: ReadonlySet<Status> = new Set<Status>(["downloading", "postprocessing"]);
const STATUS_LABEL: Readonly<Record<Status, I18nKey>> = {
  queued: "statusQueued",
  downloading: "statusDownloading",
  waiting: "statusWaiting",
  paused: "statusPaused",
  checking: "statusChecking",
  postprocessing: "statusPostprocessing",
  seeding: "statusSeeding",
  completed: "statusCompleted",
  failed: "statusFailed",
};
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Mirrors ONE program into the object tree: its device, its datapoints and one channel per download. Objects are
 * written only when they are new or changed; values only when they changed. Nothing is removed from an incomplete
 * poll.
 */
export class ProgramTree {
  private readonly dev: string;
  private readonly itemDefs: DatapointDef[];
  private readonly itemExtras: readonly ExtraDefinition[];
  private readonly sig: string;
  private ids = new ItemIds(new Map());
  /** Raw key → channel signature as stored (`native.sig`) and name. */
  private readonly known = new Map<string, { sig: string; name: string }>();
  private removed = new Set<string>();
  private prev: Map<string, Status> | null = null;
  private baselineFinished: number | null = null;

  /**
   * @param adapter the adapter seam
   * @param programId device id, e.g. `qbittorrent-nas`
   * @param programName the user's display name
   * @param driver capabilities and extras of the program's driver
   * @param opts adapter options that shape the tree
   * @param opts.removeFinished take completed downloads out of the object tree
   */
  public constructor(
    private readonly adapter: TreeAdapter,
    programId: string,
    private readonly programName: string,
    private readonly driver: TreeDriver,
    private readonly opts: { removeFinished: boolean },
  ) {
    this.dev = `${adapter.namespace}.${programId}`;
    this.itemDefs = forCapabilities(ITEM_DATAPOINTS, driver.capabilities);
    this.itemExtras = driver.extras.filter(e => e.level === "item");
    this.sig = [...this.itemDefs.map(d => d.id), ...this.itemExtras.map(e => e.id)].join(",");
  }

  /** @returns the id of the program's online indicator */
  public onlineId(): string {
    return `${this.dev}.online`;
  }

  /** Reads the stored channels, the "removed" list and the last recorded finish. Runs before the first sync. */
  public async load(): Promise<void> {
    const channels = await this.adapter.getForeignObjects(`${this.dev}.downloads.*`, "channel");
    const stored = new Map<string, string>();
    for (const [id, obj] of Object.entries(channels)) {
      const key: unknown = obj.native?.key;
      if (typeof key !== "string") {
        continue;
      }
      stored.set(key, id.slice(`${this.dev}.downloads.`.length));
      const sig: unknown = obj.native?.sig;
      const name: unknown = obj.common?.name;
      this.known.set(key, { sig: typeof sig === "string" ? sig : "", name: typeof name === "string" ? name : "" });
    }
    this.ids = new ItemIds(stored);
    const device = await this.adapter.getObject(this.dev);
    const removed: unknown = device?.native?.removed;
    this.removed = new Set(Array.isArray(removed) ? removed.filter((k): k is string => typeof k === "string") : []);
    const last = await this.adapter.getState(`${this.dev}.lastFinishedTime`);
    this.baselineFinished = typeof last?.val === "number" ? last.val : null;
  }

  /**
   * Creates the device, the downloads folder and every program datapoint; marks the program offline.
   *
   * @param icon inline data URI of the program's pictogram
   */
  public async ensureDevice(icon: string | undefined): Promise<void> {
    await this.adapter.extendObject(this.dev, {
      type: "device",
      common: {
        name: this.programName,
        statusStates: { onlineId: this.onlineId() },
        ...(icon ? { icon } : {}),
      },
      native: { type: this.driver.type, nameSource: "api" },
    });
    await this.adapter.extendObject(`${this.dev}.downloads`, {
      type: "folder",
      common: { name: tName("folderDownloads") },
      native: {},
    });
    for (const d of forCapabilities(PROGRAM_DATAPOINTS, this.driver.capabilities)) {
      await this.adapter.extendObject(`${this.dev}.${d.id}`, this.stateObject(d));
    }
    for (const e of this.driver.extras.filter(x => x.level === "program")) {
      await this.adapter.extendObject(`${this.dev}.${e.id}`, this.extraObject(e));
    }
    await this.markOffline("Unknown");
  }

  /**
   * The program cannot be reached (or is not asked yet): online false, the reason in `error`.
   *
   * @param reason the fleet reason text — `Unknown` or the program's own message
   */
  public async markOffline(reason: string): Promise<void> {
    await this.adapter.setStateChanged(`${this.dev}.online`, { val: false, ack: true });
    await this.adapter.setStateChanged(`${this.dev}.error`, { val: reason, ack: true });
  }

  /**
   * One poll result into the tree.
   *
   * @param snapshot what the driver read
   * @returns the finished and failed downloads of this sync
   */
  public async sync(snapshot: ProgramSnapshot): Promise<ProgramEvents> {
    const events: ProgramEvents = { finished: [], failed: [], removedFromTree: 0 };
    const baseline = this.prev === null;
    const prev = this.prev ?? new Map<string, Status>();
    const next = new Map<string, Status>();
    const present = new Set<string>();
    let removedChanged = false;

    for (const item of snapshot.items) {
      present.add(item.key);
      next.set(item.key, item.status);
      const before = prev.get(item.key);
      if (DONE.has(item.status) && (before === undefined ? this.isNewFinish(item, baseline) : !DONE.has(before))) {
        events.finished.push(item);
      }
      if (item.status === "failed" && !baseline && before !== "failed") {
        events.failed.push(item);
      }
      if (this.removed.has(item.key)) {
        continue;
      }
      if (this.opts.removeFinished && item.status === "completed") {
        if (this.known.has(item.key)) {
          await this.removeChannel(item.key);
        }
        this.removed.add(item.key);
        removedChanged = true;
        events.removedFromTree++;
        continue;
      }
      await this.writeItem(item);
    }

    if (snapshot.complete) {
      for (const key of [...this.known.keys()]) {
        if (!present.has(key)) {
          await this.removeChannel(key);
        }
      }
      for (const key of [...this.removed]) {
        if (!present.has(key)) {
          this.removed.delete(key);
          removedChanged = true;
        }
      }
    }
    if (removedChanged) {
      await this.storeRemoved();
    }
    this.prev = next;
    await this.writeProgram(snapshot);
    await this.writeEvents(events);
    return events;
  }

  private isNewFinish(item: DownloadItem, baseline: boolean): boolean {
    if (!baseline) {
      return true;
    }
    return (
      this.baselineFinished !== null && typeof item.finishedMs === "number" && item.finishedMs > this.baselineFinished
    );
  }

  private async writeItem(item: DownloadItem): Promise<void> {
    const id = this.ids.idFor(item.key);
    const ch = `${this.dev}.downloads.${id}`;
    const known = this.known.get(item.key);
    if (!known || known.sig !== this.sig) {
      await this.adapter.extendObject(ch, {
        type: "channel",
        common: { name: item.name },
        native: { key: item.key, sig: this.sig, nameSource: "api" },
      });
      for (const d of this.itemDefs) {
        await this.adapter.extendObject(`${ch}.${d.id}`, this.stateObject(d));
      }
      for (const e of this.itemExtras) {
        await this.adapter.extendObject(`${ch}.${e.id}`, this.extraObject(e));
      }
      this.known.set(item.key, { sig: this.sig, name: item.name });
    } else if (known.name !== item.name) {
      await this.adapter.extendObject(ch, { common: { name: item.name } });
      known.name = item.name;
    }
    const caps = this.driver.capabilities;
    const values: [string, ioBroker.StateValue][] = [
      ["status", item.status],
      ["progress", percent(item.doneBytes, item.sizeBytes)],
      ["size", toGB(item.sizeBytes)],
      ["downloaded", toGB(item.doneBytes)],
    ];
    if (caps.has("itemSpeed")) {
      values.push(["speed", toMBps(item.speedBps)]);
    }
    if (caps.has("upload")) {
      values.push(["uploadSpeed", toMBps(item.uploadBps)]);
      values.push(["ratio", typeof item.ratio === "number" ? round2(item.ratio) : null]);
    }
    if (caps.has("itemEta")) {
      values.push(["eta", item.etaSeconds]);
    }
    if (caps.has("itemAdded")) {
      values.push(["added", item.addedMs ?? null]);
    }
    if (caps.has("itemFinished")) {
      values.push(["finished", item.finishedMs ?? null]);
    }
    if (caps.has("category")) {
      values.push(["category", item.category ?? ""]);
    }
    if (caps.has("itemError")) {
      values.push(["error", item.error]);
    }
    if (caps.has("itemPause")) {
      values.push(["paused", item.status === "paused"]);
    }
    for (const e of this.itemExtras) {
      const v = item.extra?.[e.id];
      if (v !== undefined) {
        values.push([e.id, v]);
      }
    }
    for (const [dp, val] of values) {
      await this.adapter.setStateChanged(`${ch}.${dp}`, { val, ack: true });
    }
  }

  private async writeProgram(snapshot: ProgramSnapshot): Promise<void> {
    const s = snapshot.status;
    const caps = this.driver.capabilities;
    const items = snapshot.items;
    const values: [string, ioBroker.StateValue][] = [
      ["online", true],
      ["error", ""],
      ["version", s.version],
      ["downloading", items.some(i => ACTIVE.has(i.status))],
      ["downloadSpeed", toMBps(s.downloadBps)],
      ["active", items.filter(i => ACTIVE.has(i.status)).length],
      ["queued", items.filter(i => i.status === "queued").length],
      ["total", items.length],
    ];
    if (caps.has("globalPause")) {
      values.push(["paused", s.paused]);
    }
    if (caps.has("upload")) {
      values.push(["uploadSpeed", toMBps(s.uploadBps)]);
    }
    if (caps.has("speedLimit")) {
      values.push(["speedLimit", toMBps(s.speedLimitBps)]);
    }
    if (caps.has("uploadLimit")) {
      values.push(["uploadLimit", toMBps(s.uploadLimitBps)]);
    }
    if (caps.has("altSpeed")) {
      values.push(["altSpeed", s.altSpeed === true]);
    }
    if (caps.has("freeSpace")) {
      values.push(["freeSpace", toGB(s.freeSpaceBytes)]);
    }
    for (const e of this.driver.extras.filter(x => x.level === "program")) {
      const v = s.extra?.[e.id];
      if (v !== undefined) {
        values.push([e.id, v]);
      }
    }
    for (const [dp, val] of values) {
      await this.adapter.setStateChanged(`${this.dev}.${dp}`, { val, ack: true });
    }
  }

  private async writeEvents(events: ProgramEvents): Promise<void> {
    const last = events.finished.at(-1);
    if (last) {
      await this.adapter.setState(`${this.dev}.lastFinished`, { val: last.name, ack: true });
      await this.adapter.setState(`${this.dev}.lastFinishedTime`, { val: last.finishedMs ?? Date.now(), ack: true });
    }
    const failed = events.failed.at(-1);
    if (failed) {
      await this.adapter.setState(`${this.dev}.lastFailed`, { val: failed.name, ack: true });
      await this.adapter.setState(`${this.dev}.lastFailedTime`, { val: Date.now(), ack: true });
    }
  }

  private async removeChannel(key: string): Promise<void> {
    const id = this.ids.idFor(key);
    await this.adapter.delObject(`${this.dev}.downloads.${id}`, { recursive: true });
    this.ids.release(key);
    this.known.delete(key);
  }

  private async storeRemoved(): Promise<void> {
    const device = await this.adapter.getObject(this.dev);
    if (!device) {
      return;
    }
    device.native = { ...device.native, removed: [...this.removed].sort() };
    await this.adapter.setForeignObject(this.dev, device);
  }

  private stateObject(d: DatapointDef): ioBroker.PartialObject {
    const common: Partial<ioBroker.StateCommon> = {
      name: tName(d.nameKey),
      type: d.type,
      role: d.role,
      read: d.read,
      write: d.write,
    };
    if (d.unit) {
      common.unit = d.unit;
    }
    if (d.descKey) {
      common.desc = tDesc(d.descKey);
    }
    if (d.id === "status") {
      common.states = Object.fromEntries(STATUSES.map(s => [s, tState(STATUS_LABEL[s])]));
    }
    if (d.role === "button") {
      common.def = false;
    }
    return { type: "state", common, native: {} };
  }

  private extraObject(e: ExtraDefinition): ioBroker.PartialObject {
    const common: Partial<ioBroker.StateCommon> = {
      name: tName(e.nameKey),
      type: e.type,
      role: e.role,
      read: e.read,
      write: e.write,
    };
    if (e.unit) {
      common.unit = e.unit;
    }
    if (e.descKey) {
      common.desc = tDesc(e.descKey);
    }
    if (e.role === "button") {
      common.def = false;
    }
    return { type: "state", common, native: {} };
  }
}
