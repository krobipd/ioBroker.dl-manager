import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { ActionableProblems } from "./lib/actionable-problems";
import { legacyId, parseMaxDownloads, parsePollInterval, parseTreeScope } from "./lib/core/config";
import { settleIds } from "./lib/core/device-id";
import { readDevices } from "./lib/core/devices";
import { ProgramManager, type ManagerAdapter } from "./lib/core/manager";
import { moveObjects, type MoveAdapter } from "./lib/core/move";
import { coveredBy, KnownObjects } from "./lib/core/objects";
import { KnownStates } from "./lib/core/states";
import { ProgramStore, type SettingsRow } from "./lib/core/store";
import { LAST_CHANNEL, lastChannelObject } from "./lib/core/tree";
import { deviceIcon } from "./lib/device-icons";
import { DlDeviceManagement } from "./lib/device-management";
import { errText } from "./lib/err-text";
import { tDesc, tName } from "./lib/i18n";
import { migrateNativeKeys, type NativeKeyMigration } from "./lib/native-key-migration";
import { listMyJdDevices } from "./lib/programs/jdownloader/cloud";
import type { ProgramEntry } from "./lib/core/model";
import { findProgram } from "./lib/programs/registry";

/** Native keys earlier versions declared and this one dropped (fleet helper `native-key-migration`). */
const NATIVE_KEY_MIGRATIONS: NativeKeyMigration[] = [
  // 0.0.1 (the npm placeholder) declared it; the tree settings treeScope and maxDownloads replace it
  { drop: "removeFinished" },
  // up to 0.1.0 the settings table's connection test came in over the old messagebox; `supportedMessages` says it now
  { commonDrop: "messagebox" },
  // up to 0.2.0 the programs lived here — `takeOverPrograms` moved them into the store before this runs
  { drop: "programs" },
];

/** The "last" values up to 0.2.0 → their datapoint in the `last` channel. */
const LAST_MOVES: readonly (readonly [string, string])[] = [
  ["lastFinished", `${LAST_CHANNEL}.finished`],
  ["lastFinishedTime", `${LAST_CHANNEL}.finishedTime`],
  ["lastFailed", `${LAST_CHANNEL}.failed`],
  ["lastFailedTime", `${LAST_CHANNEL}.failedTime`],
];

/** ioBroker adapter that mirrors download programs into the object tree. */
export class DownloadManagerAdapter extends utils.Adapter {
  private manager: ProgramManager | null = null;
  private readonly problems: ActionableProblems;
  /** The own object tree, read once at start — an object is written only when it differs. */
  private readonly known: KnownObjects;
  /** The own states, read once at start — read-only ones are compared in memory. */
  private readonly states: KnownStates;
  /** The programs as cards in the admin (device manager) — it answers the `dm:*` messages itself. */
  private readonly deviceManagement: DlDeviceManagement;
  /** Where the programs live (`<ns>.programs`). */
  private readonly programs: ProgramStore;
  /** Changes of the program rows, one after the other (dialogs and a learned My.JDownloader id). */
  private rowsQueue: Promise<void> = Promise.resolve();

