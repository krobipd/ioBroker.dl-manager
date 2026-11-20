import { idIn, recordIn } from "../../core/answer";
import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, DriverDeps, ProgramConfig, ProgramDriver, ProgramSnapshot } from "../../core/model";
import { asRecord } from "../../core/units";
import { errText } from "../../err-text";
import { FbxClient } from "./client";
import { isRunning, limitsOf, tasksOf, toSnapshot, versionOf, type FbxTask } from "./map";

/**
 * The Freebox's downloader over the Freebox OS API. The Freebox has no pause for everything — its throttling mode
 * `hibernate` is the user's own schedule setting, and what it does to the tasks no source shows — so the adapter makes
 * it from the pause per task (`PUT downloads/{id}` with `stopped`, `downloading` resumes), as for the other programs
 * without one. A link goes in as a form with `download_url` (the Freebox takes no JSON there, documentation download:
 * "add by URL"), and its answer names the new task's id: while the pause holds, that task is stopped and held at once.
 * Remove is `DELETE downloads/{id}`, which keeps the files; `…/erase` the adapter never sends. The limits are those of
 * the normal mode (`throttling.normal`); only the throttling section goes back, as read with the one rate changed —
 * the config the Freebox hands out lacks the news password, so the whole config written back could lose it.
 */
export class FbxDriver implements ProgramDriver {
  public readonly type = "freebox";
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
    "itemError",
  ]);
  public readonly extras = [];
  private readonly client: FbxClient;
  private readonly pause: EmulatedPause;
  private readonly debug: (msg: string) => void;
  /** The Freebox's API version, read with the first poll and again after a failed one; null = read it. */
  private version: string | null = null;
  /** Every id of the last list. */
  private listed = new Set<string>();
  /** Links added while the pause holds whose stop has not reached the Freebox yet — the next poll stops them. */
  private adding: string[] = [];

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(cfg: ProgramConfig, deps: DriverDeps) {
    this.client = new FbxClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
    this.debug = (m: string): void => deps.log.debug(m);
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    try {
      this.version ??= versionOf(await this.client.apiVersion());
      const tasks = await this.list();
      const limits = limitsOf(
        recordIn(await this.client.call("GET", "downloads/config/"), "the Freebox's download config"),
      );
      await this.holdAdded(tasks);
      const paused = await this.pause.observe(new Set(tasks.filter(isRunning).map(t => t.id)), this.listed);
      return toSnapshot(this.version, tasks, limits, paused, this.debug);
    } catch (err: unknown) {
      this.version = null;
      this.client.reset();
      throw err;
    }
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pause":
        await this.setStatus(idOf(cmd.key), "stopped");
        return;
      case "resume":
        await this.setStatus(idOf(cmd.key), "downloading");
        return;
      case "remove":
        // the task leaves the list; its files stay, or go with `/erase` (documentation download: delete, erase)
        await this.client.call("DELETE", `downloads/${idOf(cmd.key)}${cmd.deleteFiles ? "/erase" : ""}`);
        return;
      case "add": {
        const added = await this.client.call("POST", "downloads/add", { form: { download_url: cmd.url } });
        const id = idIn(
          recordIn(added, "the Freebox's answer to the link"),
          "id",
          "the Freebox's answer to the link",
          "number",
        );
        if (await this.pause.isPaused()) {
          this.adding.push(id);
          await this.holdAdded();
        }
        return;
      }
      case "pauseAll":
        await this.pause.pauseEach(
          (await this.list()).filter(isRunning).map(t => t.id),
          k => this.setStatus(k, "stopped"),
          (k, err) => this.debug(`freebox: ${k} not stopped — ${errText(err)}`),
        );
        return;
      case "resumeAll":
        // a held task that is gone meanwhile is skipped without a call
        await this.list();
        await this.pause.resumeEach(
          k => (this.listed.has(k) ? this.setStatus(k, "downloading") : Promise.resolve()),
          (k, err) => this.debug(`freebox: ${k} not resumed — ${errText(err)}`),
        );
        return;
      case "setSpeedLimit":
        await this.setLimit("rx_rate", cmd.bps);
        return;
      case "setUploadLimit":
        await this.setLimit("tx_rate", cmd.bps);
        return;
      default:
        throw new ProtocolError("Freebox: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /** @returns every task of the download list */
  private async list(): Promise<FbxTask[]> {
    const tasks = tasksOf(await this.client.call("GET", "downloads/"));
    this.listed = new Set(tasks.map(t => t.id));
    return tasks;
  }

  /**
   * @param id the task
   * @param status `stopped` or `downloading` (documentation download: "update a download task")
   */
  private async setStatus(id: string, status: "stopped" | "downloading"): Promise<void> {
    await this.client.call("PUT", `downloads/${id}`, { json: { status } });
  }

  /**
   * The links added while the pause holds: the Freebox starts them, so each is stopped and held — one it refuses
   * (finished or gone meanwhile) runs on, one whose stop did not reach it stays for the next poll; when the pause ended
   * meanwhile, they run.
   *
   * @param tasks this poll's list — a task stopped here counts as stopped in it
   */
  private async holdAdded(tasks: readonly FbxTask[] = []): Promise<void> {
    if (!(await this.pause.isPaused())) {
      this.adding = [];
      return;
    }
    while (this.adding.length) {
      const id = this.adding[0];
      try {
        await this.setStatus(id, "stopped");
        await this.pause.hold(id);
        const t = tasks.find(x => x.id === id);
        if (t) {
          t.status = "stopped";
        }
      } catch (err: unknown) {
        if (!(err instanceof ProtocolError)) {
          throw err;
        }
        this.debug(`freebox: ${id} not stopped — ${errText(err)}`);
      }
      this.adding.shift();
    }
  }

  /**
   * @param field `rx_rate` (download) or `tx_rate` (upload) of the normal mode
   * @param bps the limit in bytes per second, 0 = none — the Freebox's own unit
   */
  private async setLimit(field: "rx_rate" | "tx_rate", bps: number): Promise<void> {
    const config = recordIn(await this.client.call("GET", "downloads/config/"), "the Freebox's download config");
    const throttling = recordIn(config.throttling, "the Freebox's throttling");
    const normal = { ...asRecord(throttling.normal), [field]: Math.max(0, Math.round(bps)) };
    await this.client.call("PUT", "downloads/config/", { json: { throttling: { ...throttling, normal } } });
  }
}

/**
 * @param key a download's key from the adapter's tree
 * @returns it, when it is a task id — the key goes into the call's path
 */
function idOf(key: string): string {
  if (!/^\d+$/.test(key)) {
    throw new ProtocolError(`Freebox: no task ${key}`);
  }
  return key;
}
