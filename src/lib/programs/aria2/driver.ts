import { errText } from "../../err-text";
import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, ProgramDriver, ProgramSnapshot, DriverDeps, ProgramConfig } from "../../core/model";
import { AriaClient, nodeSocket, type SocketFactory } from "./client";
import { toSnapshot } from "./map";
import { asRecords } from "../../core/units";

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
  private version = "";
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
    if (!this.version) {
      const v = (await this.client.call("aria2.getVersion")) as { version?: unknown } | null;
      this.version = typeof v?.version === "string" ? v.version : "";
    }
    const [active, waiting, stopped, stat, option] = await this.client.multicall([
      ["aria2.tellActive", []],
      ["aria2.tellWaiting", [0, 1000]],
      ["aria2.tellStopped", [0, 1000]],
      ["aria2.getGlobalStat", []],
      ["aria2.getGlobalOption", []],
    ]);
    const gids = (l: Record<string, unknown>[]): string[] => l.map(e => String(e.gid));
    this.running = [...gids(asRecords(active)), ...gids(asRecords(waiting).filter(e => e.status !== "paused"))];
    this.stopped = new Set(gids(asRecords(stopped)));
    const all = [...asRecords(active), ...asRecords(waiting), ...asRecords(stopped)];
    const paused = await this.pause.observe(new Set(this.running), new Set(gids(all)));
    return toSnapshot(this.version, all, stat, option, paused, m => this.deps.log.debug(m));
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
      case "add":
        await this.client.call("aria2.addUri", [[cmd.url], (await this.pause.isPaused()) ? { pause: "true" } : {}]);
        return;
      case "pauseAll":
        await this.pause.pause(this.running, async keys => {
          for (const k of keys) {
            await this.client.call("aria2.pause", [k]);
          }
        });
        return;
      case "resumeAll":
        await this.pause.resume(async keys => {
          for (const k of keys) {
            await this.client.call("aria2.unpause", [k]);
          }
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