  /**
   * @param options Adapter options
   * @param find registry lookup — a seam for the tests
   */
  public constructor(
    options: Partial<utils.AdapterOptions> = {},
    private readonly find: (type: string) => ProgramEntry | undefined = findProgram,
  ) {
    super({ ...options, name: "dl-manager" });
    const namespace = (): string => this.namespace;
    this.known = new KnownObjects({
      get namespace(): string {
        return namespace();
      },
      extendObject: (id, obj) => this.extendObject(id, obj),
      setForeignObject: (id, obj) => this.setForeignObject(id, obj),
      delObject: (id, opts) => this.delObjectAsync(id, opts),
      getObjectList: params => this.getObjectListAsync(params),
    });
    this.states = new KnownStates({
      get namespace(): string {
        return namespace();
      },
      getStates: pattern => this.getStatesAsync(pattern),
      setState: (id, state) => this.setState(id, state),
    });
    this.programs = new ProgramStore({
      get namespace(): string {
        return namespace();
      },
      getForeignObjectAsync: id => this.getForeignObjectAsync(id),
      setForeignObject: (id, obj) => this.known.replace(id, obj),
      encrypt: v => this.encrypt(v),
      decrypt: v => this.decrypt(v),
    });
    this.problems = new ActionableProblems({
      logWarn: m => this.log.warn(m),
      logInfo: m => this.log.info(m),
      notify: m =>
        void this.registerNotification("dl-manager", "userActionRequired", m).catch((err: unknown) =>
          this.log.debug(`Could not raise a notification: ${errText(err)}`),
        ),
    });
    this.deviceManagement = new DlDeviceManagement(this, {
      readRows: () => this.programs.read(),
      saveRows: rows => this.saveRows(rows),
      hasObject: relId => Promise.resolve(this.known.get(relId) !== undefined),
      readState: async relId => (await this.getStateAsync(relId))?.val ?? undefined,
      test: row => (this.manager ?? this.makeManager()).testProgram(row),
      listJdDevices: (email, password) =>
        listMyJdDevices(email, password, {
          setTimeout: (cb, ms) => this.setTimeout(cb, ms),
          clearTimeout: t => this.clearTimeout(t),
        }),
      icon: deviceIcon,
      iobHost: () => this.host ?? "",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /**
   * Removes a leftover `stopInstance` from `common.supportedMessages` of this instance's own object — with it the host
   * kills the process and `onUnload` never runs (fleet rule). The key itself stays: its `deviceManager` entry switches
   * the message reception on.
   *
   * @returns true when the correction was written; the host restarts the instance, the caller stops.
   */
  private async correctInstanceObject(): Promise<boolean> {
    const id = `system.adapter.${this.namespace}`;
    try {
      const obj = await this.getForeignObjectAsync(id);
      const supported = obj?.common?.supportedMessages as Record<string, unknown> | null | undefined;
      if (supported?.stopInstance === undefined || supported.stopInstance === null) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version — this instance restarts once");
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: { stopInstance: null } } });
      return true;
    } catch (err: unknown) {
      this.log.debug(`Could not check the instance object ${id}: ${errText(err)}`);
      return false;
    }
  }

  /**
   * Up to 0.2.0 the programs lived in the instance object (`native.programs`). They go into the store once, before
   * the native-key migration drops the key — an existing store is never overwritten.
   */
  private async takeOverPrograms(): Promise<void> {
    const rows: unknown = this.config.programs;
    if (!Array.isArray(rows)) {
      return;
    }
    if ((await this.programs.stored()) !== undefined) {
      this.log.debug("the instance settings still hold programs — the store has them already, the old copy goes");
      return;
    }
    const kept = rows.filter((r): r is SettingsRow => !!r && typeof r === "object" && !Array.isArray(r));
    await this.programs.write(kept);
    this.log.info(`${kept.length} program(s) moved out of the instance settings — changes no longer restart it`);
  }

  /** The object and state access of a move (`move.ts`) — every write goes through the known tree and values. */
  private get mover(): MoveAdapter {
    const own = (id: string): boolean => id.startsWith(`${this.namespace}.`);
    return {
      namespace: this.namespace,
      log: this.log,
      getObjectList: params => this.getObjectListAsync(params),
      getForeignObjects: (pattern, type) =>
        this.getForeignObjectsAsync(pattern, type) as Promise<Record<string, ioBroker.Object>>,
      getForeignObjectAsync: id => this.getForeignObjectAsync(id),
      setForeignObject: (id, obj) => (own(id) ? this.known.replace(id, obj) : this.setForeignObject(id, obj)),
      extendForeignObject: (id, patch) =>
        own(id) ? this.known.extend(id, patch) : this.extendForeignObjectAsync(id, patch),
      getForeignStates: pattern => this.getForeignStatesAsync(pattern),
      setForeignState: (id, state) => this.states.set(id, state),
      delForeignObject: async id => {
        await this.known.remove(id, { recursive: false });
        this.states.remove(id, { recursive: false });
      },
    };
  }

