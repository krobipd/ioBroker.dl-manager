import { errText } from "../../err-text";
import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, ProgramDriver, ProgramSnapshot, DriverDeps, ProgramConfig } from "../../core/model";
import { AriaClient, nodeSocket, type SocketFactory } from "./client";
import { toSnapshot } from "./map";
import { idIn, recordsIn } from "../../core/answer";
import { asRecord, asText } from "../../core/units";

/** Pause before reconnecting the push channel. */
const RECONNECT_MS = 30_000;

/** aria2 1.37 over JSON-RPC. The global pause is made by the adapter (aria2 has no global flag, plan § 5.3). */
export class AriaDriver implements ProgramDriver {
  public readonly type = "aria2";
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
    "itemError",
  ]);
  public readonly extras = [];
  private readonly client: AriaClient;
  private readonly pause: EmulatedPause;
  private running: string[] = [];
  private stopped = new Set<string>();

  /**
   * @param cfg the settings row
   * @param deps adapter services
   * @param socket opens the push channel (a seam for the tests)
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
    private readonly socket: SocketFactory = nodeSocket,
  ) {
    this.client = new AriaClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
  }

  /** @returns one complete query (one multicall) */
  public async poll(): Promise<ProgramSnapshot> {
    // the version comes with every query — an updated aria2 shows its new one at once, at no extra request
    const [version, active, waiting, stopped, stat, option] = await this.client.multicall([
      ["aria2.getVersion", []],
      ["aria2.tellActive", []],
      ["aria2.tellWaiting", [0, 1000]],
      ["aria2.tellStopped", [0, 1000]],
      ["aria2.getGlobalStat", []],
      ["aria2.getGlobalOption", []],
    ]);
    const listOf = (raw: unknown, method: string): Record<string, unknown>[] => {
      const entries = recordsIn(raw, `aria2's ${method}`);
      entries.forEach(e => idIn(e, "gid", `aria2's ${method}`, "text"));
      return entries;
    };
    const run = listOf(active, "tellActive");
    const queued = listOf(waiting, "tellWaiting");
    const done = listOf(stopped, "tellStopped");
    const gids = (l: Record<string, unknown>[]): string[] => l.map(e => String(e.gid));
    this.running = [...gids(run), ...gids(queued.filter(e => e.status !== "paused"))];
    this.stopped = new Set(gids(done));
    const all = [...run, ...queued, ...done];
    // a finished download cannot be resumed — only active and waiting ones stay in the pause
    const resumable = new Set(gids([...run, ...queued]));
    const paused = await this.pause.observe(new Set(this.running), resumable);
    const reported = asRecord(version).version;
    return toSnapshot(asText(reported), all, stat, option, paused, m => this.deps.log.debug(m));
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pause":
        await this.client.call("aria2.pause", [cmd.key]);
        return;
      case "resume":
        await this.client.call("aria2.unpause", [cmd.key]);
        return;
      case "remove":
        // a finished or failed one only leaves the result list; a running one is removed (files stay)
        await this.client.call(this.stopped.has(cmd.key) ? "aria2.removeDownloadResult" : "aria2.remove", [cmd.key]);
        return;
      case "add": {
        const held = await this.pause.isPaused();
        const gid = await this.client.call("aria2.addUri", [[cmd.url], held ? { pause: "true" } : {}]);
        if (held && typeof gid === "string") {
          await this.pause.hold(gid);
        }
        return;
      }
      case "pauseAll":
        await this.pause.pause(this.running, keys => this.eachGid("aria2.pause", keys));
        return;
      case "resumeAll":
        await this.pause.resume(async keys => {
          await this.eachGid("aria2.unpause", keys);
        });
        return;
      case "setSpeedLimit":
        await this.client.call("aria2.changeGlobalOption", [{ "max-overall-download-limit": String(cmd.bps) }]);
        return;
      case "setUploadLimit":
        await this.client.call("aria2.changeGlobalOption", [{ "max-overall-upload-limit": String(cmd.bps) }]);
        return;
      default:
        throw new ProtocolError("aria2: command not supported");
    }
  }

  /**
   * aria2 pauses one gid per call; one that ended meanwhile is refused and skipped — only all refused is a failure.
   *
   * @param method `aria2.pause` or `aria2.unpause`
   * @param gids the downloads
   * @returns the gids aria2 took
   */
  private async eachGid(method: string, gids: string[]): Promise<string[]> {
    const done: string[] = [];
    let failure: Error | undefined = undefined;
    for (const gid of gids) {
      try {
        await this.client.call(method, [gid]);
        done.push(gid);
      } catch (err: unknown) {
        failure ??= err instanceof Error ? err : new Error(errText(err));
        this.deps.log.debug(`aria2: ${method} ${gid} refused: ${errText(err)}`);
      }
    }
    if (failure !== undefined && !done.length) {
      throw failure;
    }
    return done;
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /**
   * aria2's WebSocket notifications (`aria2.onDownload*`) as a push channel — each only triggers a poll.
   *
   * @param onChange called when aria2 reports a change
   * @returns closes the channel
   */
  public subscribe(onChange: () => void): () => void {
    let stopped = false;
    let socket: ReturnType<SocketFactory> | null = null;
    const open = (): void => {
      if (stopped) {
        return;
      }
      try {
        socket = this.socket(this.client.wsUrl);
      } catch (err: unknown) {
        this.deps.log.debug(`aria2: push channel not opened: ${errText(err)}`);
        this.deps.setTimeout(open, RECONNECT_MS);
        return;
      }
      socket.addEventListener("message", ev => {
        try {
          const m = JSON.parse(String(ev.data)) as { method?: unknown };
          if (typeof m.method === "string" && m.method.startsWith("aria2.onDownload")) {
            onChange();
          }
        } catch {
          // not a notification
        }
      });
      socket.addEventListener("close", () => {
        socket = null;
        if (!stopped) {
          this.deps.setTimeout(open, RECONNECT_MS);
        }
      });
    };
    open();
    return () => {
      stopped = true;
      socket?.close();
    };
  }
}
