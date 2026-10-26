import { errText } from "../err-text";
import { LogOnce } from "../log-once";
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
/**
 * Failed polls in a row double the time to the next one up to this (fleet suite D21: calls get fewer under a series of
 * errors) — an interval set longer stays as it is; a good poll, a command and a push ask at once again.
 */
export const BACKOFF_MAX_MS = 120_000;

/**
 * @param intervalMs the program's poll interval
 * @param failures failed polls in a row
 * @returns the time to the next poll
 */
export function nextPollMs(intervalMs: number, failures: number): number {
  return failures === 0 ? intervalMs : Math.max(intervalMs, Math.min(intervalMs * 2 ** failures, BACKOFF_MAX_MS));
}

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
  /** Marks the program unreachable — online false, every other value stays. */
  markUnreachable(): Promise<void>;
}

/**
 * Runs ONE program: polls it on its own timer, writes the result through its tree and keeps every failure to itself
 * — a program that throws never stops another one.
 */
export class ProgramRunner {
  private timer: ioBroker.Timeout | undefined = undefined;
  private polling: Promise<void> | null = null;
  /** A poll was asked for while one ran — that one may have read the program before the change, so one more follows. */
  private again = false;
  private stopped = false;
  private unsubscribe: (() => void) | undefined = undefined;
  /** The same failure text warns once per window (fleet master `log-once.ts`), repeats go to debug. */
  private readonly warnOnce: LogOnce;
  /** Set by a card change: the next poll result goes to info, with this product name. */
  private announceLabel: string | null = null;
  private _online = false;
  private _lockedByAuth = false;
  private failures = 0;
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
  ) {
    const log = deps.log;
    this.warnOnce = new LogOnce(
      // the runner warns at most — the adapter log of the drivers has no error level
      { debug: m => log.debug(m), info: m => log.info(m), warn: m => log.warn(m), error: m => log.warn(m) },
      { windowMs: WARN_COOLDOWN_MS, maxKeys: WARN_MEMORY, now: deps.now },
    );
  }

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

  /**
   * Polls at once; while a poll is running, one more follows right after it (a command or a push notification may
   * come after that poll read the program). Resolves when the running or the new poll is done.
   */
  public pollNow(): Promise<void> {
    if (this.stopped || this._lockedByAuth) {
      return Promise.resolve();
    }
    if (this.polling) {
      this.again = true;
      return this.polling;
    }
    this.deps.clearTimeout(this.timer);
    this.timer = undefined;
    this.polling = this.poll().finally(() => {
      this.polling = null;
      if (this.again) {
        this.again = false;
        void this.pollNow();
      } else {
        this.schedule();
      }
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
    this.timer = this.deps.setTimeout(() => void this.pollNow(), nextPollMs(this.intervalMs, this.failures));
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
      this.failures = 0;
      this.onChange(events, true);
    } catch (err: unknown) {
      this.failures++;
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
      // an outage shows only on reachability (krobi 2026-10-06 17:55) — the program's own text is no outage
      await (kind === "unreachable" ? this.tree.markUnreachable() : this.tree.markOffline(text));
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
    if (announced) {
      // a card change says its outcome once, whatever the window holds
      this.warnOnce.forget(text);
    }
    this.warnOnce.report(text, `${this.id}: ${text}`);
  }
}
