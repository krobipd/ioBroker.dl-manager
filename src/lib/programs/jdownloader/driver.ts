import { errText } from "../../err-text";
import { ProtocolError } from "../../core/errors";
import type { Capability, Command, ProgramDriver, ProgramSnapshot, DriverDeps, ProgramConfig } from "../../core/model";
import { GENERAL_SETTINGS, jdBaseUrl, JdLocalTransport, type JdTransport } from "./client";
import { JdCloudTransport } from "./cloud";
import { isHeld, toSnapshot } from "./map";
import { asRecord, asRecords } from "../../core/units";

const PACKAGE_QUERY = {
  bytesLoaded: true,
  bytesTotal: true,
  childCount: true,
  enabled: true,
  eta: true,
  finished: true,
  running: true,
  saveTo: true,
  speed: true,
  status: true,
  maxResults: -1,
  startAt: 0,
};
const LINK_QUERY = {
  addedDate: true,
  advancedStatus: true,
  bytesLoaded: true,
  bytesTotal: true,
  enabled: true,
  eta: true,
  extractionStatus: true,
  finished: true,
  finishedDate: true,
  running: true,
  skipped: true,
  speed: true,
  status: true,
  maxResults: -1,
  startAt: 0,
};
/** Seconds JD holds an event long poll open (`pollTimeout` 25 s) plus room. */
const LISTEN_TIMEOUT_MS = 35_000;
/** Pause before the next subscription after a failed one. */
const RESUBSCRIBE_MS = 30_000;
/** How often an add to a held controller asks the link grabber for the crawled link, and how long it waits between. */
const CRAWL_ATTEMPTS = 10;
const CRAWL_WAIT_MS = 1_000;