  /**
   * Moves a program's device to a new id, with everything that belongs to it.
   *
   * @param oldId the device id so far
   * @param newId the device id from now on
   */
  private async moveDevice(oldId: string, newId: string): Promise<void> {
    const r = await moveObjects(this.mover, [[`${this.namespace}.${oldId}`, `${this.namespace}.${newId}`]], {
      device: true,
    });
    this.log.info(
      `${oldId} is now ${newId} — ${r.objects} object(s), ${r.enums} room/function entr${r.enums === 1 ? "y" : "ies"}, ` +
        `${r.aliases} alias(es); ${r.recordings} recording(s) keep their history`,
    );
  }

  /**
   * Before the programs start: finishes a device move a stop interrupted, gives every row from before 0.3.0 its id
   * (moving its device), and moves the "last" values into their channel.
   */
  private async settleDevices(): Promise<void> {
    const devices = await readDevices(this.managerAdapter());
    for (const [id, native] of devices) {
      if (typeof native.movingTo === "string" && native.movingTo) {
        await this.moveDevice(id, native.movingTo.slice(`${this.namespace}.`.length));
      }
    }
    const stored = await this.programs.read();
    const { rows, moves } = settleIds(stored, this.host ?? "", legacyId);
    for (const [oldId, newId] of moves) {
      if (devices.has(oldId)) {
        await this.moveDevice(oldId, newId);
      }
    }
    await this.programs.write(rows);
    await this.moveLastValues(rows.map(r => r.id).filter((id): id is string => typeof id === "string"));
  }

  /**
   * Up to 0.2.0 the four "last" values sat directly below each device and below `summary`; they move into the `last`
   * channel with value, recording, rooms and aliases.
   *
   * @param programIds the device ids of the programs
   */
  private async moveLastValues(programIds: readonly string[]): Promise<void> {
    const pairs: [string, string][] = [];
    for (const base of ["summary", ...programIds]) {
      const found = LAST_MOVES.filter(([from]) => this.known.get(`${base}.${from}`) !== undefined);
      if (!found.length) {
        continue;
      }
      await this.known.extend(`${base}.${LAST_CHANNEL}`, lastChannelObject());
      for (const [from, to] of found) {
        pairs.push([`${this.namespace}.${base}.${from}`, `${this.namespace}.${base}.${to}`]);
      }
    }
    if (pairs.length) {
      const r = await moveObjects(this.mover, pairs);
      this.log.info(`${pairs.length} "last" value(s) moved into the "${LAST_CHANNEL}" channels`);
      this.log.debug(
        `last values: ${r.enums} room/function entries, ${r.aliases} alias(es), ${r.recordings} recording(s)`,
      );
    }
  }

