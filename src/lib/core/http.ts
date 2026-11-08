import { LOCAL_PROGRAMS } from "../api-limits";
import { errText } from "../err-text";
import type { CallBudget, CallPlace } from "./call-budget";
import { ProtocolError, UnreachableError } from "./errors";
import { asRecord, asText } from "./units";

/** The adapter's timers — the deadline never runs on a bare setTimeout — and the instance's call budget. */
export interface HttpTimers {
  /** The adapter's timer. */
  setTimeout: (cb: () => void, ms: number) => ioBroker.Timeout | undefined;
  /** Clears an adapter timer. */
  clearTimeout: (t: ioBroker.Timeout | undefined) => void;
  /** Every request waits for its place in each window `api-limits.json` declares (`call-budget.ts`); absent: no wait. */
  budget?: CallBudget;
}

/** One request. */
export interface HttpRequest {
  /** HTTP method. */
  method: "GET" | "POST";
  /** Full URL. */
  url: string;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** JSON body. */
  json?: unknown;
  /** Form body (`application/x-www-form-urlencoded`). */
  form?: Record<string, string>;
  /** Multipart form body (`multipart/form-data`, fetch sets the boundary). */
  multipart?: Record<string, string>;
  /** Raw body with its own content type in `headers`. */
  body?: string;
}

/** One answer. The status is the caller's to judge — some programs say "session expired" with 401, some with 403. */
export interface HttpResponse {
  /** HTTP status. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** Body as text. */
  text: string;
  /** Body as JSON; throws `ProtocolError` for anything else. */
  json(): unknown;
}

/**
 * @param text the body of a refused answer
 * @param field the field that names the error, e.g. `type` or `error`
 * @returns the field's text, "" when the body is no JSON object with that text (a proxy's page, an older version)
 */
export function errorField(text: string, field: string): string {
  try {
    return asText(asRecord(JSON.parse(text))[field]);
  } catch {
    return "";
  }
}

/** Client options. */
export interface HttpOptions {
  /** Deadline per request, ms (default 10 s). */
  timeoutMs?: number;
  /** HTTP basic auth on every request. */
  basicAuth?: { user: string; pass: string };
  /**
   * Send once more when fetch reused a kept-alive socket the server had closed (`UND_ERR_SOCKET`) — NZBGet closes
   * the connection after every answer (live-programs runs 36486882766, 36487216805).
   */
  resendOnClosedSocket?: boolean;
  /** The clock for the wait after a 429, `Date.now` when absent. */
  now?: () => number;
  /** The counterpart in `api-limits.json` whose windows hold the requests — the program in the user's network by default. */
  counterpart?: string;
}

/** A 429 without a readable `retry-after` waits this long — a limit counted per minute (pyLoad, `api-limits.json`). */
export const RETRY_AFTER_DEFAULT_MS = 60_000;
/** A `retry-after` longer than the longest poll interval is cut to it — the program is asked again within that time. */
export const RETRY_AFTER_MAX_MS = 60 * 60 * 1000;

/**
 * @param header the `retry-after` of a 429: seconds or an HTTP date (RFC 9110 10.2.3)
 * @param now the time the answer came
 * @returns how long to wait before the next call, ms
 */
export function retryAfterMs(header: string | null, now: number): number {
  const text = header?.trim() ?? "";
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : text ? Date.parse(text) - now : NaN;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, RETRY_AFTER_MAX_MS) : RETRY_AFTER_DEFAULT_MS;
}

/**
 * fetch with a deadline on the adapter's timers, JSON and form bodies, a cookie jar per program and no redirects —
 * a redirect from a download program's API means a login page or a wrong path, never the answer.
 */
export class HttpClient {
  private readonly cookies = new Map<string, string>();
  private readonly inFlight = new Set<AbortController>();
  /** No call before this time — the program answered 429 (fleet suite D21: a 429 is a rate limit, mcm1957). */
  private notBefore = 0;

  /**
   * @param timers the adapter's timers
   * @param opts client options
   */
  public constructor(
    private readonly timers: HttpTimers,
    private readonly opts: HttpOptions = {},
  ) {}

  /** Aborts every request still waiting — at shutdown, so no long poll outlives the adapter. */
  public close(): void {
    for (const a of this.inFlight) {
      a.abort();
    }
    this.inFlight.clear();
  }