/** JDownloader 2: a download is a package; the transport is local (Deprecated API) or My.JDownloader (Task 17). */
export class JdDriver implements ProgramDriver {
  public readonly type: "jdownloader" | "jdownloader-cloud";
  public readonly minIntervalMs?: number;
  public readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "globalPause",
    "itemPause",
    "itemRemove",
    "add",
    "speedLimit",
    "itemSpeed",
    "itemEta",
    "itemAdded",
    "itemFinished",
    "itemError",
  ]);
  public readonly extras = [];
  private readonly api: JdTransport;
  private readonly events: JdTransport | null;
  private version: string | null = null;

  /**
   * @param cfg the settings row
   * @param deps adapter services
   * @param api transport for the calls (default: local API)
   * @param events transport for the event long poll (default: local API with a long deadline; null = no push)
   */
  public constructor(
    cfg: ProgramConfig,
    private readonly deps: DriverDeps,
    api?: JdTransport,
    events?: JdTransport | null,
  ) {
    const viaCloud = cfg.type === "jdownloader-cloud";
    this.type = viaCloud ? "jdownloader-cloud" : "jdownloader";
    if (viaCloud) {
      // My.JDownloader's limits are not documented — Home Assistant asks every 60 s, the adapter at most every 30 s
      this.minIntervalMs = 30_000;
    }
    this.api = api ?? (viaCloud ? new JdCloudTransport(cfg, deps) : new JdLocalTransport(jdBaseUrl(cfg), deps));
    this.events =
      events !== undefined ? events : viaCloud ? null : new JdLocalTransport(jdBaseUrl(cfg), deps, LISTEN_TIMEOUT_MS);
  }

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    try {
      return await this.query();
    } catch (err: unknown) {
      // JDownloader may be restarting for an update: the next query asks its version again
      this.version = null;
      throw err;
    }
  }

  /** @returns one complete query */
  private async query(): Promise<ProgramSnapshot> {
    if (this.version === null) {
      const version = await this.api.call("/jd/version");
      this.version = typeof version === "number" || typeof version === "string" ? String(version) : "";
    }
    const toolbar = await this.api.call("/toolbar/getStatus");
    const packages = await this.api.call("/downloadsV2/queryPackages", [PACKAGE_QUERY]);
    let links: unknown = null;
    try {
      links = await this.api.call("/downloadsV2/queryLinks", [LINK_QUERY]);
    } catch (err: unknown) {
      this.deps.log.debug(`jdownloader: link list failed, packages only: ${errText(err)}`);
    }
    return toSnapshot(this.version, toolbar, packages, links, m => this.deps.log.debug(m));
  }

  /**
   * Adds a link. JDownloader starts a held controller again for a link added with autostart (measured 2026-10-01,
   * v26.09.1) — so while the controller is held, the link goes in without it and is moved into the download list once
   * the crawler knows it: the download is there, the pause holds.
   *
   * @param url the link
   */
  private async add(url: string): Promise<void> {
    if (!isHeld(await this.api.call("/downloadcontroller/getCurrentState"))) {
      await this.api.call("/linkgrabberv2/addLinks", [{ links: url, autostart: true, assignJobID: true }]);
      return;
    }
    const job = asRecord(
      await this.api.call("/linkgrabberv2/addLinks", [{ links: url, autostart: false, assignJobID: true }]),
    ).id;
    for (let attempt = 0; attempt < CRAWL_ATTEMPTS; attempt++) {
      const links = asRecords(await this.api.call("/linkgrabberv2/queryLinks", [{ jobUUIDs: [job] }]));
      if (links.length) {
        await this.api.call("/linkgrabberv2/moveToDownloadlist", [
          links.map(l => l.uuid),
          [...new Set(links.map(l => l.packageUUID))],
        ]);
        return;
      }
      await new Promise<void>(resolve => {
        // the adapter refuses a timer while it stops — then there is nothing left to wait for
        if (this.deps.setTimeout(resolve, CRAWL_WAIT_MS) === undefined) {
          resolve();
        }
      });
    }
    throw new ProtocolError("jdownloader: the link was not crawled in time — it waits in the link grabber");
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    const pkg = (key: string): number[] => [Number(key)];
    switch (cmd.kind) {
      case "pauseAll":
        await this.api.call("/downloadcontroller/stop");
        return;
      case "resumeAll":
        if ((await this.api.call("/downloadcontroller/getCurrentState")) === "PAUSE") {
          await this.api.call("/downloadcontroller/pause", [false]);
        }
        await this.api.call("/downloadcontroller/start");
        return;
      case "pause":
        await this.api.call("/downloadsV2/setEnabled", [false, [], pkg(cmd.key)]);
        return;
      case "resume":
        await this.api.call("/downloadsV2/setEnabled", [true, [], pkg(cmd.key)]);
        await this.api.call("/downloadsV2/resumeLinks", [[], pkg(cmd.key)]);
        return;
      case "remove":
        await this.api.call("/downloadsV2/removeLinks", [[], pkg(cmd.key)]);
        return;
      case "add":
        await this.add(cmd.url);
        return;
      case "setSpeedLimit":
        if (cmd.bps > 0) {
          await this.api.call("/config/set", [GENERAL_SETTINGS, null, "DownloadSpeedLimit", cmd.bps]);
        }
        await this.api.call("/config/set", [GENERAL_SETTINGS, null, "DownloadSpeedLimitEnabled", cmd.bps > 0]);
        return;
      default:
        throw new ProtocolError(`jdownloader: ${cmd.kind} is not supported`);
    }
  }

  /** Aborts a waiting long poll. */
  public close(): Promise<void> {
    this.api.close();
    this.events?.close();
    return Promise.resolve();
  }

  /**
   * JD's event long poll as a push channel: any event only triggers a poll.
   *
   * @param onChange called when JD reports a change
   * @returns stops listening
   */
  public subscribe(onChange: () => void): () => void {
    const events = this.events;
    if (!events) {
      // no push through the cloud — every event would be one more request against undocumented limits
      return () => undefined;
    }
    let stopped = false;
    let id: number | undefined;
    const pause = (): Promise<void> =>
      new Promise(resolve => {
        if (!this.deps.setTimeout(resolve, RESUBSCRIBE_MS)) {
          resolve();
        }
      });
    const loop = async (): Promise<void> => {
      while (!stopped) {
        try {
          if (id === undefined) {
            const sub = await events.call("/events/subscribe", [["downloads\\..*", "downloadwatchdog\\..*"], []]);
            const sid = (sub as { subscriptionid?: unknown } | null)?.subscriptionid;
            if (typeof sid !== "number") {
              throw new ProtocolError("jdownloader: event subscription without id");
            }
            id = sid;
          }
          const got = await events.call("/events/listen", [id]);
          if (!stopped && Array.isArray(got) && got.length > 0) {
            onChange();
          }
        } catch (err: unknown) {
          id = undefined;
          if (!stopped) {
            this.deps.log.debug(`jdownloader: event channel interrupted: ${errText(err)}`);
            await pause();
          }
        }
      }
    };
    void loop();
    // no unsubscribe on stop: the adapter is shutting down and refuses the request's deadline timer, close() aborts the
    // request anyway — JD drops a subscription nobody listens to after its keepalive (120 s)
    return () => {
      stopped = true;
    };
  }
}
