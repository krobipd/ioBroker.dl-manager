import { recordsIn } from "../../core/answer";
import { errText } from "../../err-text";
import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, DriverDeps, ProgramConfig, ProgramDriver, ProgramSnapshot } from "../../core/model";
import { toKiB } from "../../core/units";
import { NvClient } from "./client";
import { entryOf, isRunning, limitOf, toSnapshot, versionOf, type NvEntry } from "./map";

/**
 * NZBVortex over its Network API (documentation rev. 1.7, API level 2.3). NZBVortex has calls to pause and resume
 * everything (`nzb/pause`, `nzb/resume`), but no answer says whether everything is paused, and the resume would start the
 * NZBs the user paused himself too: the adapter makes the pause for everything from the pause per NZB, as for the other
 * programs without one. A link goes in with `nzb/add?url=`; NZBVortex queues it a little later and names it by the
 * `add_uuid` of its answer, which the entry carries as `addUUID` from then on (API level 2.3, Sonarr NzbVortex.cs) —
 * while the pause holds, the poll that finds it pauses it. Remove is `cancel`, which keeps the files (documentation
 * p. 20); `cancelDelete` the adapter never sends.
 */
export class NvDriver implements ProgramDriver {
  public readonly type = "nzbvortex";
  public readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "globalPause",
    "itemPause",
    "itemRemove",
    "add",
    "speedLimit",
    "itemSpeed",
    "itemEta",
    "category",
    "itemError",
  ]);
  public readonly extras = [];
  private readonly client: NvClient;
  private readonly pause: EmulatedPause;
  private readonly debug: (msg: string) => void;
  /** NZBVortex's version, read with the first poll and again after a failed one; null = read it. */
  private version: string | null = null;
  /** The entries of the last queue, by id. */
  private entries = new Map<string, NvEntry>();
  /** Every id of the last queue, to tell an entry added meanwhile. */
  private listed: ReadonlySet<string> | null = null;
  /**
   * Links added while the pause holds, by the `add_uuid` NZBVortex named for each — null for an NZBVortex before API
   * level 2.3, which names none: the next new running entries are theirs.
   */
  private adding: (string | null)[] = [];

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(cfg: ProgramConfig, deps: DriverDeps) {
    this.client = new NvClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
    this.debug = (m: string): void => deps.log.debug(m);
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    try {
      this.version ??= versionOf(await this.client.get("app/appversion"));
      const entries = await this.list();
      const limit = limitOf(await this.client.get("speedlimit"));
      const before = this.listed;
      this.listed = new Set(this.entries.keys());
      await this.holdAdded(entries, before);
      const paused = await this.pause.observe(new Set(entries.filter(isRunning).map(e => e.id)), this.listed);
      return toSnapshot(this.version, entries, limit, paused, this.debug);
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
      case "resume":
        await this.client.get(`nzb/${idOf(cmd.key)}/${cmd.kind}`);
        return;
      case "remove":
        // `cancel` takes the NZB out of the queue and leaves its files (documentation p. 20)
        await this.client.get(`nzb/${idOf(cmd.key)}/cancel`);
        return;
      case "add": {
        // a GET with the link in the query, as NZBVortex's web interface and its PHP example send it
        const answer = await this.client.get("nzb/add", { url: cmd.url });
        if (await this.pause.isPaused()) {
          const uuid = answer.add_uuid;
          this.adding.push(typeof uuid === "string" && uuid !== "" ? uuid : null);
        }
        return;
      }
      case "pauseAll":
        await this.pause.pause(
          (await this.list()).filter(isRunning).map(e => e.id),
          keys => this.halt(keys),
        );
        return;
      case "resumeAll":
        await this.pause.resume(async keys => {
          await this.list();
          for (const k of keys.filter(key => this.entries.has(key))) {
            await this.client.get(`nzb/${k}/resume`);
          }
        });
        return;
      case "setSpeedLimit":
        await (cmd.bps > 0
          ? this.client.get("speedlimit/enable", { speed: String(toKiB(cmd.bps)) })
          : this.client.get("speedlimit/disable"));
        return;
      default:
        throw new ProtocolError("NZBVortex: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /** @returns every entry of the queue */
  private async list(): Promise<NvEntry[]> {
    const answer = await this.client.get("nzb");
    const entries = recordsIn(answer.nzbs, "NZBVortex's queue").map(entryOf);
    this.entries = new Map(entries.map(e => [e.id, e]));
    return entries;
  }

  /**
   * @param keys entries that run
   * @returns the ones NZBVortex paused — one it refuses (finished or gone meanwhile) runs on, nothing else stops
   */
  private async halt(keys: readonly string[]): Promise<string[]> {
    const done: string[] = [];
    for (const k of keys) {
      try {
        await this.client.get(`nzb/${k}/pause`);
        done.push(k);
      } catch (err: unknown) {
        if (!(err instanceof ProtocolError)) {
          throw err;
        }
        this.debug(`nzbvortex: ${k} not paused — ${errText(err)}`);
      }
    }
    return done;
  }

  /**
   * The links added while the pause holds: NZBVortex starts them, so the poll that finds one pauses and holds it — by
   * its `addUUID`, or, without one, as one of the first new running entries; when the pause ended meanwhile, they run.
   *
   * @param entries this poll's queue
   * @param before every id of the poll before
   */
  private async holdAdded(entries: readonly NvEntry[], before: ReadonlySet<string> | null): Promise<void> {
    if (!this.adding.length) {
      return;
    }
    if (!(await this.pause.isPaused())) {
      this.adding = [];
      return;
    }
    const found: NvEntry[] = [];
    const left: (string | null)[] = [];
    for (const uuid of this.adding) {
      const hit = uuid === null ? undefined : entries.find(e => e.row.addUUID === uuid);
      if (hit) {
        found.push(hit);
      } else {
        left.push(uuid);
      }
    }
    const blind = left.filter(u => u === null).length;
    const fresh = before
      ? entries.filter(e => !before.has(e.id) && isRunning(e) && !found.includes(e)).slice(0, blind)
      : [];
    // the blind links the fresh entries answer are done
    let answered = fresh.length;
    this.adding = left.filter(u => {
      if (u === null && answered > 0) {
        answered--;
        return false;
      }
      return true;
    });
    // an entry that came in paused (a group of NZBVortex may say so) is no download the adapter stopped
    const stop = [...found.filter(isRunning), ...fresh].map(e => e.id);
    if (!stop.length) {
      return;
    }
    for (const k of await this.halt(stop)) {
      await this.pause.hold(k);
      const e = this.entries.get(k);
      if (e) {
        e.paused = true;
      }
    }
  }
}

/**
 * @param key a download's key from the adapter's tree
 * @returns it, when it is an NZB id — the key goes into the call's path
 */
function idOf(key: string): string {
  if (!/^\d+$/.test(key)) {
    throw new ProtocolError(`NZBVortex: no NZB ${key}`);
  }
  return key;
}
