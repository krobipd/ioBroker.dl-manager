import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, ExtraDefinition, ProgramDriver, ProgramSnapshot } from "../../core/model";
import type { DriverDeps, ProgramConfig } from "../registry";
import { QbClient } from "./client";
import { MaindataState, parseQbVersion, qbRunning, toSnapshot } from "./map";

/** Extras of a torrent: recheck (button) and force start (switch, mirrored from `force_start`). */
const EXTRAS: readonly ExtraDefinition[] = [
  {
    id: "recheck",
    level: "item",
    type: "boolean",
    role: "button",
    write: true,
    read: false,
    nameKey: "recheck",
    descKey: "descRecheck",
  },
  {
    id: "forceStart",
    level: "item",
    type: "boolean",
    role: "switch",
    write: true,
    read: true,
    nameKey: "forceStart",
    descKey: "descForceStart",
  },
];

/** qBittorrent 4.6 – 5.3 over WebAPI v2. */
export class QbDriver implements ProgramDriver {
  public readonly type = "qbittorrent";
  public readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "globalPause",
    "itemPause",
    "itemRemove",
    "add",
    "speedLimit",
    "upload",
    "uploadLimit",
    "altSpeed",
    "freeSpace",
    "itemSpeed",
    "itemEta",
    "itemAdded",
    "itemFinished",
    "category",
  ]);
  public readonly extras = EXTRAS;
  private readonly client: QbClient;
  private readonly maindata = new MaindataState();
  private readonly pause: EmulatedPause;
  private version = "";

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.client = new QbClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    if (this.client.needsLogin || !this.version) {
      this.version = (await this.client.get("app/version")).text.trim();
      this.maindata.reset();
    }
    this.maindata.apply((await this.client.get(`sync/maindata?rid=${this.maindata.rid}`)).json());
    const listed = new Set(Object.keys(this.maindata.torrents));
    const session = this.maindata.serverState.session_state;
    const paused =
      this.hasSessionPause() && typeof session === "boolean"
        ? session
        : await this.pause.observe(qbRunning(this.maindata), listed);
    return toSnapshot(this.version, this.maindata, paused, m => this.deps.log.debug(m));
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    const [major] = parseQbVersion(this.version);
    const stop = major >= 5 ? "torrents/stop" : "torrents/pause";
    const start = major >= 5 ? "torrents/start" : "torrents/resume";
    switch (cmd.kind) {
      case "pause":
        await this.client.post(stop, { hashes: cmd.key });
        return;
      case "resume":
        await this.client.post(start, { hashes: cmd.key });
        return;
      case "remove":
        await this.client.post("torrents/delete", { hashes: cmd.key, deleteFiles: "false" });
        return;
      case "add": {
        const held = (await this.pause.isPaused()) && !this.hasSessionPause();
        const stopped = held ? { [major >= 5 ? "stopped" : "paused"]: "true" } : {};
        await this.client.post("torrents/add", { urls: cmd.url, ...stopped }, true);
        return;
      }
      case "pauseAll":
        if (this.hasSessionPause()) {
          await this.client.post("transfer/pauseSession");
          return;
        }
        await this.pause.pause([...qbRunning(this.maindata)], async keys => {
          await this.client.post(stop, { hashes: keys.join("|") });
        });
        return;
      case "resumeAll":
        if (this.hasSessionPause()) {
          await this.client.post("transfer/resumeSession");
          return;
        }
        await this.pause.resume(async keys => {
          await this.client.post(start, { hashes: keys.join("|") });
        });
        return;
      case "setSpeedLimit":
        await this.client.post("transfer/setDownloadLimit", { limit: String(cmd.bps) });
        return;
      case "setUploadLimit":
        await this.client.post("transfer/setUploadLimit", { limit: String(cmd.bps) });
        return;
      case "setAltSpeed":
        await this.client.post("transfer/setSpeedLimitsMode", { mode: cmd.on ? "1" : "0" });
        return;
      case "extra":
        if (cmd.name === "recheck" && cmd.key) {
          await this.client.post("torrents/recheck", { hashes: cmd.key });
          return;
        }
        if (cmd.name === "forceStart" && cmd.key) {
          await this.client.post("torrents/setForceStart", {
            hashes: cmd.key,
            value: cmd.value === true ? "true" : "false",
          });
          return;
        }
        throw new ProtocolError(`qbittorrent: unknown extra ${cmd.name}`);
      default:
        throw new ProtocolError("qbittorrent: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /** @returns whether this version has a real session pause (5.3, WebAPI 2.16.2) */
  private hasSessionPause(): boolean {
    const [major, minor] = parseQbVersion(this.version);
    return major > 5 || (major === 5 && minor >= 3);
  }
}
