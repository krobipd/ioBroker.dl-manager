import { listIn, recordIn } from "../../core/answer";
import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, DriverDeps, ProgramConfig, ProgramDriver, ProgramSnapshot } from "../../core/model";
import { HkClient } from "./client";
import { isRunning, PAUSED, STARTED, toSnapshot, torrentOf, type HkTorrent } from "./map";

/**
 * Hadouken over its JSON-RPC API. A pause on a torrent that libtorrent's queue manages does not hold — the queue resumes
 * it within a second (run 43714685079, `pause-managed`: started again, finished 40 s later). A pause therefore takes the
 * torrent out of the queue first (`auto_managed` off, as Hadouken's own seed goal does, js/core.js), and a resume hands
 * it back to the queue unless it ran outside the queue before (forced, webui_perform.js `forcestart`). Hadouken has no
 * pause for everything: the adapter makes it from that pause over the torrents that run or wait in the queue. Every list
 * action stops at the first hash Hadouken does not know and leaves the rest undone (webui_perform.js,
 * webui_setProperties.js), so the pause for everything and its end act on a fresh list.
 */
export class HkDriver implements ProgramDriver {
  public readonly type = "hadouken";
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
  private readonly client: HkClient;
  private readonly pause: EmulatedPause;
  private readonly debug: (msg: string) => void;
  /** Hadouken's version, read with the first query and again after a failed one; null = read it. */
  private version: string | null = null;
  /** The status bits of the last list, by hash. */
  private statuses = new Map<string, number>();
  /**
   * Torrents the adapter paused that ran outside the queue — a resume leaves them so. Kept in memory: after a restart a
   * resume hands every torrent to the queue, the way Hadouken adds them.
   */
  private readonly forced = new Set<string>();

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(cfg: ProgramConfig, deps: DriverDeps) {
    this.client = new HkClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
    this.debug = (m: string): void => deps.log.debug(m);
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    try {
      this.version ??= await this.readVersion();
      const torrents = await this.list();
      const settings = recordIn(await this.client.call("webui.getSettings"), "Hadouken's settings").settings;
      const running = new Set(torrents.filter(isRunning).map(t => t.hash));
      const paused = await this.pause.observe(running, new Set(this.statuses.keys()));
      return toSnapshot(this.version, torrents, settings, paused, this.debug);
    } catch (err: unknown) {
      this.version = null;
      throw err;
    }
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pause":
        await this.halt([cmd.key]);
        return;
      case "resume":
        await this.wake([cmd.key]);
        return;
      case "remove":
        // remove takes the torrent out of the list and leaves its files; removedata would delete them
        await this.client.call("webui.perform", ["remove", [cmd.key]]);
        return;
      case "add": {
        // a URL names no hash: while the adapter holds the program paused, the torrent is added paused
        // (webui_addTorrent.js `paused`) and the next poll holds the new paused one
        const paused = await this.pause.isPaused();
        await this.client.call("webui.addTorrent", ["url", cmd.url, paused ? { paused: true } : {}]);
        if (paused) {
          await this.pause.holdNext();
        }
        return;
      }
      case "pauseAll":
        await this.pause.pause(
          (await this.list()).filter(isRunning).map(t => t.hash),
          async keys => {
            await this.halt(keys);
            return keys;
          },
        );
        return;
      case "resumeAll":
        await this.pause.resume(async keys => {
          await this.list();
          await this.wake(keys.filter(k => this.statuses.has(k)));
        });
        return;
      case "setSpeedLimit":
        await this.client.call("webui.setSettings", [{ max_dl_rate: Math.max(0, Math.round(cmd.bps)) }]);
        return;
      case "setUploadLimit":
        await this.client.call("webui.setSettings", [{ max_ul_rate: Math.max(0, Math.round(cmd.bps)) }]);
        return;
      default:
        throw new ProtocolError("Hadouken: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /**
   * @returns Hadouken's version from `core.getSystemInfo` (recording `probe/get-system-info`: `versions.hadouken`
   *   5.2.0); an answer without it is refused, so the version of the last poll stays
   */
  private async readVersion(): Promise<string> {
    const info = recordIn(await this.client.call("core.getSystemInfo"), "Hadouken's system info");
    const version = recordIn(info.versions, "Hadouken's versions").hadouken;
    if (typeof version !== "string" || version === "") {
      throw new ProtocolError("Hadouken's version is missing — answer refused");
    }
    return version;
  }

  /** @returns the torrents of `webui.list` (their status bits kept for the commands) */
  private async list(): Promise<HkTorrent[]> {
    const body = recordIn(await this.client.call("webui.list"), "Hadouken's torrent list");
    const torrents = listIn(body.torrents, "Hadouken's torrent list").map(torrentOf);
    this.statuses = new Map(torrents.map(t => [t.hash, t.status]));
    return torrents;
  }

  /**
   * Out of the queue, then paused — remembering the started ones that ran outside the queue (a queued one waits in it).
   *
   * @param keys info hashes
   */
  private async halt(keys: readonly string[]): Promise<void> {
    if (!keys.length) {
      return;
    }
    for (const key of keys.filter(k => ((this.statuses.get(k) ?? 0) & STARTED) !== 0)) {
      const props = recordIn(await this.client.call("webui.getProperties", [key]), "Hadouken's properties").props;
      const managed = recordIn(listIn(props, "Hadouken's properties")[0], "Hadouken's properties").auto_managed;
      if (managed === false) {
        this.forced.add(key);
      } else {
        this.forced.delete(key);
      }
    }
    await this.client.call("webui.setProperties", [keys, { auto_managed: false }]);
    await this.client.call("webui.perform", ["pause", keys]);
  }

  /**
   * Started, and the paused ones back into the queue unless they ran outside it before — a torrent that is not paused
   * keeps how it runs.
   *
   * @param keys info hashes
   */
  private async wake(keys: readonly string[]): Promise<void> {
    if (!keys.length) {
      return;
    }
    await this.client.call("webui.perform", ["start", keys]);
    const queue = keys.filter(k => ((this.statuses.get(k) ?? 0) & PAUSED) !== 0 && !this.forced.has(k));
    if (queue.length) {
      await this.client.call("webui.setProperties", [queue, { auto_managed: true }]);
    }
    for (const k of keys) {
      this.forced.delete(k);
    }
  }
}
