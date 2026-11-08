// The call budget: every call to a counterpart holds a place in each window src/lib/api-limits.json declares for it —
// while it is on its way, and once answered until a window's length after its answer, because the counterpart counts
// it at the latest when it answers (tooling round 170); a call that ended without an answer frees its place a window's
// length after its send. The windows come from the declaration as the adapter loaded it — the adapter takes its pace
// from nowhere else (tooling round 140). A window `per: "host"` has one lane per host (two programs on one machine share
// it), `per: "account"` one lane for every call to the counterpart.
//
// The places outlive a restart: a host restarts the instance after a change of its object, and the new process would
// begin with an empty minute that the old one had just filled. The places go to a file in the instance's data folder
// at the stop and come back at the start.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { API_COUNTERPARTS, type ApiCounterpart } from "../api-limits";

/** The file in the instance's data folder that hands the places to the next process. */
export const BUDGET_FILE = "call-budget.json";

/** The adapter's timer for a wait — never a bare setTimeout. */
export interface BudgetTimers {
  /** The adapter's timer. */
  setTimeout: (cb: () => void, ms: number) => ioBroker.Timeout | undefined;
  /** Clears an adapter timer. */
  clearTimeout: (t: ioBroker.Timeout | undefined) => void;
}

/** One call's place — the same object in every window it counts in. */
export interface CallPlace {
  /** When the call went out (epoch ms): taken at the hand-out, raised by {@link CallBudget.sent}. */
  sentAt: number;
  /** When the answer came (epoch ms), once it did. */
  answeredAt?: number;
  /** Whether the call is still on its way — an open call holds its place in every window. */
  open: boolean;
}

/** The places that still count in one window of one lane, for the next process. */
export interface HeldPlaces {
  /** The counterpart's name in `api-limits.json`. */
  counterpart: string;
  /** The window in seconds. */
  seconds: number;
  /** The host of a `per: "host"` window, "" for the account. */
  lane: string;
  /** For each place the time it counts from (epoch ms), oldest first. */
  times: number[];
}

/** One window of one lane. */
interface Window {
  counterpart: string;
  seconds: number;
  lane: string;
  max: number;
  places: CallPlace[];
}

/**
 * @param place a place
 * @returns the time it counts from: its answer, else its send
 */
function countsFrom(place: CallPlace): number {
  return place.answeredAt ?? place.sentAt;
}

/**
 * @param w a window
 * @param now the current time (epoch ms)
 * @returns ms until it has room for one more call (0 = now), undefined while only the end of an open call can free one
 */
function waitIn(w: Window, now: number): number | undefined {
  const span = w.seconds * 1000;
  w.places = w.places.filter(p => p.open || countsFrom(p) + span > now);
  if (w.places.length < w.max) {
    return 0;
  }
  const frees = w.places
    .filter(p => !p.open)
    .map(p => countsFrom(p) + span)
    .sort((a, b) => a - b);
  const needed = w.places.length - w.max + 1;
  return frees.length < needed ? undefined : frees[needed - 1] - now;
}

/** The places of every call the instance makes — one budget for all programs. */
export class CallBudget {
  private readonly windows = new Map<string, Window>();
  private readonly restored = new Map<string, number[]>();
  private readonly wakers = new Set<() => void>();

