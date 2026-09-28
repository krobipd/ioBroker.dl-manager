import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { errText } from "./lib/err-text";
import { tDesc, tName } from "./lib/i18n";

/** ioBroker adapter that mirrors download programs into the object tree. */
export class DownloadManagerAdapter extends utils.Adapter {
  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "download-manager" });
    this.on("ready", this.onReady.bind(this));
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

  /** Re-applies names and explanations of the manifest objects, so an update reaches existing installations. */
  private async refreshManifestObjects(): Promise<void> {
    await this.extendObject("info", {
      common: { name: tName("channelInfo") },
    });
    await this.extendObject("info.connection", {
      common: { name: tName("connection"), desc: tDesc("descConnection") },
    });
    await this.extendObject("info.programsTotal", {
      common: { name: tName("programsTotal"), desc: tDesc("descProgramsTotal") },
    });
    await this.extendObject("info.programsOnline", {
      common: { name: tName("programsOnline"), desc: tDesc("descProgramsOnline") },
    });
    await this.extendObject("info.programsAllOnline", {
      common: { name: tName("programsAllOnline"), desc: tDesc("descProgramsAllOnline") },
    });
    await this.extendObject("summary", {
      common: { name: tName("channelSummary") },
    });
    await this.extendObject("summary.downloading", {
      common: { name: tName("summaryDownloading"), desc: tDesc("descSummaryDownloading") },
    });
    await this.extendObject("summary.active", {
      common: { name: tName("summaryActive"), desc: tDesc("descSummaryActive") },
    });
    await this.extendObject("summary.queued", {
      common: { name: tName("summaryQueued"), desc: tDesc("descSummaryQueued") },
    });
    await this.extendObject("summary.downloadSpeed", {
      common: { name: tName("summaryDownloadSpeed"), desc: tDesc("descSummaryDownloadSpeed") },
    });
    await this.extendObject("summary.uploadSpeed", {
      common: { name: tName("summaryUploadSpeed"), desc: tDesc("descSummaryUploadSpeed") },
    });
    await this.extendObject("summary.pauseAll", {
      common: { name: tName("summaryPauseAll"), desc: tDesc("descSummaryPauseAll") },
    });
    await this.extendObject("summary.lastFinished", {
      common: { name: tName("lastFinished"), desc: tDesc("descLastFinished") },
    });
    await this.extendObject("summary.lastFinishedTime", {
      common: { name: tName("lastFinishedTime") },
    });
    await this.extendObject("summary.lastFailed", {
      common: { name: tName("lastFailed"), desc: tDesc("descLastFailed") },
    });
    await this.extendObject("summary.lastFailedTime", {
      common: { name: tName("lastFailedTime") },
    });
  }

  private async onReady(): Promise<void> {
    try {
      if (await this.correctInstanceObject()) {
        return;
      }
      await I18n.init(join(this.adapterDir, "admin"), this);
      await this.refreshManifestObjects();
      await this.setState("info.connection", { val: false, ack: true });
    } catch (err: unknown) {
      this.log.error(`onReady failed: ${errText(err)}`);
    }
  }

  private onUnload(callback: () => void): void {
    try {
      void this.setState("info.connection", { val: false, ack: true })
        .catch((err: unknown) => this.log.debug(`onUnload: final state rejected: ${errText(err)}`))
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
