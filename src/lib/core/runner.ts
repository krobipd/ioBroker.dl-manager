import { errText } from "../err-text";
import { classify } from "./errors";
import type { HttpTimers } from "./http";
import type { LoginHint } from "./login-hint";
import type { AdapterLog, Command, ProgramDriver, ProgramSnapshot } from "./model";
import { redact } from "./redact";
import type { ProgramEvents } from "./tree";

/** The same failure text is warned once in this window per program — repeats go to debug, also after a good poll. */
export const WARN_COOLDOWN_MS = 60 * 60 * 1000;
/** How many failure texts per program the warn window remembers. */
export const WARN_MEMORY = 20;

/** Adapter services the runner needs — a seam for the tests. */
export interface RunnerDeps extends HttpTimers {
  /** The adapter log. */
  log: AdapterLog;
  /** Actionable problems (fleet pattern, `actionable-problems.ts`): the one warn + notification for a rejected login. */
  problems: { report(key: string, title: string, action: string): void };
  /** The clock for the warn window, `Date.now` when absent. */
  now?: () => number;
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
  /** Failure text → when it was last warned. */
  private readonly warnedAt = new Map<string, number>();
  /** Set by a card change: the next poll result goes to info, with this product name. */
  private announceLabel: string | null = null;
  private _online = false;
  private _lockedByAuth = false;
  private _lastSnapshot: ProgramSnapshot | null = null;

  /**
   * @param id device id of the program, e.g. `qbittorrent-nas` (log prefix and problem key)
   * @param driver the program's driver
   * @param tree the program's tree
   * @param deps adapter services
   * @param intervalMs time between two polls
   * @param onChange called after every poll — with the sync's events and `true`, or with no events and `false` when
   *   the poll failed
   * @param login what a rejected login tells the user (`login-hint.ts`)
   */
  public constructor(
    public readonly id: string,
    private readonly driver: ProgramDriver,
    private readonly tree: RunnerTree,
    private readonly deps: RunnerDeps,
    private readonly intervalMs: number,
    private readonly onChange: (events: ProgramEvents, ok: boolean) => void,
    private readonly login: LoginHint = { action: "check the login on its card" },
  ) {}

  /**
   * A card change started this program: the result of its next poll is written on info — answering, not reachable,
   * or the failure — once.
   *
   * @param label the product name, e.g. `Transmission`
   */
  public announceNextResult(label: string): void {
    this.announceLabel = label;
  }

  /** @returns whether the last poll succeeded */
  public get online(): boolean {
    return this._online;
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
      throw new Error(`${this.id}: the program refused the login — ${this.login.action}`);
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
    // a tree write already under way finishes first, so "Unknown" is the last word
    await this.polling;
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
      this.deps.log.debug(
        `[${this.id}] polled: ${snapshot.items.length} download(s)${snapshot.complete ? "" : ", lists incomplete"}`,
      );
      if (this.announceLabel !== null) {
        const version = snapshot.status.version;
        this.deps.log.info(`${this.id}: answering (${this.announceLabel}${version ? ` ${version}` : ""})`);
        this.announceLabel = null;
      } else if (!this._online) {
        this.deps.log.debug(`[${this.id}] reachable`);
      }
      this._online = true;
      this.onChange(events, true);
    } catch (err: unknown) {
      await this.handle(err);
      if (!this.stopped) {
        this.onChange({ finished: [], failed: [], removedFromTree: 0 }, false);
      }
    }
  }

  private async handle(err: unknown): Promise<void> {
    if (this.stopped) {
      return;
    }
    const text = redact(errText(err));
    const kind = classify(err);
    const announced = this.announceLabel !== null;
    this.announceLabel = null;
    this._online = false;
    try {
      await this.tree.markOffline(text);
    } catch (e: unknown) {
      this.deps.log.debug(`[${this.id}] could not mark offline: ${errText(e)}`);
    }
    if (kind === "auth") {
      this._lockedByAuth = true;
      const cause = this.login.cause ? ` (${this.login.cause})` : "";
      this.deps.problems.report(
        `auth:${this.id}`,
        `${this.id}: ${text}${cause} — not asked again until its card changes`,
        this.login.action,
      );
      return;
    }
    if (kind === "unreachable") {
      if (announced) {
        this.deps.log.info(`${this.id}: not reachable — ${text}`);
      } else {
        this.deps.log.debug(`[${this.id}] not reachable: ${text}`);
      }
      return;
    }
    if (this.firstInWindow(text) || announced) {
      this.deps.log.warn(`${this.id}: ${text}`);
    } else {
      this.deps.log.debug(`[${this.id}] ${text}`);
    }
  }

  /**
   * @param text a failure text
   * @returns whether it was not warned within the last {@link WARN_COOLDOWN_MS} — and marks it warned now
   */
  private firstInWindow(text: string): boolean {
    const now = (this.deps.now ?? Date.now)();
    const last = this.warnedAt.get(text);
    if (last !== undefined && now - last < WARN_COOLDOWN_MS) {
      return false;
    }
    this.warnedAt.delete(text);
    if (this.warnedAt.size >= WARN_MEMORY) {
      // the oldest entry goes — a program with ever new texts keeps a bounded memory
      for (const oldest of this.warnedAt.keys()) {
        this.warnedAt.delete(oldest);
        break;
      }
    }
    this.warnedAt.set(text, now);
    return true;
  }
}
