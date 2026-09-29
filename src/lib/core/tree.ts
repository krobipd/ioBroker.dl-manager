import { tDesc, tName, tState, type I18nKey } from "../i18n";
import { forCapabilities, ITEM_DATAPOINTS, PROGRAM_DATAPOINTS, type DatapointDef } from "./datapoints";
import { ID_SCHEME } from "./device-id";
import { ItemIds } from "./ids";
import { DONE, shownKeys, type TreeOptions } from "./visibility";
import {
  STATUSES,
  type AdapterLog,
  type Capability,
  type DownloadItem,
  type ExtraDefinition,
  type ProgramSnapshot,
  type Status,
} from "./model";

/** The adapter methods the tree uses — a seam, so the tests run against an in-memory store. */
export interface TreeAdapter {
  /** e.g. "dl-manager.0" */
  namespace: string;
  /** The adapter log. */
  log: AdapterLog;
  /** Merges into an object (own namespace or full id). */
  extendObject(id: string, obj: ioBroker.PartialObject): Promise<unknown>;
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

export type { TreeOptions, TreeScope } from "./visibility";

/** The driver facts the tree needs. */
export interface TreeDriver {
  /** Program type. */
  readonly type: string;
  /** Capabilities. */
  readonly capabilities: ReadonlySet<Capability>;
  /** Program-specific datapoints. */
  readonly extras: readonly ExtraDefinition[];
}

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

/** The channel of the "last" values, below a program's device and below `summary`. */
export const LAST_CHANNEL = "last";

/** @returns the object of the {@link LAST_CHANNEL} channel */
export function lastChannelObject(): ioBroker.PartialObject {
  return { type: "channel", common: { name: tName("channelLast") }, native: {} };
}

/**
 * The newest finished and the newest failed download of a poll into `<prefix>.last.finished*` / `.last.failed*` —
 * below a program's device and in the adapter's summary alike.
 *
 * @param setState writes a state
 * @param prefix the id the four states sit below
 * @param events what the poll found
 */
export async function writeLastEvents(
  setState: (id: string, state: ioBroker.SettableState) => Promise<unknown>,
  prefix: string,
  events: Pick<ProgramEvents, "finished" | "failed">,
): Promise<void> {
  const last = events.finished.at(-1);
  if (last) {
    await setState(`${prefix}.${LAST_CHANNEL}.finished`, { val: last.name, ack: true });
    await setState(`${prefix}.${LAST_CHANNEL}.finishedTime`, { val: last.finishedMs ?? Date.now(), ack: true });
  }
  const failed = events.failed.at(-1);
  if (failed) {
    await setState(`${prefix}.${LAST_CHANNEL}.failed`, { val: failed.name, ack: true });
    await setState(`${prefix}.${LAST_CHANNEL}.failedTime`, { val: Date.now(), ack: true });
  }
}

/**
 * Mirrors ONE program into the object tree: its device, its datapoints and one channel per download. Every object is
 * offered once per start (the adapter's `extendObject` writes only what differs), later only when it is new or
 * changed; values only when they changed. Nothing is removed from an incomplete poll.
 */
export class ProgramTree {
  private readonly dev: string;
  private readonly itemDefs: DatapointDef[];
  private readonly itemExtras: readonly ExtraDefinition[];
  private ids = new ItemIds(new Map());
  /**
   * Raw key → channel name; `fresh` once this start offered the channel's objects (a channel read from the database
   * gets them once, so a changed datapoint set or text reaches an existing installation).
   */
  private readonly known = new Map<string, { name: string; fresh: boolean; leftSig: boolean }>();
  /** The device still carries the removed list the 0.0.1 placeholder wrote (`native.removed`). */
  private leftRemoved = false;
  private warned = false;
  private prev: Map<string, Status> | null = null;
  private baselineFinished: number | null = null;

  /**
   * @param adapter the adapter seam
   * @param programId device id, e.g. `qbittorrent-nas`
   * @param programName the user's display name
   * @param driver capabilities and extras of the program's driver
   * @param opts adapter options that shape the tree (which downloads, how many)
   * @param scheme the device id follows the id scheme (`native.idScheme`) — not yet for a My.JDownloader program
   *   whose instance id is still unknown
   */
  public constructor(
    private readonly adapter: TreeAdapter,
    programId: string,
    private readonly programName: string,
    private readonly driver: TreeDriver,
    private readonly opts: TreeOptions,
    private readonly scheme = true,
  ) {
    this.dev = `${adapter.namespace}.${programId}`;
    this.itemDefs = forCapabilities(ITEM_DATAPOINTS, driver.capabilities);
    this.itemExtras = driver.extras.filter(e => e.level === "item");
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
    return this.ids.keyOf(channel);
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
      const name: unknown = obj.common?.name;
      this.known.set(key, {
        name: typeof name === "string" ? name : "",
        fresh: false,
        // the 0.0.1 placeholder stored a datapoint signature on every channel — nulled with the channel's first write
        leftSig: obj.native?.sig !== undefined && obj.native?.sig !== null,
      });
    }
    this.ids = new ItemIds(stored);
    const removed: unknown = (await this.adapter.getObject(this.dev))?.native?.removed;
    this.leftRemoved = removed !== undefined && removed !== null;
    const last = await this.adapter.getState(`${this.dev}.${LAST_CHANNEL}.finishedTime`);
    this.baselineFinished = typeof last?.val === "number" ? last.val : null;
  }

