import { ProtocolError, UnreachableError } from "../../core/errors";
import type { Capability, Command, ProgramDriver, ProgramSnapshot, DriverDeps, ProgramConfig } from "../../core/model";
import { DlClient } from "./client";
import { DL_KEYS, toSnapshot } from "./map";

/** Deluge 2.x through deluge-web. Real session pause; limits in KiB/s; no alternative speed in the core. */
export class DlDriver implements ProgramDriver {
  public readonly type = "deluge";
  public readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "globalPause",
    "itemPause",
    "itemRemove",
    "add",
    "speedLimit",
    "upload",
    "uploadLimit",
    "freeSpace",
    "itemSpeed",
    "itemEta",
    "itemAdded",
    "itemFinished",
    "category",
    "itemError",
  ]);
  public readonly extras = [];
  private readonly client: DlClient;

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.client = new DlClient(cfg, deps);
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    const ui = await this.client.call("web.update_ui", [DL_KEYS, {}]);
    // a restarted daemon leaves the web UI running without it: no torrent list — never an empty one
    if ((ui as { connected?: unknown } | null)?.connected !== true) {
      this.client.reset();
      throw new UnreachableError("deluge: the web UI has lost its daemon — connecting again");
    }
    const config = await this.client.call("core.get_config_values", [["max_download_speed", "max_upload_speed"]]);
    const paused = (await this.client.call("core.is_session_paused")) === true;
    return toSnapshot(this.client.version, ui, config, paused, m => this.deps.log.debug(m));
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    const kib = (bps: number): number => (bps > 0 ? bps / 1024 : -1);
    switch (cmd.kind) {
      case "pause":
        await this.client.call("core.pause_torrent", [[cmd.key]]);
        return;
      case "resume":
        await this.client.call("core.resume_torrent", [[cmd.key]]);
        return;
      case "remove":
        await this.client.call("core.remove_torrent", [cmd.key, false]);
        return;
      case "add":
        await this.client.call(cmd.url.startsWith("magnet:") ? "core.add_torrent_magnet" : "core.add_torrent_url", [
          cmd.url,
          {},
        ]);
        return;
      case "pauseAll":
        await this.client.call("core.pause_session");
        return;
      case "resumeAll":
        await this.client.call("core.resume_session");
        return;
      case "setSpeedLimit":
        await this.client.call("core.set_config", [{ max_download_speed: kib(cmd.bps) }]);
        return;
      case "setUploadLimit":
        await this.client.call("core.set_config", [{ max_upload_speed: kib(cmd.bps) }]);
        return;
      default:
        throw new ProtocolError("deluge: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }
}