  /**
   * @param counterparts the declaration as the adapter loaded it
   * @param now the clock
   */
  public constructor(
    private readonly counterparts: readonly ApiCounterpart[] = API_COUNTERPARTS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Waits until every window of the counterpart has room for one more call to the host, then hands out its place —
   * in the same synchronous step, so two calls never take the last place both.
   *
   * @param counterpart the counterpart's name in `api-limits.json`
   * @param host the host the call goes to (`URL.hostname`)
   * @param timers the adapter's timers
   * @param signal gives up the wait (the client closes)
   * @returns the call's place
   */
  public async take(counterpart: string, host: string, timers: BudgetTimers, signal: AbortSignal): Promise<CallPlace> {
    const windows = this.windowsOf(counterpart, host);
    for (;;) {
      signal.throwIfAborted();
      const now = this.now();
      const waits = windows.map(w => waitIn(w, now));
      if (waits.every(ms => ms === 0)) {
        const place: CallPlace = { sentAt: now, open: true };
        for (const w of windows) {
          w.places.push(place);
        }
        return place;
      }
      const timed = waits.includes(undefined) ? undefined : Math.max(...(waits as number[]));
      await this.pause(timed, timers, signal);
    }
  }

  /**
   * The call of a place just went out — taken right after the transport call, in the same synchronous step.
   *
   * @param place the place
   */
  public sent(place: CallPlace): void {
    place.sentAt = this.now();
  }

  /**
   * The call of a place is over: answered, it frees a window's length after now; without an answer a window's length
   * after its send. A second settle changes nothing.
   *
   * @param place the place
   * @param answered whether the counterpart answered
   */
  public settle(place: CallPlace, answered: boolean): void {
    if (!place.open) {
      return;
    }
    place.open = false;
    if (answered) {
      place.answeredAt = this.now();
    }
    for (const wake of [...this.wakers]) {
      wake();
    }
  }

  /**
   * For each window the places that still count — a call still on its way counts from now: what the next process
   * takes over.
   *
   * @returns the places per window and lane
   */
  public handOver(): HeldPlaces[] {
    const now = this.now();
    const out: HeldPlaces[] = [];
    // taken over and never used: the window was never asked for in this process
    for (const [key, times] of this.restored) {
      const [counterpart, seconds, lane] = key.split("\u0000");
      out.push({ counterpart, seconds: Number(seconds), lane, times });
    }
    for (const w of this.windows.values()) {
      const times = w.places.map(p => (p.open ? now : countsFrom(p))).sort((a, b) => a - b);
      out.push({ counterpart: w.counterpart, seconds: w.seconds, lane: w.lane, times });
    }
    return out
      .map(h => ({ ...h, times: h.times.filter(t => now - t < h.seconds * 1000) }))
      .filter(h => h.times.length > 0);
  }

  /**
   * Takes over the places a previous process left, before the first call — each counts from its time, like an answered
   * call, once its window is first asked for.
   *
   * @param held the places per window and lane
   */
  public takeOver(held: readonly HeldPlaces[]): void {
    for (const h of held) {
      const key = keyOf(h.counterpart, h.seconds, h.lane);
      this.restored.set(key, [...(this.restored.get(key) ?? []), ...h.times]);
    }
  }

  /**
   * @param counterpart the counterpart's name
   * @param host the call's host
   * @returns its windows for the host — one per window length, the strictest entry of each
   */
  private windowsOf(counterpart: string, host: string): Window[] {
    const declared = this.counterparts.find(c => c.name === counterpart);
    if (!declared) {
      throw new Error(`api-limits.json declares no counterpart '${counterpart}'`);
    }
    const strictest = new Map<string, { seconds: number; lane: string; max: number }>();
    for (const limit of declared.limits) {
      const lane = limit.per === "host" ? host : "";
      const key = keyOf(counterpart, limit.seconds, lane);
      strictest.set(key, {
        seconds: limit.seconds,
        lane,
        max: Math.min(strictest.get(key)?.max ?? Infinity, limit.max),
      });
    }
    return [...strictest].map(([key, { seconds, lane, max }]) => {
      let w = this.windows.get(key);
      if (!w) {
        const places = (this.restored.get(key) ?? []).map(t => ({ sentAt: t, answeredAt: t, open: false }));
        this.restored.delete(key);
        w = { counterpart, seconds, lane, max, places };
        this.windows.set(key, w);
      }
      return w;
    });
  }

  /**
   * @param ms how long at most (undefined: until a call settles)
   * @param timers the adapter's timers
   * @param signal ends the wait too — `take` then throws its reason
   * @returns resolves after `ms`, when a call settles or when the signal aborts
   */
  private pause(ms: number | undefined, timers: BudgetTimers, signal: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      let timer: ioBroker.Timeout | undefined;
      const wake = (): void => {
        timers.clearTimeout(timer);
        this.wakers.delete(wake);
        signal.removeEventListener("abort", wake);
        resolve();
      };
      this.wakers.add(wake);
      signal.addEventListener("abort", wake);
      if (ms !== undefined) {
        timer = timers.setTimeout(wake, ms);
      }
    });
  }
}

/**
 * @param counterpart the counterpart's name
 * @param seconds the window
 * @param lane the host, "" for the account
 * @returns the window's key
 */
function keyOf(counterpart: string, seconds: number, lane: string): string {
  return `${counterpart}\u0000${seconds}\u0000${lane}`;
}

/**
 * @param file the budget file in the instance's data folder
 * @param now the current time (epoch ms)
 * @returns the places the previous process left that still count; none when the file is missing or unreadable
 */
export function readHeldPlaces(file: string, now: number): HeldPlaces[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = data && typeof data === "object" ? (data as { held?: unknown }).held : undefined;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((h: unknown): HeldPlaces[] => {
    const { counterpart, seconds, lane, times } = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
    if (typeof counterpart !== "string" || typeof seconds !== "number" || typeof lane !== "string") {
      return [];
    }
    const kept = (Array.isArray(times) ? times : [])
      .filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t <= now && now - t < seconds * 1000)
      .sort((a, b) => a - b);
    return kept.length ? [{ counterpart, seconds, lane, times: kept }] : [];
  });
}

/**
 * Keeps the places for the next process — synchronous, so it fits the stop.
 *
 * @param file the budget file in the instance's data folder
 * @param held the places per window and lane
 */
export function writeHeldPlaces(file: string, held: readonly HeldPlaces[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ held }));
}