  /**
   * Stores changed program rows and takes them over at once — no restart. A row still waiting for its My.JDownloader
   * id gets its device id as soon as it has one.
   *
   * @param rows the rows (secrets readable)
   * @returns when the rows are stored and running
   */
  private saveRows(rows: readonly SettingsRow[]): Promise<void> {
    const run = this.rowsQueue.then(async () => {
      const settled = settleIds(rows, this.host ?? "", legacyId);
      await this.programs.write(settled.rows);
      await this.manager?.apply(settled.rows, settled.moves);
    });
    this.rowsQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * My.JDownloader named the id of a program's instance: it goes into the row — and a row that waited for it gets its
   * device id (the device moves).
   *
   * @param programId the program's device id
   * @param deviceId the account's id for the instance
   */
  private learnDeviceId(programId: string, deviceId: string): void {
    void (async () => {
      try {
        const rows = await this.programs.read();
        const i = rows.findIndex(r => r.id === programId);
        if (i < 0 || rows[i].deviceId === deviceId) {
          return;
        }
        rows[i] = { ...rows[i], deviceId };
        await this.saveRows(rows);
      } catch (err: unknown) {
        this.log.warn(`${programId}: could not store the My.JDownloader id (${errText(err)})`);
      }
    })();
  }

  /**
   * Re-applies names and explanations of the manifest objects, so an update reaches existing installations — each only
   * when it differs: js-controller already wrote every manifest object once before `onReady`.
   */
  private async refreshManifestObjects(): Promise<void> {
    let patch: ioBroker.PartialObject;
    patch = { common: { name: tName("channelInfo") } };
    if (!coveredBy(patch, this.known.get("info"))) {
      await this.extendObject("info", patch);
    }
    patch = { common: { name: tName("connection"), desc: tDesc("descConnection") } };
    if (!coveredBy(patch, this.known.get("info.connection"))) {
      await this.extendObject("info.connection", patch);
    }
    patch = { common: { name: tName("programsTotal"), desc: tDesc("descProgramsTotal") } };
    if (!coveredBy(patch, this.known.get("info.programsTotal"))) {
      await this.extendObject("info.programsTotal", patch);
    }
    patch = { common: { name: tName("programsOnline"), desc: tDesc("descProgramsOnline") } };
    if (!coveredBy(patch, this.known.get("info.programsOnline"))) {
      await this.extendObject("info.programsOnline", patch);
    }
    patch = { common: { name: tName("programsAllOnline"), desc: tDesc("descProgramsAllOnline") } };
    if (!coveredBy(patch, this.known.get("info.programsAllOnline"))) {
      await this.extendObject("info.programsAllOnline", patch);
    }
    patch = { common: { name: tName("channelSummary") } };
    if (!coveredBy(patch, this.known.get("summary"))) {
      await this.extendObject("summary", patch);
    }
    patch = { common: { name: tName("summaryDownloading"), desc: tDesc("descSummaryDownloading") } };
    if (!coveredBy(patch, this.known.get("summary.downloading"))) {
      await this.extendObject("summary.downloading", patch);
    }
    patch = { common: { name: tName("summaryActive"), desc: tDesc("descSummaryActive") } };
    if (!coveredBy(patch, this.known.get("summary.active"))) {
      await this.extendObject("summary.active", patch);
    }
    patch = { common: { name: tName("summaryQueued"), desc: tDesc("descSummaryQueued") } };
    if (!coveredBy(patch, this.known.get("summary.queued"))) {
      await this.extendObject("summary.queued", patch);
    }
    patch = { common: { name: tName("summaryDownloadSpeed"), desc: tDesc("descSummaryDownloadSpeed") } };
    if (!coveredBy(patch, this.known.get("summary.downloadSpeed"))) {
      await this.extendObject("summary.downloadSpeed", patch);
    }
    patch = { common: { name: tName("summaryUploadSpeed"), desc: tDesc("descSummaryUploadSpeed") } };
    if (!coveredBy(patch, this.known.get("summary.uploadSpeed"))) {
      await this.extendObject("summary.uploadSpeed", patch);
    }
    patch = { common: { name: tName("summaryPauseAll"), desc: tDesc("descSummaryPauseAll") } };
    if (!coveredBy(patch, this.known.get("summary.pauseAll"))) {
      await this.extendObject("summary.pauseAll", patch);
    }
    patch = { common: { name: tName("channelLast") } };
    if (!coveredBy(patch, this.known.get("summary.last"))) {
      await this.extendObject("summary.last", patch);
    }
    patch = { common: { name: tName("lastFinished"), desc: tDesc("descLastFinished") } };
    if (!coveredBy(patch, this.known.get("summary.last.finished"))) {
      await this.extendObject("summary.last.finished", patch);
    }
    patch = { common: { name: tName("lastFinishedTime") } };
    if (!coveredBy(patch, this.known.get("summary.last.finishedTime"))) {
      await this.extendObject("summary.last.finishedTime", patch);
    }
    patch = { common: { name: tName("lastFailed"), desc: tDesc("descLastFailed") } };
    if (!coveredBy(patch, this.known.get("summary.last.failed"))) {
      await this.extendObject("summary.last.failed", patch);
    }
    patch = { common: { name: tName("lastFailedTime") } };
    if (!coveredBy(patch, this.known.get("summary.last.failedTime"))) {
      await this.extendObject("summary.last.failedTime", patch);
    }
  }

  /** @returns the object and state access of the program manager */
  private managerAdapter(): ManagerAdapter {
    return {
      namespace: this.namespace,
      log: this.log,
      extendObject: (id, obj) => this.known.extend(id, obj),
      setForeignObject: (id, obj) => this.known.replace(id, obj),
      delObject: async (id, opts) => {
        await this.known.remove(id, opts);
        this.states.remove(id, opts);
      },
      getObject: id => this.getObjectAsync(id),
      getForeignObjects: (pattern, type) =>
        this.getForeignObjectsAsync(pattern, type) as Promise<Record<string, ioBroker.Object>>,
      getForeignObjectAsync: id => this.getForeignObjectAsync(id),
      getState: id => this.getStateAsync(id),
      setState: (id, state) => this.states.set(id, state),
      setStateChanged: (id, state) => this.states.put(id, state),
    };
  }

  private makeManager(): ProgramManager {
    return new ProgramManager(
      {
        adapter: this.managerAdapter(),
        timers: {
          setTimeout: (cb, ms) => this.setTimeout(cb, ms),
          clearTimeout: t => this.clearTimeout(t),
        },
        find: this.find,
        problems: {
          report: (key, title, action) => this.problems.report({ key, title, action }),
          resolve: (key, message) => this.problems.resolve(key, message),
        },
        moveDevice: (oldId, newId) => this.moveDevice(oldId, newId),
        onDeviceId: (programId, deviceId) => this.learnDeviceId(programId, deviceId),
      },
      {
        intervalMs: parsePollInterval(this.config.pollInterval),
        scope: parseTreeScope(this.config.treeScope),
        limit: parseMaxDownloads(this.config.maxDownloads),
      },
    );
  }

  private async onReady(): Promise<void> {
    try {
      if (await this.correctInstanceObject()) {
        return;
      }
      await I18n.init(join(this.adapterDir, "admin"), this);
      await this.takeOverPrograms();
      if (await migrateNativeKeys(this, NATIVE_KEY_MIGRATIONS, errText)) {
        return;
      }
      await this.known.load();
      await this.states.load();
      await this.refreshManifestObjects();
      await this.settleDevices();
      // subscribed before the start: a write that arrives while the programs start is forgotten like any other
      await this.subscribeStatesAsync("*");
      this.manager = this.makeManager();
      await this.manager.start(await this.programs.read());
    } catch (err: unknown) {
      this.log.error(`onReady failed: ${errText(err)}`);
    }
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    try {
      if (!state || state.ack) {
        return;
      }
      // a user or a script wrote it: the next poll writes the program's value, even the one written before
      this.states.forget(id);
      if (!this.manager) {
        return;
      }
      await this.manager.onUserWrite(id.slice(this.namespace.length + 1), state.val);
    } catch (err: unknown) {
      this.log.error(`onStateChange failed: ${errText(err)}`);
    }
  }

  private onUnload(callback: () => void): void {
    try {
      const manager = this.manager;
      this.manager = null;
      void (manager ? manager.stop() : this.states.put("info.connection", { val: false, ack: true }))
        .catch((err: unknown) => this.log.debug(`onUnload: final writes rejected: ${errText(err)}`))
        .finally(callback);
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new DownloadManagerAdapter(options);
} else {
  (() => new DownloadManagerAdapter())();
}