  /**
   * Creates the device, the downloads folder and every program datapoint; marks the program offline.
   *
   * @param icon inline data URI of the program's pictogram
   * @param address the program's address (`addressOf`)
   */
  public async ensureDevice(icon: string | undefined, address = ""): Promise<void> {
    await this.writeDevice(icon, address);
    await this.adapter.extendObject(`${this.dev}.downloads`, {
      type: "folder",
      common: { name: tName("folderDownloads") },
      native: {},
    });
    await this.adapter.extendObject(`${this.dev}.${LAST_CHANNEL}`, lastChannelObject());
    for (const d of forCapabilities(PROGRAM_DATAPOINTS, this.driver.capabilities)) {
      await this.adapter.extendObject(`${this.dev}.${d.id}`, this.stateObject(d));
    }
    for (const e of this.driver.extras.filter(x => x.level === "program")) {
      await this.adapter.extendObject(`${this.dev}.${e.id}`, this.stateObject(e));
    }
    await this.markOffline("Unknown");
  }

  /**
   * @param icon the pictogram, none for a row that cannot run
   * @param address the program's address, none for a row that cannot run
   */
  private async writeDevice(icon?: string, address?: string): Promise<void> {
    await this.adapter.extendObject(this.dev, {
      type: "device",
      common: {
        name: this.programName,
        statusStates: { onlineId: this.onlineId() },
        ...(icon ? { icon } : {}),
      },
      native: {
        type: this.driver.type,
        nameSource: "api",
        ...(this.scheme ? { idScheme: ID_SCHEME } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(this.leftRemoved ? { removed: null } : {}),
      },
    });
  }

  /**
   * A settings row that cannot run (unknown type, missing field): only the device, `online` and `error` — no
   * datapoints of a program that is never asked.
   *
   * @param problem why the row cannot run
   */
  public async ensureBareDevice(problem: string): Promise<void> {
    await this.writeDevice();
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
    const shown = shownKeys(snapshot.items, this.opts);

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
    if (!known || !known.fresh) {
      await this.adapter.extendObject(ch, {
        type: "channel",
        common: { name: item.name },
        native: { key: item.key, nameSource: "api", ...(known?.leftSig ? { sig: null } : {}) },
      });
      for (const d of this.itemDefs) {
        await this.adapter.extendObject(`${ch}.${d.id}`, this.stateObject(d));
      }
      for (const e of this.itemExtras) {
        await this.adapter.extendObject(`${ch}.${e.id}`, this.stateObject(e));
      }
      this.known.set(item.key, { name: item.name, fresh: true, leftSig: false });
    } else if (known.name !== item.name) {
      await this.adapter.extendObject(ch, { common: { name: item.name } });
      known.name = item.name;
    }
    const values: [string, ioBroker.StateValue][] = [];
    for (const d of this.itemDefs) {
      if (d.value) {
        values.push([d.id, d.value(item)]);
      }
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
    const values: [string, ioBroker.StateValue][] = [];
    for (const d of forCapabilities(PROGRAM_DATAPOINTS, this.driver.capabilities)) {
      if (d.value) {
        values.push([d.id, d.value(snapshot)]);
      }
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
    await writeLastEvents((id, st) => this.adapter.setState(id, st), this.dev, events);
  }

  private async put(id: string, val: ioBroker.StateValue): Promise<void> {
    await this.adapter.setStateChanged(id, { val, ack: true });
  }

  private async removeChannel(key: string): Promise<void> {
    const id = this.ids.idFor(key);
    await this.adapter.delObject(`${this.dev}.downloads.${id}`, { recursive: true });
    this.ids.release(key);
    this.known.delete(key);
  }

  /**
   * @param d a core datapoint or a driver's extra — both describe a state the same way
   * @returns its object
   */
  private stateObject(
    d: Pick<DatapointDef, "id" | "type" | "role" | "unit" | "read" | "write" | "nameKey" | "descKey">,
  ): ioBroker.PartialObject {
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
}
