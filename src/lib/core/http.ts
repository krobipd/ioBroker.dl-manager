import { errText } from "../err-text";
import { ProtocolError, UnreachableError } from "./errors";

/** The adapter's timers — the deadline never runs on a bare setTimeout. */
export interface HttpTimers {
  /** The adapter's timer. */
  setTimeout: (cb: () => void, ms: number) => ioBroker.Timeout | undefined;
  /** Clears an adapter timer. */
  clearTimeout: (t: ioBroker.Timeout | undefined) => void;
}

/** One request. */
export interface HttpRequest {
  /** HTTP method. */
  method: "GET" | "POST" | "PUT" | "DELETE";
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
}

/**
 * fetch with a deadline on the adapter's timers, JSON and form bodies, a cookie jar per program and no redirects —
 * a redirect from a download program's API means a login page or a wrong path, never the answer.
 */
export class HttpClient {
  private readonly cookies = new Map<string, string>();
  private readonly inFlight = new Set<AbortController>();

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
   * @param req the request
   * @returns the answer — any status
   */
  public async request(req: HttpRequest): Promise<HttpResponse> {
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
    const timer = this.timers.setTimeout(() => abort.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      const send = (): Promise<Response> =>
        fetch(req.url, { method: req.method, headers, body, redirect: "manual", signal: abort.signal });
      try {
        res = await send();
      } catch (err: unknown) {
        if (!this.opts.resendOnClosedSocket || !closedSocket(err)) {
          throw err;
        }
        res = await send();
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
    if (res.status >= 300 && res.status < 400) {
      throw new ProtocolError(`redirected (${res.status}) — check host, port and path`);
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
