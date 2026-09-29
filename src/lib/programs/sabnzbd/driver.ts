import { AuthError, ProtocolError } from "../../core/errors";
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
import { SabClient } from "./client";
import { toSnapshot } from "./map";

/** History entries the driver mirrors — without a limit SABnzbd applies its own (short) history_limit. */
const HISTORY_LIMIT = "1000";

/** Retry of a failed job (a new nzo_id: the old channel goes, a new one comes). */
const EXTRAS: readonly ExtraDefinition[] = [RETRY_EXTRA];

/** SABnzbd 4.x / 5.x. Real global pause; no speed or ETA per job (SABnzbd reports neither). */
export class SabDriver implements ProgramDriver {
  public readonly type = "sabnzbd";
  public readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "globalPause",
    "itemPause",
    "itemRemove",
    "add",
    "speedLimit",
    "freeSpace",
    "itemAdded",
    "itemFinished",
    "category",
    "itemError",
  ]);
  public readonly extras = EXTRAS;
  private readonly client: SabClient;
  private historyUpdate = "0";
  private history: unknown[] = [];
  private inQueue = new Set<string>();

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.client = new SabClient(cfg, deps);
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    const q = (await this.client.call({ mode: "queue" })).queue;
    const queue = q && typeof q === "object" ? (q as Record<string, unknown>) : {};
    const h = (
      await this.client.call({ mode: "history", limit: HISTORY_LIMIT, last_history_update: this.historyUpdate })
    ).history;
    if (h && typeof h === "object") {
      const hist = h as Record<string, unknown>;
      this.history = Array.isArray(hist.slots) ? hist.slots : [];
      const update = hist.last_history_update;
      this.historyUpdate = typeof update === "number" || typeof update === "string" ? String(update) : "0";
    }
    const slots = Array.isArray(queue.slots) ? (queue.slots as Record<string, unknown>[]) : [];
    this.inQueue = new Set(slots.map(s => String(s.nzo_id)));
    const status = (await this.client.call({ mode: "status", skip_dashboard: "1" })).status;
    const ppPause = (status as { pp_pause_event?: unknown } | null | undefined)?.pp_pause_event === true;
    return toSnapshot(queue, this.history, m => this.deps.log.debug(m), ppPause);
  }

  /** @returns the version, after SABnzbd confirmed the key as its full API key (`mode=auth`, no warning on a miss) */
  public async test(): Promise<string> {
    const auth = (await this.client.callWithoutKey({ mode: "auth", key: this.client.apiKey })).auth;
    if (auth !== "apikey") {
      throw new AuthError(
        auth === "nzbkey"
          ? "sabnzbd: this is the NZB key — the adapter needs the API key"
          : "sabnzbd: the API key was not accepted",
      );
    }
    const version = (await this.client.callWithoutKey({ mode: "version" })).version;
    return typeof version === "string" ? version : "";
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pause":
      case "resume":
        if (!this.inQueue.has(cmd.key)) {
          throw new ProtocolError("sabnzbd: only a job in the queue can be paused or resumed");
        }
        await this.client.call({ mode: "queue", name: cmd.kind, value: cmd.key });
        return;
      case "remove":
        await this.client.call(
          this.inQueue.has(cmd.key)
            ? { mode: "queue", name: "delete", value: cmd.key }
            : { mode: "history", name: "delete", value: cmd.key },
        );
        this.historyUpdate = "0";
        return;
      case "add":
        await this.client.call({ mode: "addurl", name: cmd.url });
        return;
      case "pauseAll":
        await this.client.call({ mode: "pause" });
        return;
      case "resumeAll":
        await this.client.call({ mode: "resume" });
        return;
      case "setSpeedLimit":
        // with a unit: a bare 1–100 would be a percentage of bandwidth_max
        await this.client.call({
          mode: "config",
          name: "speedlimit",
          value: cmd.bps > 0 ? `${Math.max(1, Math.round(cmd.bps / 1024))}K` : "0",
        });
        return;
      case "extra":
        if (cmd.name === "retry" && cmd.key) {
          await this.client.call({ mode: "retry", value: cmd.key });
          this.historyUpdate = "0";
          return;
        }
        throw new ProtocolError(`sabnzbd: unknown extra ${cmd.name}`);
      default:
        throw new ProtocolError("sabnzbd: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }
}
