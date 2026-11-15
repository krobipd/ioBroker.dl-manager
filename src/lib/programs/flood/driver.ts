import { idIn, recordIn, recordMapIn } from "../../core/answer";
import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, DriverDeps, ProgramConfig, ProgramDriver, ProgramSnapshot } from "../../core/model";
import { ProgramVersion } from "../../core/version";
import { errText } from "../../err-text";
import { FloodClient } from "./client";
import { isLoading, isRunning, limitBps, toSnapshot, type FloodTorrent } from "./map";

/** The two limits the commands change (bytes per second, 0 = unlimited — shared/types/ClientSettings.ts). */
type LimitKey = "throttleGlobalDownSpeed" | "throttleGlobalUpSpeed";

/**
 * Flood (jesec/flood) in front of rTorrent, qBittorrent, Transmission or Deluge: one torrent list for all of them, keyed
 * by the upper-case info hash. Flood has no pause for everything — the adapter makes it (plan § 5.3), like
 * Transmission's: stop what runs, start exactly those. Which backend stands behind it, the API does not say.
 */
export class FloodDriver implements ProgramDriver {
  public readonly type = "flood";
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
    "category",
    "itemError",
  ]);
  public readonly extras = [];
  private readonly client: FloodClient;
  private readonly pause: EmulatedPause;
  private readonly version = new ProgramVersion();
  /** Flood before 4.12 has no OpenAPI document — not asked again until a poll fails (Flood may have been updated). */
  private versionless = false;
  private running: string[] = [];

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.client = new FloodClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    try {
      return await this.version.poll(
        () => this.readVersion(),
        version => this.query(version),
      );
    } catch (err) {
      this.versionless = false;
      throw err;
    }
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pause":
        await this.client.send("POST", "/torrents/stop", { hashes: [cmd.key] });
        return;
      case "resume":
        await this.client.send("POST", "/torrents/start", { hashes: [cmd.key] });
        return;
      case "remove":
        // deleteData false keeps the files (shared/schema/api/torrents.ts `deleteTorrentsSchema`)
        await this.client.send("POST", "/torrents/delete", { hashes: [cmd.key], deleteData: false });
        return;
      case "add":
        await this.add(cmd.url);
        return;
      case "pauseAll":
        await this.pause.pause(this.running, keys => this.bulk("/torrents/stop", keys));
        return;
      case "resumeAll":
        await this.pause.resume(async keys => {
          await this.bulk("/torrents/start", keys);
        });
        return;
      case "setSpeedLimit":
        await this.setLimit("throttleGlobalDownSpeed", cmd.bps);
        return;
      case "setUploadLimit":
        await this.setLimit("throttleGlobalUpSpeed", cmd.bps);
        return;
      default:
        throw new ProtocolError("Flood: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /** @returns Flood's version, "" before 4.12 */
  private async readVersion(): Promise<string> {
    if (this.versionless) {
      return "";
    }
    const version = await this.client.version();
    this.versionless = version === null;
    return version ?? "";
  }

  /**
   * @param version the program version
   * @returns the snapshot of the torrent list and the limits
   */
  private async query(version: string): Promise<ProgramSnapshot> {
    const list = await this.torrents();
    const settings = await this.readSettings();
    this.running = list.filter(([, t]) => isRunning(t)).map(([h]) => h);
    const loading = new Set(list.filter(([, t]) => isLoading(t)).map(([h]) => h));
    const paused = await this.pause.observe(loading, new Set(list.map(([h]) => h)));
    return toSnapshot(version, list, settings, paused, m => this.deps.log.debug(m));
  }

  /** @returns `GET /api/torrents` → `torrents` by hash, every entry with its hash */
  private async torrents(): Promise<[string, FloodTorrent][]> {
    const what = "Flood's torrent list";
    const list = recordMapIn(recordIn(await this.client.send("GET", "/torrents"), what).torrents, what);
    for (const [, t] of list) {
      idIn(t, "hash", what, "text");
    }
    return list;
  }

  /**
   * Stops or starts a list of torrents in one call. A hash that is gone since the last poll makes Deluge and rTorrent
   * refuse the call with 500 (recording `stop-mixed`); Deluge's `core.pause_torrents` ends its loop at the unknown hash,
   * so the call goes once more with the hashes still listed.
   *
   * @param path `/torrents/stop` or `/torrents/start`
   * @param keys the hashes
   * @returns the hashes the call went out for
   */
  private async bulk(path: string, keys: string[]): Promise<string[]> {
    try {
      await this.client.send("POST", path, { hashes: keys });
      return keys;
    } catch (err) {
      if (!(err instanceof ProtocolError)) {
        throw err;
      }
      const listed = new Set((await this.torrents()).map(([h]) => h));
      const left = keys.filter(k => listed.has(k));
      if (left.length === keys.length) {
        throw err;
      }
      if (left.length) {
        await this.client.send("POST", path, { hashes: left });
      }
      return left;
    }
  }

  /**
   * The limits are a part of the poll that may fail alone: Flood 4.11 in front of rTorrent 0.16 lists the torrents but
   * answers every settings read with 500 (recording 4.11.0-rtorrent `empty`) — the torrents stay, the limits are empty.
   *
   * @returns the client settings, null when Flood refused them
   */
  private async readSettings(): Promise<Record<string, unknown> | null> {
    try {
      return recordIn(await this.client.send("GET", "/client/settings"), "Flood's client settings");
    } catch (err) {
      if (!(err instanceof ProtocolError)) {
        throw err;
      }
      this.deps.log.debug(`Flood: no limits — ${errText(err)}`);
      return null;
    }
  }

  /**
   * Adds a link — started, or stopped while the adapter holds the program paused (Flood's `start` defaults to false). A
   * held add is kept by the hash Flood answers (upper case, like the list); rTorrent's gateway and qBittorrent's for a
   * magnet answer none (recordings `add-files`, `add-urls-magnet`: 202 []) — the next poll that lists a new stopped
   * torrent hands it to the pause.
   *
   * @param url the link
   */
  private async add(url: string): Promise<void> {
    const held = await this.pause.isPaused();
    const answer = await this.client.send("POST", "/torrents/add-urls", { urls: [url], start: !held });
    if (!held) {
      return;
    }
    const hashes = Array.isArray(answer) ? answer.filter((h): h is string => typeof h === "string" && h !== "") : [];
    if (!hashes.length) {
      await this.pause.holdNext();
      return;
    }
    for (const h of hashes) {
      await this.pause.hold(h.toUpperCase());
    }
  }

  /**
   * Writes the whole settings object with the one limit changed. Flood takes a part of it (`Partial<ClientSettings>`),
   * but its Deluge gateway sends every key, an unsent one as None, which Deluge stores (recording 4.16.4-deluge
   * `partial`: every settings read 500 afterwards), and its Transmission gateway switches the seed queue on when
   * `throttleMaxUploadsGlobal` is missing (`partial`: 0 → 10). rTorrent refuses its own empty local address in the same
   * call (500 "Tried to set local address to an any address.") and takes the limits anyway (recording 4.16.4-rtorrent
   * `limited`) — an error answer counts as done when the settings read back show the limit.
   *
   * @param key the limit
   * @param bps bytes per second, 0 = unlimited
   */
  private async setLimit(key: LimitKey, bps: number): Promise<void> {
    const value = Math.max(0, Math.round(bps));
    const read = async (): Promise<Record<string, unknown>> =>
      recordIn(await this.client.send("GET", "/client/settings"), "Flood's client settings");
    try {
      await this.client.send("PATCH", "/client/settings", { ...(await read()), [key]: value });
    } catch (err) {
      if (!(err instanceof ProtocolError)) {
        throw err;
      }
      // within one KiB: a backend may keep the limit in KiB/s (Transmission's gateway divides by 1024)
      const now = limitBps((await read().catch((): Record<string, unknown> => ({})))[key]);
      if (now === null || Math.abs(now - (limitBps(value) ?? value)) >= 1024) {
        throw err;
      }
      this.deps.log.debug(`Flood: ${key} ${value} B/s took effect despite ${errText(err)}`);
    }
  }
}
