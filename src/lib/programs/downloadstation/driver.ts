import { recordIn, recordsIn } from "../../core/answer";
import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, DriverDeps, ProgramConfig, ProgramDriver, ProgramSnapshot } from "../../core/model";
import { toKiB } from "../../core/units";
import { DsClient, perId } from "./client";
import { infoOf, isRunning, taskOf, toSnapshot, uploadLimitFields, type DsTask } from "./map";

/** How many polls after a pause a task that runs again is paused once more instead of counting as started. */
const WATCH_POLLS = 2;

/**
 * Synology Download Station over the v1 Web API (`SYNO.DownloadStation.Task`, `.Info`) — every call of it has a live
 * answer behind it (cmeans/mcp-synology, DSM 7.2.2). Download Station has no pause for everything: the adapter makes it
 * from the pause per task. A pause on a task that is still starting can come undone — DSM answers ok and the task loads
 * again, mostly within a second; a second pause held in all 69 cases measured (cmeans spec, #243, DSM 7.1–7.4.1). So a
 * task the adapter paused that runs again within the next two polls is paused once more and does not end the pause for
 * everything. Download Station adds a link running and names no task (`create` answers success alone): while the pause
 * holds, the next poll pauses the new running tasks. Remove takes a task out of the list with `force_complete=false` —
 * Download Station never deletes a finished task's files; an unfinished one's partial data it discards itself
 * (cmeans spec, DSM 7.1 and 7.2.2).
 */
