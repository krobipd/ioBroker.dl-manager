import { tDesc, tName, tState, type I18nKey } from "../i18n";
import { forCapabilities, ITEM_DATAPOINTS, PROGRAM_DATAPOINTS, type DatapointDef } from "./datapoints";
import { ItemIds } from "./ids";
import {
  ACTIVE,
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
  /** e.g. "dl-manager.0" */
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
  /** Download channels taken out of the object tree by the tree settings (scope and limit). */
  removedFromTree: number;
}

/** Which downloads the object tree shows (adapter setting `treeScope`). */
export type TreeScope = "all" | "withoutCompleted" | "unfinished";

/** The adapter settings that shape the object tree. */
export interface TreeOptions {
  /** Which downloads get a channel. */
  scope: TreeScope;
  /** At most this many download channels per program, 0 = no limit. */
  limit: number;
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
/** Who keeps a channel when a program has more downloads than the limit — lower first. */
const RANK: Readonly<Record<Status, number>> = {
  downloading: 0,
  checking: 0,
  postprocessing: 0,
  failed: 1,
  paused: 2,
  waiting: 2,
  queued: 3,
  seeding: 4,
  completed: 5,
};
/** More download channels than this per program get a warning — unless the limit keeps them at or below it. */
const WARN_ABOVE = 200;
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
  private warned = false;
  private prev: Map<string, Status> | null = null;
  private baselineFinished: number | null = null;
  /** The value last written per state id — a poll that changes nothing reads nothing from the database. */
  private readonly written = new Map<string, ioBroker.StateValue>();

  /**
   * @param adapter the adapter seam
   * @param programId device id, e.g. `qbittorrent-nas`
   * @param programName the user's display name
   * @param driver capabilities and extras of the program's driver
   * @param opts adapter options that shape the tree (which downloads, how many)
   */
  public constructor(
    private readonly adapter: TreeAdapter,
    programId: string,
    private readonly programName: string,
    private readonly driver: TreeDriver,
    private readonly opts: TreeOptions,
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

  /**
   * @param channel the id segment of a download channel below `downloads`
   * @returns the program's raw key of that download, undefined for an unknown channel
   */
  public itemKey(channel: string): string | undefined {
    for (const [key, id] of this.ids.entries()) {
      if (id === channel) {
        return key;
      }
    }
    return undefined;
  }

  /** Reads the stored channels and the last recorded finish. Runs before the first sync. */
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
    const last = await this.adapter.getState(`${this.dev}.lastFinishedTime`);
    this.baselineFinished = typeof last?.val === "number" ? last.val : null;
  }

  /**
   * Creates the device, the downloads folder and every program datapoint; marks the program offline.
   *
   * @param icon inline data URI of the program's pictogram
   * @param address what identifies the program besides its key (`addressOf`) — carries room assignments on a key change
   */
  public async ensureDevice(icon: string | undefined, address = ""): Promise<void> {
    await this.adapter.extendObject(this.dev, {
      type: "device",
      common: {
        name: this.programName,
        statusStates: { onlineId: this.onlineId() },
        ...(icon ? { icon } : {}),
      },
      native: { type: this.driver.type, address, nameSource: "api" },
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
   * A settings row that cannot run (unknown type, missing field): only the device, `online` and `error` — no
   * datapoints of a program that is never asked.
   *
   * @param problem why the row cannot run
   */
  public async ensureBareDevice(problem: string): Promise<void> {
    await this.adapter.extendObject(this.dev, {
      type: "device",
      common: { name: this.programName, statusStates: { onlineId: this.onlineId() } },
      native: { type: this.driver.type, nameSource: "api" },
    });
    for (const d of PROGRAM_DATAPOINTS.filter(x => x.id === "online" || x.id === "error")) {
      await this.adapter.extendObject(`${this.dev}.${d.id}`, this.stateObject(d));
    }
    await this.markOffline(problem);
  }

  /**
   * The program cannot be reached (or is not asked yet): online false, the reason in `error`.
   *
   * @param reason the fleet reason text — `Unknown` or the program's own message
   */
  public async markOffline(reason: string): Promise<void> {
    await this.put(`${this.dev}.online`, false);
    await this.put(`${this.dev}.error`, reason);
  }

  /**
   * A user wrote this state: the next poll writes the program's value again, even when it did not change.
   *
   * @param id full state id
   */
  public forget(id: string): void {
    this.written.delete(id);
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
    const shown = this.shown(snapshot.items);

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
      if (!shown.has(item.key)) {
        if (this.known.has(item.key)) {
          await this.removeChannel(item.key);
          events.removedFromTree++;
        }
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
    }
    this.warnAboutMany(shown.size);
    this.prev = next;
    await this.writeProgram(snapshot);
    await this.writeEvents(events);
    return events;
  }

  /**
   * The downloads that get a channel: those the scope admits, and of them — when there are more than the limit — the
   * best ranked ones, the newest first within a rank (finished downloads by their finish, the others by when they were
   * added; without a time in the program's own order).
   *
   * @param items all downloads of the poll
   * @returns the keys of the downloads to show
   */
  private shown(items: readonly DownloadItem[]): Set<string> {
    const admitted = items.filter(i => this.admits(i.status));
    const limit = this.opts.limit;
    if (limit <= 0 || admitted.length <= limit) {
      return new Set(admitted.map(i => i.key));
    }
    const time = (i: DownloadItem): number =>
      (DONE.has(i.status) ? (i.finishedMs ?? i.addedMs) : i.addedMs) ?? Number.NEGATIVE_INFINITY;
    const ranked = [...admitted].sort((a, b) => {
      const byRank = RANK[a.status] - RANK[b.status];
      if (byRank !== 0) {
        return byRank;
      }
      const ta = time(a);
      const tb = time(b);
      return ta === tb ? 0 : tb > ta ? 1 : -1;
    });
    return new Set(ranked.slice(0, limit).map(i => i.key));
  }

  private admits(status: Status): boolean {
    switch (this.opts.scope) {
      case "withoutCompleted":
        return status !== "completed";
      case "unfinished":
        return !DONE.has(status);
      default:
        return true;
    }
  }

  private warnAboutMany(shown: number): void {
    if (this.warned || shown <= WARN_ABOVE) {
      return;
    }
    this.warned = true;
    this.adapter.log.warn(
      `${this.programName}: ${shown} downloads in the object tree — this many can slow ioBroker down; limit them in the adapter settings (100 or fewer recommended)`,
    );
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
      await this.put(`${ch}.${dp}`, val);
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
      await this.put(`${this.dev}.${dp}`, val);
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

  private async put(id: string, val: ioBroker.StateValue): Promise<void> {
    if (this.written.has(id) && this.written.get(id) === val) {
      return;
    }
    await this.adapter.setStateChanged(id, { val, ack: true });
    this.written.set(id, val);
  }

  private async removeChannel(key: string): Promise<void> {
    const id = this.ids.idFor(key);
    await this.adapter.delObject(`${this.dev}.downloads.${id}`, { recursive: true });
    for (const k of [...this.written.keys()]) {
      if (k.startsWith(`${this.dev}.downloads.${id}.`)) {
        this.written.delete(k);
      }
    }
    this.ids.release(key);
    this.known.delete(key);
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
