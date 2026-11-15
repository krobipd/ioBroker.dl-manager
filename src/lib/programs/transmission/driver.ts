import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import { idIn, recordsIn } from "../../core/answer";
import { asRecord, asText, toKiB } from "../../core/units";
import type { Capability, Command, ProgramDriver, ProgramSnapshot, DriverDeps, ProgramConfig } from "../../core/model";
import { TrClient, type TrType } from "./client";
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
  "metadata_percent_complete",
];

/** What Transmission can do. */
const TRANSMISSION: readonly Capability[] = [
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
];

/**
 * Vuze's Web Remote plugin (xmwebui 0.6.5): no labels in torrent-get, and the alternative speed is a fixed answer —
 * session-get sends `alt-speed-enabled` false and 50/50 KB/s marked TODO (XMWebUIPlugin.java 2753–2755), session-set
 * skips every `alt-speed*` key (2933).
 */
const VUZE: readonly Capability[] = TRANSMISSION.filter(c => c !== "altSpeed" && c !== "category");

/**
 * Vuze's ETA for a download without speed: `Constants.CRAPPY_INFINITE_AS_LONG = 10000*365*24*3600` is computed in int
 * and overflows to 1827387392 (Constants.java 123, PEPeerControlImpl.java 2845); the plugin checks for the long value
 * 315360000000 and sends the overflow as seconds (XMWebUIPlugin.java `torrentGet_eta`; recorded for a torrent without
 * a source, run 43682528277).
 */
const VUZE_ETA_INFINITE = 1827387392;

/**
 * Transmission 4.0 / 4.1 and Vuze (Web Remote plugin) over Transmission's RPC. The global pause is made by the adapter
 * (plan § 5.3).
 */
export class TrDriver implements ProgramDriver {
  public readonly type: TrType;
  public readonly capabilities: ReadonlySet<Capability>;
  public readonly extras = [];
  private readonly client: TrClient;
  private readonly pause: EmulatedPause;
  private unit: number;
  private running: string[] = [];

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.type = cfg.type === "vuze" ? "vuze" : "transmission";
    this.capabilities = new Set(this.type === "vuze" ? VUZE : TRANSMISSION);
    // Vuze sends no `units`: its limits are the core's KB/s (CORE_PARAM_INT_MAX_DOWNLOAD_SPEED_KBYTES_PER_SEC) — also
    // for a limit set before the first poll; Transmission's unit comes with each session_get
    this.unit = this.type === "vuze" ? 1024 : 1000;
    this.client = new TrClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
  }

  /** @returns one complete query (a full torrent_get — `recently_active` loses removals after 60 s) */
  public async poll(): Promise<ProgramSnapshot> {
    const got = await this.client.call("torrent_get", { fields: FIELDS });
    const session = await this.client.call("session_get");
    const stats = await this.client.call("session_stats");
    const dir = asText(session.download_dir);
    const free = dir ? await this.client.call("free_space", { path: dir }) : {};
    if (this.type === "transmission") {
      this.unit = speedUnit(session);
    }
    const what = this.type === "vuze" ? "Vuze's torrent-get" : "Transmission's torrent_get";
    const torrents = recordsIn(got.torrents, what);
    const hashes = torrents.map(t => idIn(t, "hash_string", what, "text"));
    // Vuze's torrent-stop and torrent-start reach no metadata download (metadataPercentComplete 0, every other
    // download 1): XMWebUIPlugin.java `getDownloads(ids, false)` leaves them out — run 43682528277 kept one at 4
    const stoppable = (t: Record<string, unknown>): boolean =>
      this.type !== "vuze" || t.metadata_percent_complete !== 0;
    this.running = hashes.filter((_, i) => torrents[i].status !== 0 && stoppable(torrents[i]));
    const paused = await this.pause.observe(new Set(this.running), new Set(hashes));
    // Vuze: `version` is the plugin's, `az-version` Vuze's own (XMWebUIPlugin.java session-get)
    const raw = this.type === "vuze" ? session.az_version : session.version;
    const version = typeof raw === "string" ? raw.split(" ")[0] : "";
    const etaUnknown = this.type === "vuze" ? [VUZE_ETA_INFINITE] : [];
    return toSnapshot(
      version,
      torrents,
      session,
      stats,
      free,
      paused,
      m => this.deps.log.debug(m),
      this.unit,
      etaUnknown,
    );
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    const kb = (bps: number): number => toKiB(bps, this.unit);
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
      case "add": {
        const held = await this.pause.isPaused();
        const res = await this.client.call("torrent_add", { filename: cmd.url, ...(held ? { paused: true } : {}) });
        // a duplicate is a torrent Transmission already had — the user's, never held by the pause
        const added = asRecord(res.torrent_added).hash_string;
        if (held && typeof added === "string") {
          await this.pause.hold(added);
        }
        return;
      }
      case "pauseAll":
        await this.pause.pause(this.running, async keys => {
          await this.client.call("torrent_stop", { ids: keys });
          return keys;
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
        if (!this.capabilities.has("altSpeed")) {
          throw new ProtocolError(`${this.type}: command not supported`);
        }
        await this.client.call("session_set", { alt_speed_enabled: cmd.on });
        return;
      default:
        throw new ProtocolError(`${this.type}: command not supported`);
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }
}
