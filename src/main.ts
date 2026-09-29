import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { ActionableProblems } from "./lib/actionable-problems";
import { parseMaxDownloads, parsePollInterval, parseTreeScope } from "./lib/core/config";
import { ProgramManager } from "./lib/core/manager";
import { coveredBy, KnownObjects } from "./lib/core/objects";
import { KnownStates } from "./lib/core/states";
import { errText } from "./lib/err-text";
import { tDesc, tName } from "./lib/i18n";
import { migrateNativeKeys, type NativeKeyMigration } from "./lib/native-key-migration";
import { findProgram, type ProgramEntry } from "./lib/programs/registry";

/** Native keys earlier versions declared and this one dropped (fleet helper `native-key-migration`). */
const NATIVE_KEY_MIGRATIONS: NativeKeyMigration[] = [
  // 0.0.1 (the npm placeholder) declared it; the tree settings treeScope and maxDownloads replace it
  { drop: "removeFinished" },
];

/** ioBroker adapter that mirrors download programs into the object tree. */
export class DownloadManagerAdapter extends utils.Adapter {
  private manager: ProgramManager | null = null;
  private readonly problems: ActionableProblems;
  /** The own object tree, read once at start — an object is written only when it differs. */
  private readonly known: KnownObjects;
  /** The own states, read once at start — read-only ones are compared in memory. */
  private readonly states: KnownStates;

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
    this.states = new KnownStates(
      {
        get namespace(): string {
          return namespace();
        },
        getStates: pattern => this.getStatesAsync(pattern),
        setState: (id, state) => this.setState(id, state),
        setStateChanged: (id, state) => this.setStateChangedAsync(id, state),
      },
      id => (this.known.get(id) as ioBroker.Object | undefined)?.common?.write === false,
    );
    this.problems = new ActionableProblems({
      logWarn: m => this.log.warn(m),
      logInfo: m => this.log.info(m),
      notify: m =>
        void this.registerNotification("dl-manager", "userActionRequired", m).catch((err: unknown) =>
          this.log.debug(`Could not raise a notification: ${errText(err)}`),
        ),
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /**
   * Null `common.supportedMessages` on this instance's own object when the key exists at all — with
   * `stopInstance` in it the host kills the process and `onUnload` never runs (fleet rule).
   *
   * @returns true when the correction was written; the host restarts the instance, the caller stops.
   */
  private async correctInstanceObject(): Promise<boolean> {
    const id = `system.adapter.${this.namespace}`;
    try {
      const obj = await this.getForeignObjectAsync(id);
      const supported = obj?.common?.supportedMessages;
      if (supported === undefined || supported === null) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version — this instance restarts once");
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: null } });
      return true;
    } catch (err: unknown) {
      this.log.debug(`Could not check the instance object ${id}: ${errText(err)}`);
      return false;
    }
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
    patch = { common: { name: tName("lastFinished"), desc: tDesc("descLastFinished") } };
    if (!coveredBy(patch, this.known.get("summary.lastFinished"))) {
      await this.extendObject("summary.lastFinished", patch);
    }
    patch = { common: { name: tName("lastFinishedTime") } };
    if (!coveredBy(patch, this.known.get("summary.lastFinishedTime"))) {
      await this.extendObject("summary.lastFinishedTime", patch);
    }
    patch = { common: { name: tName("lastFailed"), desc: tDesc("descLastFailed") } };
    if (!coveredBy(patch, this.known.get("summary.lastFailed"))) {
      await this.extendObject("summary.lastFailed", patch);
    }
    patch = { common: { name: tName("lastFailedTime") } };
    if (!coveredBy(patch, this.known.get("summary.lastFailedTime"))) {
      await this.extendObject("summary.lastFailedTime", patch);
    }
  }

  private makeManager(): ProgramManager {
    return new ProgramManager(
      {
        adapter: {
          namespace: this.namespace,
          log: this.log,
          extendObject: (id, obj) => this.known.extend(id, obj),
          setForeignObject: (id, obj) => this.known.replace(id, obj),
          delObject: (id, opts) => this.known.remove(id, opts),
          getObject: id => this.getObjectAsync(id),
          getForeignObjects: (pattern, type) =>
            this.getForeignObjectsAsync(pattern, type) as Promise<Record<string, ioBroker.Object>>,
          getForeignObjectAsync: id => this.getForeignObjectAsync(id),
          getState: id => this.getStateAsync(id),
          setState: (id, state) => this.states.set(id, state),
          setStateChanged: (id, state) => this.states.put(id, state),
        },
        timers: {
          setTimeout: (cb, ms) => this.setTimeout(cb, ms),
          clearTimeout: t => this.clearTimeout(t),
        },
        find: this.find,
        // the table stores the secrets as typed, protected by protectedNative: json-config >= 8.5.0 never decrypts
        // an encryptedAttributes cell on load and encrypts it twice on the next save (ioBroker/json-config#179)
        decrypt: v => v,
        problems: {
          report: (key, title, action) => this.problems.report({ key, title, action }),
          resolve: (key, msg) => this.problems.resolve(key, msg),
        },
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
      if (await migrateNativeKeys(this, NATIVE_KEY_MIGRATIONS, errText)) {
        return;
      }
      await I18n.init(join(this.adapterDir, "admin"), this);
      await this.known.load();
      await this.states.load();
      await this.refreshManifestObjects();
      this.manager = this.makeManager();
      await this.manager.start(this.config.programs);
      await this.subscribeStatesAsync("*");
    } catch (err: unknown) {
      this.log.error(`onReady failed: ${errText(err)}`);
    }
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    try {
      if (!state || state.ack || !this.manager) {
        return;
      }
      await this.manager.onUserWrite(id.slice(this.namespace.length + 1), state.val);
    } catch (err: unknown) {
      this.log.error(`onStateChange failed: ${errText(err)}`);
    }
  }

  private async onMessage(obj: ioBroker.Message): Promise<void> {
    try {
      if (!obj?.callback) {
        return;
      }
      if (obj.command !== "testConnections") {
        this.sendTo(obj.from, obj.command, { error: `Unknown command: ${obj.command}` }, obj.callback);
        return;
      }
      const message = obj.message as { programs?: unknown } | null | undefined;
      const programs = typeof message === "object" && message ? message.programs : undefined;
      const result = await (this.manager ?? this.makeManager()).testConnections(programs);
      this.sendTo(obj.from, obj.command, { result }, obj.callback);
    } catch (err: unknown) {
      this.log.error(`onMessage failed: ${errText(err)}`);
      if (obj?.callback) {
        this.sendTo(obj.from, obj.command, { error: errText(err) }, obj.callback);
      }
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
