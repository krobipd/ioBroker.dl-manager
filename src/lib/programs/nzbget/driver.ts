import { ProtocolError } from "../../core/errors";
import type { Capability, Command, ExtraDefinition, ProgramDriver, ProgramSnapshot } from "../../core/model";
import type { DriverDeps, ProgramConfig } from "../registry";
import { NzbClient } from "./client";
import { toSnapshot } from "./map";

/** Download a failed job again (`HistoryRedownload`). */
const EXTRAS: readonly ExtraDefinition[] = [
  {
    id: "retry",
    level: "item",
    type: "boolean",
    role: "button",
    write: true,
    read: false,
    nameKey: "retry",
    descKey: "descRetry",
  },
];

/** NZBGet (nzbgetcom 24 – 26). Real global pause; no speed, ETA or added time per job. */
export class NzbDriver implements ProgramDriver {
  public readonly type = "nzbget";
  public readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "globalPause",
    "itemPause",
    "itemRemove",
    "add",
    "speedLimit",
    "freeSpace",
    "itemFinished",
    "category",
    "itemError",
  ]);
  public readonly extras = EXTRAS;
  private readonly client: NzbClient;
  private version = "";
  private inQueue = new Set<string>();

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.client = new NzbClient(cfg, deps);
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    if (!this.version) {
      const v = await this.client.call("version");
      this.version = typeof v === "string" ? v : "";
    }
    const status = await this.client.call("status");
    const groups = await this.client.call("listgroups", [0]);
    const history = await this.client.call("history", [false]);
    this.inQueue = new Set(
      (Array.isArray(groups) ? groups : []).map(g => String((g as { NZBID?: unknown } | null)?.NZBID)),
    );
    return toSnapshot(this.version, status, groups, history, m => this.deps.log.debug(m));
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    const id = (key: string): number[] => [Number(key)];
    switch (cmd.kind) {
      case "pause":
      case "resume":
        if (!this.inQueue.has(cmd.key)) {
          throw new ProtocolError("nzbget: only a job in the queue can be paused or resumed");
        }
        await this.client.call("editqueue", [cmd.kind === "pause" ? "GroupPause" : "GroupResume", "", id(cmd.key)]);
        return;
      case "remove":
        // queue: park-delete keeps the files already loaded; history: only the entry goes
        await this.client.call("editqueue", [
          this.inQueue.has(cmd.key) ? "GroupParkDelete" : "HistoryDelete",
          "",
          id(cmd.key),
        ]);
        return;
      case "add":
        await this.client.call("append", ["", cmd.url, "", 0, false, false, "", 0, "SCORE", false, []]);
        return;
      case "pauseAll":
        await this.client.call("pausedownload");
        return;
      case "resumeAll":
        await this.client.call("resumedownload");
        return;
      case "setSpeedLimit":
        // rate() takes KB/s (1024), status() reports B/s
        await this.client.call("rate", [cmd.bps > 0 ? Math.max(1, Math.round(cmd.bps / 1024)) : 0]);
        return;
      case "extra":
        if (cmd.name === "retry" && cmd.key) {
          await this.client.call("editqueue", ["HistoryRedownload", "", id(cmd.key)]);
          return;
        }
        throw new ProtocolError(`nzbget: unknown extra ${cmd.name}`);
      default:
        throw new ProtocolError("nzbget: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }
}
