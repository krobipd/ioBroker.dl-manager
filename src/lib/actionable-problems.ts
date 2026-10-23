// Fleet master (.consistency-master/src/lib/actionable-problems.ts) — never edit the copy in an adapter.
/** A single user-actionable problem: what is wrong + what the user must do. */
export interface ActionableProblem {
  /**
   * Stable key — one active problem per key. Re-reporting the same key while it
   * is active is a no-op (spam-free). Example: `"mqtt-verification"`.
   */
  key: string;
  /** One sentence: what is wrong (user-facing, no jargon). */
  title: string;
  /** One sentence: what the user must do to fix it. */
  action: string;
}

/**
 * The side-effect surface the registry talks to. Abstracted so the registry is
 * pure logic and unit-testable without a live adapter. The real host wraps the
 * adapter logger + `registerNotification`; tests inject a capturing fake.
 */
export interface ActionableProblemsHost {
  /** Clear, user-facing warn line (first occurrence of a problem). */
  logWarn(message: string): void;
  /** Resolution / positive-feedback line (problem cleared). */
  logInfo(message: string): void;
  /**
   * Raise a persistent ioBroker notification carrying the message. Idempotent
   * from the caller's view — the platform caps duplicates via the category
   * `limit`, so callers never have to dedup across restarts.
   */
  notify(message: string): void;
}

/**
 * Central registry for user-actionable problems (a login the counterpart refuses, a verification it waits for). One
 * mechanism every error site can feed. Measured 2026-10-03: two adapters carried the same class with one difference —
 * a resolution line (`resolve`) or none (`forget`); the master has both.
 *
 * Which problems belong here: error classes the USER must fix because they
 * never self-heal — verification pending/failed and rejected credentials (the AUTH-shaped failures). Transient classes
 * keep the warn-once-then-debug rule of `log-once.ts` and never reach this registry — enforced by where `report()` is
 * wired (only at verification/auth failure sites), not by a runtime gate.
 *
 * Behaviour (the "intelligent, no-spam" contract):
 *  - **report** a NEW problem → surface it ONCE: a clear "what → what to do"
 *    warn line + a persistent notification (stays in the Admin / forwards via
 *    notification-manager until the user acknowledges it).
 *  - **report** an already-active problem → no-op. No log/notification spam
 *    while it stays unresolved within a session.
 *  - **resolve** an active problem → a single positive `info` line. The
 *    notification is left for the user to acknowledge (ioBroker has no adapter
 *    API to clear one — using the platform as designed, no host-command hacks).
 *
 *  - **forget** a problem without a line → the caller logs what happened instead (the device was deleted, or it starts
 *    anew and its first answer is logged).
 *
 * Transient problems never reach here — they self-heal and keep the warn-once-then-debug rule.
 */
export class ActionableProblems {
  private readonly active = new Map<string, ActionableProblem>();

  /**
   * @param host side-effect surface (logger + notification raiser)
   */
  constructor(private readonly host: ActionableProblemsHost) {}

  /**
   * Report an actionable problem. Surfaces it (warn + notification) when it is
   * NEW or when its message changed since last time (e.g. the verification
   * problem turning from "code needed" into "code rejected"). An identical
   * re-report of an already-active problem is a no-op — no spam.
   *
   * @param problem the problem to surface
   */
  report(problem: ActionableProblem): void {
    const line = `${problem.title} → ${problem.action}`;
    const existing = this.active.get(problem.key);
    if (existing && `${existing.title} → ${existing.action}` === line) {
      return; // identical and still active — already surfaced, stay quiet
    }
    this.active.set(problem.key, problem);
    this.host.logWarn(line);
    this.host.notify(line);
  }

  /**
   * Mark a problem resolved. Logs a single resolution line if it was active.
   *
   * @param key the problem key to clear
   * @param resolutionMessage optional positive message; falls back to a default
   */
  resolve(key: string, resolutionMessage?: string): void {
    const problem = this.active.get(key);
    if (!problem) {
      return;
    }
    this.active.delete(key);
    this.host.logInfo(resolutionMessage ?? `Resolved: ${problem.title}`);
  }

  /**
   * Drop a problem without a line — the caller logs what happened instead.
   *
   * @param key the problem key to drop
   */
  forget(key: string): void {
    this.active.delete(key);
  }
}