export class DsDriver implements ProgramDriver {
  public readonly type = "downloadstation";
  public readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "globalPause",
    "itemPause",
    "itemRemove",
    "add",
    // no "speedLimit": Download Station keeps a download limit per protocol, none for the whole program (map.ts)
    "upload",
    "uploadLimit",
    "itemSpeed",
    "itemEta",
    "itemAdded",
    "itemFinished",
    "itemError",
  ]);
  public readonly extras = [];
  private readonly client: DsClient;
  private readonly pause: EmulatedPause;
  private readonly debug: (msg: string) => void;
  /** Version and manager right, read with the first query and again after a failed one; null = read them. */
  private info: { version: string; manager: boolean } | null = null;
  /** The last `getconfig` — which upload limit fields there are. */
  private config: Record<string, unknown> = {};
  /** The tasks of the last list, by id. */
  private tasks = new Map<string, DsTask>();
  /** Every id of the last list, to tell a task added meanwhile. */
  private listed: ReadonlySet<string> | null = null;
  /** Links added while the pause holds whose task the next poll pauses. */
  private adding = 0;
  /** Tasks the adapter paused, with the polls left in which one that runs again is paused once more. */
  private readonly watched = new Map<string, number>();

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(cfg: ProgramConfig, deps: DriverDeps) {
    this.client = new DsClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
    this.debug = (m: string): void => deps.log.debug(m);
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    try {
      this.info ??= infoOf(await this.client.call("SYNO.DownloadStation.Info", "getinfo"));
      const tasks = await this.list();
      this.config = recordIn(
        await this.client.call("SYNO.DownloadStation.Info", "getconfig"),
        "Download Station's settings",
      );
      const before = this.listed;
      this.listed = new Set(this.tasks.keys());
      await this.holdAdded(tasks, before);
      const again = await this.pauseAgain(tasks);
      const running = new Set(tasks.filter(t => isRunning(t) && !again.has(t.id)).map(t => t.id));
      const paused = await this.pause.observe(running, this.listed);
      return toSnapshot(this.info.version, tasks, this.config, this.info.manager, paused, this.debug);
    } catch (err: unknown) {
      this.info = null;
      this.client.reset();
      throw err;
    }
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pause":
        await this.each("pause", [cmd.key]);
        this.watched.set(cmd.key, WATCH_POLLS);
        return;
      case "resume":
        this.watched.delete(cmd.key);
        await this.each("resume", [cmd.key]);
        return;
      case "remove":
        await this.each("delete", [cmd.key], { force_complete: "false" });
        return;
      case "add":
        // one link per call: v1 reads `uri` as a comma-separated list (cmeans tasks.py, #397)
        await this.client.call("SYNO.DownloadStation.Task", "create", { uri: cmd.url.replace(/,/g, "\\,") });
        if (await this.pause.isPaused()) {
          this.adding++;
        }
        return;
      case "pauseAll":
        await this.pause.pause(
          (await this.list()).filter(isRunning).map(t => t.id),
          keys => this.halt(keys),
        );
        return;
      case "resumeAll":
        await this.pause.resume(async keys => {
          await this.list();
          const listed = keys.filter(k => this.tasks.has(k));
          for (const k of keys) {
            this.watched.delete(k);
          }
          if (listed.length) {
            await this.client.call("SYNO.DownloadStation.Task", "resume", { id: listed.join(",") });
          }
        });
        return;
      case "setUploadLimit":
        await this.setUploadLimit(cmd.bps);
        return;
      default:
        throw new ProtocolError("Download Station: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /** @returns every task (offset 0, limit -1 — the list's `total` is the page, not the queue, cmeans spec) */
  private async list(): Promise<DsTask[]> {
    const data = recordIn(
      await this.client.call("SYNO.DownloadStation.Task", "list", {
        additional: "detail,transfer",
        offset: "0",
        limit: "-1",
      }),
      "Download Station's task list",
    );
    const tasks = recordsIn(data.tasks, "Download Station's task list").map(taskOf);
    this.tasks = new Map(tasks.map(t => [t.id, t]));
    return tasks;
  }

  /**
   * @param method `pause`, `resume` or `delete`
   * @param keys task ids
   * @param extra further fields
   */
  private async each(method: string, keys: readonly string[], extra: Record<string, string> = {}): Promise<void> {
    const codes = perId(
      await this.client.call("SYNO.DownloadStation.Task", method, { id: keys.join(","), ...extra }),
      `${method}`,
    );
    const refused = keys.filter(k => (codes.get(k) ?? 0) !== 0);
    if (refused.length) {
      throw new ProtocolError(
        `Download Station refused ${method} for ${refused.map(k => `${k} (error ${codes.get(k)})`).join(", ")}`,
      );
    }
  }

  /**
   * @param keys tasks that run
   * @returns the ones Download Station paused (a task may have finished meanwhile: 405 for it alone)
   */
  private async halt(keys: string[]): Promise<string[]> {
    const codes = perId(await this.client.call("SYNO.DownloadStation.Task", "pause", { id: keys.join(",") }), "pause");
    const done = keys.filter(k => codes.get(k) === 0);
    for (const k of done) {
      this.watched.set(k, WATCH_POLLS);
    }
    return done;
  }

  /**
   * The tasks added while the pause holds: Download Station starts them, so the first new running ones of this poll are
   * paused and held — or, when the pause ended meanwhile, left running.
   *
   * @param tasks this poll's tasks
   * @param before every id of the poll before
   */
  private async holdAdded(tasks: readonly DsTask[], before: ReadonlySet<string> | null): Promise<void> {
    if (!this.adding) {
      return;
    }
    if (!(await this.pause.isPaused())) {
      this.adding = 0;
      return;
    }
    if (!before) {
      return;
    }
    const fresh = tasks
      .filter(t => !before.has(t.id) && isRunning(t))
      .slice(0, this.adding)
      .map(t => t.id);
    if (!fresh.length) {
      return;
    }
    const held = await this.halt(fresh);
    this.adding -= fresh.length;
    for (const k of held) {
      await this.pause.hold(k);
      const t = this.tasks.get(k);
      if (t) {
        t.status = "paused";
      }
    }
  }

  /**
   * The paused tasks this poll still watches: a gone one is forgotten, one that runs again is paused once more.
   *
   * @param tasks this poll's tasks
   * @returns the ids paused again — they do not count as started by the user
   */
  private async pauseAgain(tasks: readonly DsTask[]): Promise<Set<string>> {
    const again: string[] = [];
    for (const [k, left] of [...this.watched]) {
      const t = this.tasks.get(k);
      if (t && isRunning(t)) {
        again.push(k);
        this.watched.delete(k);
      } else if (!t || left <= 1) {
        this.watched.delete(k);
      } else {
        this.watched.set(k, left - 1);
      }
    }
    if (!again.length) {
      return new Set();
    }
    const codes = perId(await this.client.call("SYNO.DownloadStation.Task", "pause", { id: again.join(",") }), "pause");
    const held = new Set(again.filter(k => codes.get(k) === 0));
    for (const t of tasks) {
      if (held.has(t.id)) {
        t.status = "paused";
      }
    }
    return held;
  }

  /**
   * @param bps bytes per second, 0 = unlimited — written into every upload limit field
   */
  private async setUploadLimit(bps: number): Promise<void> {
    this.info ??= infoOf(await this.client.call("SYNO.DownloadStation.Info", "getinfo"));
    if (!this.info.manager) {
      // a non-manager's setserverconfig answers success and changes nothing (live, cmeans #123)
      throw new ProtocolError("Download Station: only a Download Station manager can set the upload limit");
    }
    const value = String(bps > 0 ? toKiB(bps) : 0);
    await this.client.call(
      "SYNO.DownloadStation.Info",
      "setserverconfig",
      Object.fromEntries(uploadLimitFields(this.config).map(f => [f, value])),
    );
  }
}
