import { listIn } from "../../core/answer";
import { errText } from "../../err-text";
import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError, RefusedError } from "../../core/errors";
import type { Capability, Command, DriverDeps, ProgramConfig, ProgramDriver, ProgramSnapshot } from "../../core/model";
import { asText } from "../../core/units";
import { ProgramVersion } from "../../core/version";
import { RtClient, type RpcCall } from "./client";
import { FIELDS, HELD_MARK, toSnapshot, torrentOf, type RtTorrent } from "./map";

/** One poll: the global rates and limits and the torrent list, in one `system.multicall`. */
const POLL: readonly RpcCall[] = [
  { method: "throttle.global_down.rate", params: [""] },
  { method: "throttle.global_up.rate", params: [""] },
  { method: "throttle.global_down.max_rate", params: [""] },
  { method: "throttle.global_up.max_rate", params: [""] },
  { method: "d.multicall2", params: ["", "main", ...FIELDS] },
];

/**
 * rTorrent over XML-RPC. It has no pause for everything — the adapter makes it (plan § 5.3), like Transmission's.
 * Pause and resume are ruTorrent's (js/rtorrent.js: pause `d.stop`, unpause `d.start`); `d.start` also opens a closed
 * torrent (recording `reopened`), but does not wake one that `d.pause` halted — that takes `d.resume` (recordings
 * `unpaused`, `resumed`).
 */
export class RtDriver implements ProgramDriver {
  public readonly type = "rtorrent";
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
  private readonly client: RtClient;
  private readonly pause: EmulatedPause;
  private readonly version = new ProgramVersion();
  private running: string[] = [];
  /** Started, open and inactive at the last poll — halted by `d.pause`, which only `d.resume` ends. */
  private halted = new Set<string>();

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.client = new RtClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
  }

  /** @returns one complete query */
  public poll(): Promise<ProgramSnapshot> {
    return this.version.poll(
      async () => asText(await this.client.call("system.client_version", "")),
      version => this.query(version),
    );
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pause":
        await this.client.call("d.stop", cmd.key);
        return;
      case "resume":
        await this.client.call(this.halted.has(cmd.key) ? "d.resume" : "d.start", cmd.key);
        return;
      case "remove":
        // d.erase takes the torrent out of the session and leaves its files — ruTorrent deletes data only when it set
        // its own mark first (plugin erasedata, d.custom5) and its own server-side code removes them; over XML-RPC
        // only `execute.*` could, which rTorrent 0.16 refuses an untrusted caller: a removal that is to delete them
        // is refused
        if (cmd.deleteFiles) {
          throw new RefusedError("rTorrent deletes no files");
        }
        await this.client.call("d.erase", cmd.key);
        return;
      case "add":
        // the add answers before the torrent is there (a magnet, a link rTorrent loads itself) and names no hash: while
        // the adapter holds the program paused, it is added stopped and marked — the next poll takes it into the pause,
        // or starts it when the pause has ended meanwhile
        if (await this.pause.isPaused()) {
          await this.client.call("load.normal", "", cmd.url, `d.custom.set=${HELD_MARK},1`);
        } else {
          await this.client.call("load.start", "", cmd.url);
        }
        return;
      case "pauseAll":
        // one torrent per call: one rTorrent no longer knows (fault, ended or gone meanwhile) is skipped
        await this.pause.pauseEach(
          this.running,
          k => this.client.call("d.stop", k),
          (k, err) => this.deps.log.debug(`rtorrent: ${k} not paused — ${errText(err)}`),
        );
        return;
      case "resumeAll":
        await this.pause.resumeEach(
          k => this.client.call("d.start", k),
          (k, err) => this.deps.log.debug(`rtorrent: ${k} not resumed — ${errText(err)}`),
        );
        return;
      case "setSpeedLimit":
        await this.client.call("throttle.global_down.max_rate.set", "", Math.max(0, cmd.bps));
        return;
      case "setUploadLimit":
        await this.client.call("throttle.global_up.max_rate.set", "", Math.max(0, cmd.bps));
        return;
      default:
        throw new ProtocolError("rTorrent: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /**
   * @param version the program version
   * @returns the snapshot of one multicall
   */
  private async query(version: string): Promise<ProgramSnapshot> {
    const [down, up, downMax, upMax, rows] = await this.client.multicall(POLL);
    const torrents = listIn(rows, "rTorrent's torrent list").map(torrentOf);
    await this.release(torrents.filter(t => t.held === "1"));
    // what the global pause stops: the started torrents that run or are hashed — a started torrent is inactive during
    // its hash check and starts by itself after it (recording `checking`); d.stop ends the check (`check-stopped`)
    this.running = torrents.filter(t => t.open && t.state && (t.active || t.hashing)).map(t => t.hash);
    this.halted = new Set(torrents.filter(t => t.open && t.state && !t.active && !t.hashing).map(t => t.hash));
    const paused = await this.pause.observe(new Set(this.running), new Set(torrents.map(t => t.hash)));
    return toSnapshot(version, torrents, { down, up, downMax, upMax }, paused, m => this.deps.log.debug(m));
  }

  /**
   * The torrents the adapter added stopped: held by the pause while it lasts, else started — the mark goes either way.
   * A torrent gone meanwhile keeps the poll good; a mark left behind is taken by the next one.
   *
   * @param marked the marked torrents of this poll
   */
  private async release(marked: readonly RtTorrent[]): Promise<void> {
    if (!marked.length) {
      return;
    }
    const paused = await this.pause.isPaused();
    const calls: RpcCall[] = [];
    for (const t of marked) {
      if (paused) {
        await this.pause.hold(t.hash);
      } else {
        calls.push({ method: "d.start", params: [t.hash] });
      }
      calls.push({ method: "d.custom.set", params: [t.hash, HELD_MARK, ""] });
    }
    try {
      await this.client.multicall(calls);
    } catch (err) {
      this.deps.log.debug(`rTorrent: releasing added torrents failed: ${errText(err)}`);
    }
  }
}
