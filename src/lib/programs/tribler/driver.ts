import { idIn, recordIn, recordsIn } from "../../core/answer";
import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, DriverDeps, ProgramConfig, ProgramDriver, ProgramSnapshot } from "../../core/model";
import { asText } from "../../core/units";
import { ProgramVersion } from "../../core/version";
import { errText } from "../../err-text";
import { TblClient } from "./client";
import { toSnapshot } from "./map";

/** Stopped already: the global pause leaves these. */
const STOPPED = new Set(["STOPPED", "STOPPED_ON_ERROR"]);

/**
 * A download whose libtorrent handle is not there yet — its anonymous circuits or the DHT are not ready
 * (downloads_endpoint.py `_get_extended_status`). A stop only marks it `user_stopped` (download.py `stop`).
 */
const NO_HANDLE = new Set(["LOADING", "CIRCUITS", "EXIT_NODES"]);

/** The two rates the limit commands change (bytes per second, 0 = unlimited). */
type RateKey = "max_download_rate" | "max_upload_rate";

/**
 * Tribler over its REST API. It has no pause for everything — the adapter makes it (plan § 5.3), like Transmission's.
 * A stop that reaches a download before its libtorrent handle exists only marks it, and Tribler may start it once the
 * handle comes: the same add and stop held in one run (recording `early-stop`) and not in another (8.4.2
 * `lost-early-stop`). Such a download stays out of what decides whether the user ended the pause, and is stopped
 * again when a poll shows it running.
 */
export class TblDriver implements ProgramDriver {
  public readonly type = "tribler";
  public readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "globalPause",
    "itemPause",
    "itemRemove",
    "add",
    "speedLimit",
    "upload",
    "uploadLimit",
    "itemSpeed",
    "itemEta",
    "itemAdded",
    "itemFinished",
    "itemError",
  ]);
  public readonly extras = [];
  private readonly client: TblClient;
  private readonly pause: EmulatedPause;
  private readonly version = new ProgramVersion();
  private running: string[] = [];
  /** Every download's status at the last poll. */
  private statuses = new Map<string, string>();
  /** Held downloads whose stop went out while no handle stood behind their status. */
  private unsure = new Set<string>();

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.client = new TblClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
  }

  /** @returns one complete query */
  public poll(): Promise<ProgramSnapshot> {
    return this.version.poll(
      async () =>
        asText(
          recordIn(await this.client.send("GET", "/api/versioning/versions/current"), "Tribler's version").version,
        ),
      version => this.query(version),
    );
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pause":
        await this.stop(cmd.key);
        return;
      case "resume":
        await this.client.send("PATCH", `/api/downloads/${cmd.key}`, { state: "resume" });
        return;
      case "remove":
        // remove_data false keeps the files (downloads_endpoint.py delete_download)
        await this.client.send("DELETE", `/api/downloads/${cmd.key}`, { remove_data: false });
        return;
      case "add": {
        // the uri alone: hops and safe seeding are the installation's download defaults, as in Tribler's own dialog
        const added = recordIn(
          await this.client.send("PUT", "/api/downloads", { uri: cmd.url }),
          "Tribler's add",
        ).infohash;
        // asked after the answer, so a pause set meanwhile counts; the download has no handle yet
        if (typeof added === "string" && (await this.pause.isPaused())) {
          await this.stop(added);
          this.unsure.add(added);
          await this.pause.hold(added);
        }
        return;
      }
      case "pauseAll":
        // one download per call: one Tribler no longer knows (404, ended or gone meanwhile) is skipped
        await this.pause.pauseEach(
          this.running,
          async k => {
            await this.stop(k);
            if (NO_HANDLE.has(this.statuses.get(k) ?? "")) {
              this.unsure.add(k);
            }
          },
          (k, err) => this.deps.log.debug(`tribler: ${k} not paused — ${errText(err)}`),
        );
        return;
      case "resumeAll":
        await this.pause.resumeEach(
          k => this.client.send("PATCH", `/api/downloads/${k}`, { state: "resume" }),
          (k, err) => this.deps.log.debug(`tribler: ${k} not resumed — ${errText(err)}`),
        );
        this.unsure.clear();
        return;
      case "setSpeedLimit":
        await this.setRate("max_download_rate", cmd.bps);
        return;
      case "setUploadLimit":
        await this.setRate("max_upload_rate", cmd.bps);
        return;
      default:
        throw new ProtocolError("Tribler: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /**
   * @param version the program version
   * @returns the snapshot of the download list and the settings
   */
  private async query(version: string): Promise<ProgramSnapshot> {
    const what = "Tribler's download list";
    const downloads = recordsIn(recordIn(await this.client.send("GET", "/api/downloads"), what).downloads, what);
    const settings = recordIn(
      recordIn(await this.client.send("GET", "/api/settings"), "Tribler's settings").settings,
      "Tribler's settings",
    );
    const hashes = downloads.map(d => idIn(d, "infohash", what, "text"));
    this.statuses = new Map(hashes.map((h, i) => [h, asText(downloads[i].status)]));
    // what the global pause stops: every download not stopped yet, one still waiting for its circuits too
    this.running = hashes.filter(h => !STOPPED.has(this.statuses.get(h) ?? ""));
    if (!(await this.pause.isPaused())) {
      this.unsure.clear();
    }
    // what tells that the user started a held download himself: a running status with a handle behind it, never one
    // of a download whose stop may not have reached it
    const shown = this.running.filter(h => !NO_HANDLE.has(this.statuses.get(h) ?? "") && !this.unsure.has(h));
    await this.stopAgain();
    const paused = await this.pause.observe(new Set(shown), new Set(hashes));
    return toSnapshot(version, downloads, settings, paused, m => this.deps.log.debug(m));
  }

  /**
   * The unsure downloads of this poll: gone ones are forgotten, a stopped one or one still without its handle is
   * watched on, one that runs with its handle is stopped again — that stop holds (8.4.2 `lost-running`).
   */
  private async stopAgain(): Promise<void> {
    for (const h of [...this.unsure]) {
      const status = this.statuses.get(h);
      if (status === undefined) {
        this.unsure.delete(h);
        continue;
      }
      if (STOPPED.has(status) || NO_HANDLE.has(status)) {
        continue;
      }
      try {
        await this.stop(h);
        this.unsure.delete(h);
      } catch (err) {
        this.deps.log.debug(`Tribler: stopping ${h} again failed: ${errText(err)}`);
      }
    }
  }

  /** @param key the download to stop */
  private async stop(key: string): Promise<void> {
    await this.client.send("PATCH", `/api/downloads/${key}`, { state: "stop" });
  }

  /**
   * Writes the whole libtorrent section back with the one rate changed: 8.0.7 replaces the section with the body's
   * (settings_endpoint.py `_recursive_merge_settings`, 8.0.7 `partial` — the section down to the one key sent, the
   * download defaults and the port among the lost), 8.4 merges value by value. Bytes per second, 0 = unlimited
   * (download_manager.py hands them to libtorrent unchanged; Tribler's settings page writes KiB/s × 1024,
   * ui/…/Settings/Bandwidth.tsx).
   *
   * @param key the rate
   * @param bps bytes per second, 0 = unlimited
   */
  private async setRate(key: RateKey, bps: number): Promise<void> {
    const settings = recordIn(
      recordIn(await this.client.send("GET", "/api/settings"), "Tribler's settings").settings,
      "Tribler's settings",
    );
    const lt = recordIn(settings.libtorrent, "Tribler's libtorrent settings");
    await this.client.send("POST", "/api/settings", { libtorrent: { ...lt, [key]: Math.max(0, Math.round(bps)) } });
  }
}
