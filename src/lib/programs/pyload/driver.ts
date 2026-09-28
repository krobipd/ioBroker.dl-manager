import { errText } from "../../err-text";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, ProgramDriver, ProgramSnapshot } from "../../core/model";
import type { DriverDeps, ProgramConfig } from "../registry";
import { PyClient } from "./client";
import { toSnapshot } from "./map";

/** Polls between two reads of the speed limit — a poll is four calls, pyLoad allows 100 a minute. */
const LIMIT_EVERY = 10;

/** pyLoad-ng 0.5. A download is a package; no pause per package (only abort), a real server pause. */
export class PyDriver implements ProgramDriver {
  public readonly type = "pyload";
  public readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "globalPause",
    "itemRemove",
    "add",
    "speedLimit",
    "freeSpace",
    "itemSpeed",
    "itemEta",
    "itemError",
  ]);
  public readonly extras = [];
  private readonly client: PyClient;
  private version = "";
  private limit: { on: boolean; kib: number } | null = null;
  private polls = 0;

  /**
   * @param cfg the settings row
   * @param deps adapter services
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
  ) {
    this.client = new PyClient(cfg, deps);
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    if (!this.version) {
      const v = await this.client.get("get_server_version");
      this.version = typeof v === "string" ? v : "";
    }
    const server = await this.client.get("status_server");
    const queue = await this.client.get("get_queue_data");
    const active = await this.client.get("status_downloads");
    const free = await this.client.get("free_space");
    if (this.polls++ % LIMIT_EVERY === 0) {
      await this.readLimit();
    }
    return toSnapshot(this.version, server, queue, active, free, this.limit, m => this.deps.log.debug(m));
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "remove":
        // only the list entry — pyLoad keeps the files
        await this.client.post("delete_packages", { package_ids: [Number(cmd.key)] });
        return;
      case "add": {
        const name = cmd.url.split(/[/?#]/).filter(Boolean).pop() ?? "download";
        await this.client.post("add_package", { name, links: [cmd.url], dest: 1 });
        return;
      }
      case "pauseAll":
        await this.client.post("pause_server");
        return;
      case "resumeAll":
        await this.client.post("unpause_server");
        return;
      case "setSpeedLimit":
        if (cmd.bps > 0) {
          await this.client.post("set_config_value", {
            category: "download",
            option: "max_speed",
            value: Math.max(1, Math.round(cmd.bps / 1024)),
          });
        }
        await this.client.post("set_config_value", { category: "download", option: "limit_speed", value: cmd.bps > 0 });
        this.polls = 0;
        return;
      default:
        throw new ProtocolError("pyload: command not supported");
    }
  }

  /** Aborts what is still waiting. */
  public close(): Promise<void> {
    this.client.close();
    return Promise.resolve();
  }

  private async readLimit(): Promise<void> {
    try {
      const on = await this.client.get("get_config_value", { category: "download", option: "limit_speed" });
      const kib = await this.client.get("get_config_value", { category: "download", option: "max_speed" });
      this.limit = { on: on === true || on === "True", kib: Number(kib) || 0 };
    } catch (err: unknown) {
      this.deps.log.debug(`pyload: speed limit not read: ${errText(err)}`);
    }
  }
}