  /** Forgets every cookie (before a fresh login). */
  public clearCookies(): void {
    this.cookies.clear();
  }

  /**
   * @param url the request's address
   * @param signal gives up the wait
   * @returns the request's place in the call budget once there is room — none without a budget
   */
  private place(url: string, signal: AbortSignal): Promise<CallPlace | undefined> {
    const budget = this.timers.budget;
    return budget
      ? budget.take(this.opts.counterpart ?? LOCAL_PROGRAMS, new URL(url).hostname, this.timers, signal)
      : Promise.resolve(undefined);
  }

  /**
   * @param place the request's place, none without a budget
   * @param answered whether the program answered
   */
  private settle(place: CallPlace | undefined, answered: boolean): void {
    if (place) {
      this.timers.budget?.settle(place, answered);
    }
  }

  /**
   * @param req the request
   * @returns the answer — any status
   */
  public async request(req: HttpRequest): Promise<HttpResponse> {
    // fetch rejects an unparsable address like a network error — it is the card's host, never a state
    if (!URL.canParse(req.url)) {
      throw new ProtocolError("the address is no valid URL — check the host on the card");
    }
    const now = this.opts.now ?? Date.now;
    const remaining = this.notBefore - now();
    if (remaining > 0) {
      throw new UnreachableError(`rate limited (HTTP 429) — next call in ${Math.ceil(remaining / 1000)} s`);
    }
    const headers: Record<string, string> = { ...req.headers };
    let body: string | FormData | undefined = req.body;
    if (req.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.multipart) {
      const form = new FormData();
      for (const [k, v] of Object.entries(req.multipart)) {
        form.append(k, v);
      }
      body = form;
    } else if (req.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(req.form).toString();
    }
    if (this.opts.basicAuth) {
      const { user, pass } = this.opts.basicAuth;
      headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    }
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const abort = new AbortController();
    this.inFlight.add(abort);
    // the place before the deadline: the wait for room in a declared window is no part of the program's answer
    let place: CallPlace | undefined;
    try {
      place = await this.place(req.url, abort.signal);
    } catch {
      this.inFlight.delete(abort);
      throw new UnreachableError("closed while the request waited for its place");
    }
    const timer = this.timers.setTimeout(() => abort.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      const send = async (taken: CallPlace | undefined): Promise<Response> => {
        try {
          const pending = fetch(req.url, {
            method: req.method,
            headers,
            body,
            redirect: "manual",
            signal: abort.signal,
          });
          // stamped after the transport call, in the same step: never before the network's own stamp of the call
          if (taken) {
            this.timers.budget?.sent(taken);
          }
          const response = await pending;
          this.settle(taken, true);
          return response;
        } catch (err: unknown) {
          // also a fetch that threw at once: the place counts from its hand-out instead of staying open for ever
          this.settle(taken, false);
          throw err;
        }
      };
      try {
        res = await send(place);
      } catch (err: unknown) {
        if (!this.opts.resendOnClosedSocket || !closedSocket(err)) {
          throw err;
        }
        // the second send is a call of its own, with its own place
        res = await send(await this.place(req.url, abort.signal));
      }
      text = await res.text();
    } catch (err: unknown) {
      if (abort.signal.aborted) {
        throw new UnreachableError(`no answer within ${timeoutMs / 1000} s`);
      }
      throw new UnreachableError(errText(err));
    } finally {
      this.timers.clearTimeout(timer);
      this.inFlight.delete(abort);
    }
    if (res.status === 429) {
      // the answer goes to the caller as it came (pyLoad names its limit), the next call waits
      this.notBefore = now() + retryAfterMs(res.headers.get("retry-after"), now());
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ProtocolError(`redirected (${res.status}) — check host, port and path`);
    }
    // a reverse proxy in front of a program that is down answers with these — the program is not reachable, a state
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new UnreachableError(`HTTP ${res.status} ${res.statusText}`.trim());
    }
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    return {
      status: res.status,
      headers: res.headers,
      text,
      json: (): unknown => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new ProtocolError(`answer is not JSON (HTTP ${res.status}): ${text.slice(0, 80)}`);
        }
      },
    };
  }
}

/**
 * @param err what fetch threw
 * @returns whether it failed on a socket the server had already closed
 */
function closedSocket(err: unknown): boolean {
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  return cause?.code === "UND_ERR_SOCKET";
}
