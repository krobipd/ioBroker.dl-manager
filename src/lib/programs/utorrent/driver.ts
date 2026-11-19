import { listIn, recordIn } from "../../core/answer";
import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, DriverDeps, ProgramConfig, ProgramDriver, ProgramSnapshot } from "../../core/model";
import { num, toKiB } from "../../core/units";
import { UtClient } from "./client";
import { isRunning, PAUSED, runs, toSnapshot, torrentOf, type UtTorrent } from "./map";

/**
 * @param keys info hashes
 * @returns the hash list of one action (`hash=A&hash=B`, as µTorrent's Web UI sends several — webui.js `perform`)
 */
const hashes = (keys: readonly string[]): string => keys.map(k => `hash=${encodeURIComponent(k)}`).join("&");

/**
 * µTorrent over its Web UI API. It has no pause for everything — the adapter makes it from µTorrent's own pause over a
 * hash list, the torrents the Web UI's "pause all" pauses (webui.js `perform("pauseall")`); unpause gives each back as
 * it was, a forced one forced (run 43684983680 — a stop and start made the forced magnet a queued one, run 43684732968).
 */
export class UtDriver implements ProgramDriver {
  public readonly type = "utorrent";
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
  private readonly client: UtClient;
  private readonly pause: EmulatedPause;
  private readonly debug: (msg: string) => void;
  /** µTorrent's version, read with the first query and again after a failed one; null = read it. */
  private version: string | null = null;
  /** This build does not know `getversion` — the build number of every answer is its version. */
  private noGetVersion = false;
  /** The status bits of the last poll, by hash. */
  private statuses = new Map<string, number>();
  /** Every hash of the last poll, to tell a new torrent; null before the first. */
  private listed: ReadonlySet<string> | null = null;
  /** Torrents added while the pause held, which µTorrent starts — the next new ones are paused and held. */
  private adding = 0;

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(cfg: ProgramConfig, deps: DriverDeps) {
    this.client = new UtClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
    this.debug = (m: string): void => deps.log.debug(m);
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    try {
      this.version ??= await this.readVersion();
      const list = await this.client.call("list=1");
      const settings = await this.client.call("action=getsettings");
      const torrents = listIn(list.torrents, "µTorrent's torrent list").map(torrentOf);
      await this.holdAdded(torrents);
      this.statuses = new Map(torrents.map(t => [t.hash, t.status]));
      const running = new Set(torrents.filter(isRunning).map(t => t.hash));
      const paused = await this.pause.observe(running, new Set(this.statuses.keys()));
      const build = num(list.build);
      const version = this.version || (build === null ? "" : String(build));
      return toSnapshot(version, torrents, settings.settings, paused, this.debug);
    } catch (err: unknown) {
      this.version = null;
      throw err;
    }
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pause":
        await this.client.call(`action=pause&${hashes([cmd.key])}`);
        return;
      case "resume":
        // a paused one wakes with unpause, a stopped one with start (webui.js `getHashes`: unpause only takes bit 32)
        await this.client.call(
          `action=${(this.statuses.get(cmd.key) ?? 0) & PAUSED ? "unpause" : "start"}&${hashes([cmd.key])}`,
        );
        return;
      case "remove":
        // remove takes the torrent out of the list and leaves its files; removedata would delete them
        await this.client.call(`action=remove&${hashes([cmd.key])}`);
        return;
      case "add":
        // add-url names no hash and the torrent starts at once: while the adapter holds the program paused, the next
        // new torrent is paused and held (`holdAdded`)
        await this.client.call(`action=add-url&s=${encodeURIComponent(cmd.url)}`);
        if (await this.pause.isPaused()) {
          this.adding++;
        }
        return;
      case "pauseAll":
        await this.pause.pause(
          [...this.statuses].filter(([, st]) => runs(st)).map(([k]) => k),
          async keys => {
            await this.client.call(`action=pause&${hashes(keys)}`);
            return keys;
          },
        );
        return;
      case "resumeAll":
        await this.pause.resume(async keys => {
          await this.client.call(`action=unpause&${hashes(keys)}`);
        });
        return;
      case "setSpeedLimit":
        await this.client.call(`action=setsetting&s=max_dl_rate&v=${cmd.bps > 0 ? toKiB(cmd.bps) : 0}`);
        return;
      case "setUploadLimit":
        await this.client.call(`action=setsetting&s=max_ul_rate&v=${cmd.bps > 0 ? toKiB(cmd.bps) : 0}`);
        return;
      default:
        throw new ProtocolError("µTorrent: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /**
   * @returns `<major>.<minor>.<tiny>.<build>` from `getversion` (recording `probe/getversion`: 3.3.0.30470), "" for a
   *   build without it — then the build number of the answers stands for the version; an answer that lost a part is
   *   refused, so the version of the last poll stays
   */
  private async readVersion(): Promise<string> {
    if (this.noGetVersion) {
      return "";
    }
    const answer = await this.client.tryCall("action=getversion");
    if (!answer) {
      this.noGetVersion = true;
      return "";
    }
    const v = recordIn(answer.version, "µTorrent's version");
    const parts = [v.major_version, v.minor_version, v.tiny_version, answer.build];
    if (!parts.every(p => typeof p === "number" && Number.isInteger(p) && p >= 0)) {
      throw new ProtocolError("µTorrent's version is incomplete — answer refused");
    }
    return parts.join(".");
  }

  /**
   * The torrents added while the pause holds: µTorrent starts them, so the first new running ones of this poll are
   * paused and held — or, when the pause ended meanwhile, left running.
   *
   * @param torrents this poll's torrents (their status is set to paused here)
   */
  private async holdAdded(torrents: UtTorrent[]): Promise<void> {
    const before = this.listed;
    this.listed = new Set(torrents.map(t => t.hash));
    if (!(await this.pause.isPaused())) {
      this.adding = 0;
      return;
    }
    if (!before) {
      return;
    }
    const fresh = torrents.filter(t => !before.has(t.hash) && isRunning(t)).slice(0, this.adding);
    if (!fresh.length) {
      return;
    }
    await this.client.call(`action=pause&${hashes(fresh.map(t => t.hash))}`);
    this.adding -= fresh.length;
    for (const t of fresh) {
      await this.pause.hold(t.hash);
      t.status |= PAUSED;
    }
  }
}
