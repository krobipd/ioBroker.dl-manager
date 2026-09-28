import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, ProgramDriver, ProgramSnapshot } from "../../core/model";
import type { DriverDeps, ProgramConfig } from "../registry";
import { TrClient } from "./client";
import { speedUnit, toSnapshot } from "./map";

/** The torrent fields the driver reads (4.1 names; the client converts them for legacy). */
const FIELDS = [
  "hash_string",
  "name",
  "status",
  "error",
  "error_string",
  "percent_done",
  "size_when_done",
  "left_until_done",
  "rate_download",
  "rate_upload",
  "eta",
  "upload_ratio",
  "added_date",
  "done_date",
  "labels",
  "is_stalled",
];

/** Transmission 4.0 / 4.1 over RPC. The global pause is made by the adapter (plan § 5.3). */
export class TrDriver implements ProgramDriver {
  public readonly type = "transmission";
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
    "itemError",
  ]);
  public readonly extras = [];
  private readonly client: TrClient;
  private readonly pause: EmulatedPause;
  private unit = 1000;
  private running: string[] = [];

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.client = new TrClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
  }

  /** @returns one complete query (a full torrent_get — `recently_active` loses removals after 60 s) */
  public async poll(): Promise<ProgramSnapshot> {
    const got = await this.client.call("torrent_get", { fields: FIELDS });
    const session = await this.client.call("session_get");
    const stats = await this.client.call("session_stats");
    const dir = typeof session.download_dir === "string" ? session.download_dir : "";
    const free = dir ? await this.client.call("free_space", { path: dir }) : {};
    this.unit = speedUnit(session);
    const torrents = Array.isArray(got.torrents) ? (got.torrents as Record<string, unknown>[]) : [];
    const keyed = torrents.filter(t => typeof t.hash_string === "string");
    this.running = keyed.filter(t => t.status !== 0).map(t => String(t.hash_string));
    const paused = await this.pause.observe(new Set(this.running), new Set(keyed.map(t => String(t.hash_string))));
    const version = typeof session.version === "string" ? session.version.split(" ")[0] : "";
    return toSnapshot(version, torrents, session, stats, free, paused, m => this.deps.log.debug(m));
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    const kb = (bps: number): number => Math.max(1, Math.round(bps / this.unit));
    switch (cmd.kind) {
      case "pause":
        await this.client.call("torrent_stop", { ids: [cmd.key] });
        return;
      case "resume":
        await this.client.call("torrent_start", { ids: [cmd.key] });
        return;
      case "remove":
        await this.client.call("torrent_remove", { ids: [cmd.key], delete_local_data: false });
        return;
      case "add":
        await this.client.call("torrent_add", {
          filename: cmd.url,
          ...((await this.pause.isPaused()) ? { paused: true } : {}),
        });
        return;
      case "pauseAll":
        await this.pause.pause(this.running, async keys => {
          await this.client.call("torrent_stop", { ids: keys });
        });
        return;
      case "resumeAll":
        await this.pause.resume(async keys => {
          await this.client.call("torrent_start", { ids: keys });
        });
        return;
      case "setSpeedLimit":
        await this.client.call("session_set", {
          ...(cmd.bps > 0 ? { speed_limit_down: kb(cmd.bps) } : {}),
          speed_limit_down_enabled: cmd.bps > 0,
        });
        return;
      case "setUploadLimit":
        await this.client.call("session_set", {
          ...(cmd.bps > 0 ? { speed_limit_up: kb(cmd.bps) } : {}),
          speed_limit_up_enabled: cmd.bps > 0,
        });
        return;
      case "setAltSpeed":
        await this.client.call("session_set", { alt_speed_enabled: cmd.on });
        return;
      default:
        throw new ProtocolError("transmission: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }
}
