import { ProtocolError, RefusedError } from "../../core/errors";
import { ProgramVersion } from "../../core/version";
import type {
  Capability,
  Command,
  ExtraDefinition,
  ProgramDriver,
  ProgramSnapshot,
  DriverDeps,
  ProgramConfig,
} from "../../core/model";
import { RETRY_EXTRA } from "../retry-extra";
import { NzbClient } from "./client";
import { toSnapshot } from "./map";
import { asRecords, asText, toKiB } from "../../core/units";

/** Download a failed job again (`HistoryRedownload`). */
const EXTRAS: readonly ExtraDefinition[] = [RETRY_EXTRA];

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
  private readonly version = new ProgramVersion();
  private inQueue = new Set<string>();
  /** The history entries of the last answer, by NZBID. */
  private history = new Map<string, Record<string, unknown>>();

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
  public poll(): Promise<ProgramSnapshot> {
    return this.version.poll(
      async () => asText(await this.client.call("version")),
      version => this.query(version),
    );
  }

  /**
   * @param version the program's version
   * @returns one complete query
   */
  private async query(version: string): Promise<ProgramSnapshot> {
    const status = await this.client.call("status");
    const groups = await this.client.call("listgroups", [0]);
    const history = await this.client.call("history", [false]);
    // toSnapshot refuses a list out of shape — the queue is taken only from an answer it accepted
    const snapshot = toSnapshot(version, status, groups, history, m => this.deps.log.debug(m));
    this.inQueue = new Set(asRecords(groups).map(g => String(g.NZBID)));
    this.history = new Map(asRecords(history).map(h => [String(h.NZBID), h]));
    return snapshot;
  }

  /**
   * The edit action that removes a download as asked (core decisions D-04 and D-13). In the queue GroupParkDelete keeps
   * what the job loaded and GroupDelete deletes it (QueueEditor.cpp `EditGroup`, `SetCleanupDisk`). From the history
   * HistoryDelete deletes the folder of a job that was deleted or failed its repair or unpack, and keeps every other's
   * (HistoryCoordinator.cpp `HistoryDelete`); a URL entry loaded nothing. What NZBGet cannot remove as asked is refused.
   *
   * @param key the NZBID
   * @param deleteFiles the files go too
   * @returns the edit action, or why NZBGet cannot remove the job as asked
   */
  private removal(key: string, deleteFiles: boolean): { action: string } | { refused: string } {
    if (this.inQueue.has(key)) {
      return { action: deleteFiles ? "GroupDelete" : "GroupParkDelete" };
    }
    const entry = this.history.get(key);
    if (!entry) {
      return { refused: "NZBGet's last answer does not list this download" };
    }
    if (asText(entry.Kind) === "NZB") {
      const deletesFolder =
        asText(entry.DeleteStatus) !== "NONE" ||
        asText(entry.ParStatus) === "FAILURE" ||
        ["FAILURE", "PASSWORD"].includes(asText(entry.UnpackStatus));
      if (deletesFolder && !deleteFiles) {
        return { refused: "NZBGet deletes the files of a deleted or failed download" };
      }
      if (!deletesFolder && deleteFiles) {
        return { refused: "NZBGet does not delete the files of a finished download" };
      }
    }
    return { action: "HistoryDelete" };
  }

  /**
   * @param key the NZBID
   * @param deleteFiles the files go too
   * @returns whether removing it reaches what core decision D-04 asks, as NZBGet's last answer stands
   */
  public removable(key: string, deleteFiles: boolean): boolean {
    return "action" in this.removal(key, deleteFiles);
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
      case "remove": {
        const removal = this.removal(cmd.key, cmd.deleteFiles === true);
        if ("refused" in removal) {
          throw new RefusedError(removal.refused);
        }
        await this.client.call("editqueue", [removal.action, "", id(cmd.key)]);
        return;
      }
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
        await this.client.call("rate", [cmd.bps > 0 ? toKiB(cmd.bps) : 0]);
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
