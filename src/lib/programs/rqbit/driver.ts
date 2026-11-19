import { EmulatedPause, memoryPauseStore } from "../../core/emulated-pause";
import { ProtocolError } from "../../core/errors";
import { errText } from "../../err-text";
import { idIn, recordIn, recordsIn } from "../../core/answer";
import { asRecord, asText } from "../../core/units";
import type { Capability, Command, DriverDeps, ProgramConfig, ProgramDriver, ProgramSnapshot } from "../../core/model";
import { ProgramVersion } from "../../core/version";
import { RqClient } from "./client";
import { limitsIn, stateOf, statsIn, toSnapshot } from "./map";

/** The states a torrent can be paused from. */
const RUNNING = new Set(["live", "initializing"]);

/** The limit `setLimits` changes, null = unlimited. */
type LimitChange = { download_bps?: number | null; upload_bps?: number | null };

/**
 * rqbit over its HTTP API. It has no queue and no pause of its own for everything — the global pause is made by the
 * adapter (plan § 5.3), like Transmission's.
 */
export class RqDriver implements ProgramDriver {
  public readonly type = "rqbit";
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
  private readonly client: RqClient;
  private readonly pause: EmulatedPause;
  private readonly version = new ProgramVersion();
  private running: string[] = [];
  /** Torrents added during the pause that rqbit did not pause yet, oldest first. */
  private adding: string[] = [];
  private limits: Record<string, unknown> = {};

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.client = new RqClient(cfg, deps);
    this.pause = new EmulatedPause(deps.pauseStore ?? memoryPauseStore());
  }

  /** @returns one complete query */
  public poll(): Promise<ProgramSnapshot> {
    return this.version.poll(
      async () => asText(recordIn(await this.client.get("/"), "rqbit's root").version),
      version => this.query(version),
    );
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pause":
        await this.client.post(`/torrents/${cmd.key}/pause`);
        return;
      case "resume":
        await this.client.post(`/torrents/${cmd.key}/start`);
        return;
      case "remove":
        // forget keeps the files, delete would remove them (handlers/mod.rs)
        await this.client.post(`/torrents/${cmd.key}/forget`);
        return;
      case "add": {
        const res = asRecord(await this.client.add(cmd.url));
        const added = asRecord(res.details).info_hash;
        // rqbit adds running — while the adapter holds the program paused, the new torrent is paused and held too; asked
        // after the answer, which may come minutes later (a magnet's metadata), so a pause set meanwhile counts
        if (typeof added === "string" && (await this.pause.isPaused())) {
          this.adding.push(added);
          await this.holdAdded();
        }
        return;
      }
      case "pauseAll":
        // one torrent per call: one rqbit no longer knows (404, ended or gone meanwhile) is skipped
        await this.pause.pauseEach(
          this.running,
          k => this.client.post(`/torrents/${k}/pause`),
          (k, err) => this.deps.log.debug(`rqbit: ${k} not paused — ${errText(err)}`),
        );
        return;
      case "resumeAll":
        await this.pause.resumeEach(
          k => this.client.post(`/torrents/${k}/start`),
          (k, err) => this.deps.log.debug(`rqbit: ${k} not resumed — ${errText(err)}`),
        );
        return;
      case "setSpeedLimit":
        await this.setLimits({ download_bps: cmd.bps > 0 ? cmd.bps : null });
        return;
      case "setUploadLimit":
        await this.setLimits({ upload_bps: cmd.bps > 0 ? cmd.bps : null });
        return;
      default:
        throw new ProtocolError("rqbit: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  /**
   * @param version the program version
   * @returns the snapshot of torrent list, stats and limits
   */
  private async query(version: string): Promise<ProgramSnapshot> {
    const torrents = recordsIn(
      recordIn(await this.client.get("/torrents?with_stats=true"), "rqbit's torrent list").torrents,
      "rqbit's torrent list",
    );
    const stats = statsIn(await this.client.get("/stats"));
    // 8.x sets limits but cannot tell them: the datapoints stay empty, the last limits the adapter set stay its base
    const limits = await this.client.getIfServed("/torrents/limits");
    if (limits !== undefined) {
      this.limits = limitsIn(limits);
    }
    const hashes = torrents.map(t => idIn(t, "info_hash", "rqbit's torrent list", "text"));
    const states = new Map(hashes.map((h, i) => [h, stateOf(asRecord(torrents[i].stats))]));
    const held = await this.holdAdded(states);
    for (const [i, h] of hashes.entries()) {
      if (held.has(h)) {
        // paused just now: it counts as paused in this list too
        asRecord(torrents[i].stats).state = "paused";
        states.set(h, "paused");
      }
    }
    // what the global pause stops: live and initializing torrents — rqbit refuses to pause one in error state
    // (torrent_state/mod.rs `pause`), and a paused one is no part of it, also one 9.x paused during its check
    this.running = hashes.filter(h => RUNNING.has(states.get(h) ?? ""));
    const paused = await this.pause.observe(new Set(this.running), new Set(hashes));
    return toSnapshot(version, torrents, stats, limits === undefined ? null : this.limits, paused, m =>
      this.deps.log.debug(m),
    );
  }

  /**
   * Pauses and holds the torrents added during the pause. 8.x refuses to pause a torrent while it checks files that are
   * already there (400 "torrent is initializing, can't pause", recording 8.1.1 `torrent-pause-checking`): such a one waits
   * for the poll after its check; one rqbit no longer lists, or refuses once listed, is dropped; any other failure keeps
   * the rest for the next poll. When the pause ended meanwhile, they run.
   *
   * @param states rqbit's state of each listed torrent by hash, from this poll — none right after the add
   * @returns the torrents paused and held here
   */
  private async holdAdded(states?: ReadonlyMap<string, string>): Promise<Set<string>> {
    const held = new Set<string>();
    if (!(await this.pause.isPaused())) {
      this.adding = [];
      return held;
    }
    const later: string[] = [];
    try {
      while (this.adding.length) {
        const key = this.adding[0];
        const state = states ? states.get(key) : "";
        if (state === "initializing") {
          later.push(key);
        } else if (state !== undefined) {
          try {
            await this.client.post(`/torrents/${key}/pause`);
            await this.pause.hold(key);
            held.add(key);
          } catch (err: unknown) {
            if (!(err instanceof ProtocolError)) {
              throw err;
            }
            if (states) {
              this.deps.log.debug(`rqbit: ${key} not paused — ${errText(err)}`);
            } else {
              later.push(key);
            }
          }
        }
        this.adding.shift();
      }
    } finally {
      this.adding = [...later, ...this.adding];
    }
    return held;
  }

  /**
   * `POST /torrents/limits` sets both limits at once — the one not named keeps the value of the last poll (9.x) or the
   * last one the adapter set (8.x cannot tell its limits; unlimited after a start).
   *
   * @param change the limit to set, null = unlimited
   */
  private async setLimits(change: LimitChange): Promise<void> {
    const keep = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : null);
    const next = { download_bps: keep(this.limits.download_bps), upload_bps: keep(this.limits.upload_bps), ...change };
    await this.client.post("/torrents/limits", { json: next });
    // a second limit set before the next poll keeps this one
    this.limits = next;
  }
}
