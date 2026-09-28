import { errText } from "../err-text";
import { classify } from "./errors";
import type { Command, ProgramDriver, ProgramSnapshot } from "./model";
import { redact } from "./redact";
import type { ProgramEvents } from "./tree";

/** Adapter services the runner needs — a seam for the tests. */
export interface RunnerDeps {
  /** The adapter's timer (never a bare setTimeout). */
  setTimeout(cb: () => void, ms: number): ioBroker.Timeout | undefined;
  /** Clears an adapter timer. */
  clearTimeout(t: ioBroker.Timeout | undefined): void;
  /** The adapter log. */
  log: { debug(msg: string): void; info(msg: string): void; warn(msg: string): void };
  /** Actionable problems (fleet pattern, `actionable-problems.ts`): the one warn + notification for a rejected login. */
  problems: { report(key: string, title: string, action: string): void; resolve(key: string, msg: string): void };
}

/** The tree methods the runner calls. */
export interface RunnerTree {
  /** Writes one poll result. */
  sync(snapshot: ProgramSnapshot): Promise<ProgramEvents>;
  /** Marks the program offline with a reason. */
  markOffline(reason: string): Promise<void>;
}

/**
 * Runs ONE program: polls it on its own timer, writes the result through its tree and keeps every failure to itself
 * — a program that throws never stops another one.
 */
export class ProgramRunner {
  private timer: ioBroker.Timeout | undefined = undefined;
  private polling: Promise<void> | null = null;
  private stopped = false;
  private unsubscribe: (() => void) | undefined = undefined;
  private lastProblem = "";
  private _online = false;
  private _lockedByAuth = false;
  private _lastSnapshot: ProgramSnapshot | null = null;

  /**
   * @param id device id of the program, e.g. `qbittorrent-nas` (log prefix and problem key)
   * @param driver the program's driver
   * @param tree the program's tree
   * @param deps adapter services
   * @param intervalMs time between two polls
   * @param onChange called after every poll — with the sync's events, or with no events when the poll failed
   */
  public constructor(
    public readonly id: string,
    private readonly driver: ProgramDriver,
    private readonly tree: RunnerTree,
    private readonly deps: RunnerDeps,
    private readonly intervalMs: number,
    private readonly onChange: (events: ProgramEvents) => void,
  ) {}

  /** @returns whether the last poll succeeded */
  public get online(): boolean {
    return this._online;
  }

  /** @returns whether the program refused the login (no more calls until the configuration changes) */
  public get lockedByAuth(): boolean {
    return this._lockedByAuth;
  }

  /** @returns the last successful poll result */
  public get lastSnapshot(): ProgramSnapshot | null {
    return this._lastSnapshot;
  }

  /** First poll now, then every interval; a push notification of the driver polls at once. */
  public start(): void {
    this.unsubscribe = this.driver.subscribe?.(() => void this.pollNow());
    void this.pollNow();
  }

  /** Polls at once unless a poll is running; resolves when that poll is done. */
  public pollNow(): Promise<void> {
    if (this.stopped || this._lockedByAuth) {
      return Promise.resolve();
    }
    if (this.polling) {
      return this.polling;
    }
    this.deps.clearTimeout(this.timer);
    this.timer = undefined;
    this.polling = this.poll().finally(() => {
      this.polling = null;
      this.schedule();
    });
    return this.polling;
  }

  /**
   * Sends a command and polls right after it.
   *
   * @param cmd the command
   */
  public async command(cmd: Command): Promise<void> {
    if (this._lockedByAuth) {
      throw new Error(
        `${this.id}: the program refused the login — fix user/password or API key in the adapter settings`,
      );
    }
    await this.driver.command(cmd);
    void this.pollNow();
  }

  /** Stops the timer and the push channel, closes the driver and marks the program Unknown. */
  public async stop(): Promise<void> {
    this.stopped = true;
    this.deps.clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    try {
      await this.driver.close();
    } catch (err: unknown) {
      this.deps.log.debug(`[${this.id}] close failed: ${errText(err)}`);
    }
    this._online = false;
    await this.tree.markOffline("Unknown");
  }

  private schedule(): void {
    if (this.stopped || this._lockedByAuth) {
      return;
    }
    this.timer = this.deps.setTimeout(() => void this.pollNow(), this.intervalMs);
  }

  private async poll(): Promise<void> {
    try {
      const snapshot = await this.driver.poll();
      if (this.stopped) {
        return;
      }
      const events = await this.tree.sync(snapshot);
      this._lastSnapshot = snapshot;
      if (!this._online) {
        this.deps.log.debug(`[${this.id}] reachable`);
      }
      this._online = true;
      this.lastProblem = "";
      this.onChange(events);
    } catch (err: unknown) {
      await this.handle(err);
      if (!this.stopped) {
        this.onChange({ finished: [], failed: [], removedFromTree: 0 });
      }
    }
  }

  private async handle(err: unknown): Promise<void> {
    const text = redact(errText(err));
    const kind = classify(err);
    this._online = false;
    try {
      await this.tree.markOffline(text);
    } catch (e: unknown) {
      this.deps.log.debug(`[${this.id}] could not mark offline: ${errText(e)}`);
    }
    if (kind === "auth") {
      this._lockedByAuth = true;
      this.deps.problems.report(
        `auth:${this.id}`,
        `${this.id}: login rejected (${text}), the program is not asked again until the settings change`,
        "check user/password or API key in the adapter settings",
      );
      return;
    }
    if (kind === "unreachable") {
      this.deps.log.debug(`[${this.id}] not reachable: ${text}`);
      return;
    }
    if (text !== this.lastProblem) {
      this.lastProblem = text;
      this.deps.log.warn(`[${this.id}] ${text}`);
    } else {
      this.deps.log.debug(`[${this.id}] ${text}`);
    }
  }
}
