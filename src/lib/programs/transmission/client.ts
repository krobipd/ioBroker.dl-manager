import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, type HttpResponse, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { snakeKeys } from "./map";
import { baseUrl, catalogEntry } from "../catalog";

/** Legacy (≤ 4.0) method names. */
const LEGACY: Readonly<Record<string, string>> = {
  torrent_get: "torrent-get",
  torrent_add: "torrent-add",
  torrent_start: "torrent-start",
  torrent_stop: "torrent-stop",
  torrent_remove: "torrent-remove",
  torrent_verify: "torrent-verify",
  session_get: "session-get",
  session_set: "session-set",
  session_stats: "session-stats",
  free_space: "free-space",
};

const camel = (s: string): string => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

/** The programs that speak Transmission's RPC. */
export type TrType = "transmission" | "vuze";

/**
 * Vuze's first session-get waits for Vuze's version server (XMWebUIPlugin.java 2820, again after 864 s): 89.9 s in a
 * network without it (live-programs run 43680925710) — every other answer came within 50 ms.
 */
const VUZE_TIMEOUT_MS = 120_000;

/**
 * Transmission RPC (api-torrent.md § 2): basic auth per request, the 409 round for the session id (repeated once),
 * JSON-RPC 2.0 with snake_case from 4.1 (`X-Transmission-Rpc-Version` ≥ 6), the legacy protocol before. Vuze's Web
 * Remote plugin speaks the legacy protocol (RPC 15, no version header) under Transmission's path.
 */
export class TrClient {
  private readonly http: HttpClient;
  private readonly url: string;
  private readonly type: TrType;
  private sessionId = "";
  private modern: boolean | null = null;
  private seq = 0;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    this.type = cfg.type === "vuze" ? "vuze" : "transmission";
    this.http = new HttpClient(timers, {
      ...(cfg.username ? { basicAuth: { user: cfg.username, pass: cfg.password } } : {}),
      ...(this.type === "vuze" ? { timeoutMs: VUZE_TIMEOUT_MS } : {}),
    });
    this.url = baseUrl(cfg, catalogEntry(this.type));
  }

  /**
   * One call; the answer's payload with snake_case keys.
   *
   * @param method snake_case method name
   * @param params snake_case params
   * @returns the payload (`result` resp. legacy `arguments`)
   */
  public async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.modern === null) {
      await this.handshake();
    }
    const send = (): Promise<HttpResponse> =>
      this.http.request({
        method: "POST",
        url: this.url,
        headers: { "x-transmission-session-id": this.sessionId },
        json: this.modern
          ? { jsonrpc: "2.0", method, params, id: ++this.seq }
          : { method: LEGACY[method] ?? method, arguments: this.legacyParams(params), tag: ++this.seq },
      });
    let res = await send();
    if (res.status === 409) {
      this.adopt(res.headers);
      res = await send();
    }
    this.check(res.status);
    const body = res.json() as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      throw new ProtocolError(`${this.type}: ${method} answered without a body`);
    }
    if (this.modern) {
      if (body.error) {
        const e = body.error as { message?: unknown };
        throw new ProtocolError(`${this.type}: ${method} failed: ${String(e.message)}`);
      }
      return snakeKeys(body.result ?? {}) as Record<string, unknown>;
    }
    if (body.result !== "success") {
      throw new ProtocolError(`${this.type}: ${method} failed: ${String(body.result)}`);
    }
    return snakeKeys(body.arguments ?? {}) as Record<string, unknown>;
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }

  private async handshake(): Promise<void> {
    const res = await this.http.request({ method: "POST", url: this.url, json: { method: "session-get", tag: 0 } });
    this.check(res.status === 409 || res.status === 200 ? 200 : res.status);
    this.adopt(res.headers);
  }

  private adopt(headers: Headers): void {
    this.sessionId = headers.get("x-transmission-session-id") ?? this.sessionId;
    const semver = headers.get("x-transmission-rpc-version");
    this.modern = semver !== null && Number(semver.split(".")[0]) >= 6;
  }

  private check(status: number): void {
    if (status === 401) {
      throw new AuthError(`${this.type}: login rejected`);
    }
    // WebPlugin.java 2546–2593: an address outside the plugin's Access setting gets 403 and a text, no login is asked
    if (status === 403 && this.type === "vuze") {
      throw new AuthError(
        "vuze: the Web Remote plugin does not serve this address — set its Access to all or add the address",
      );
    }
    if (status === 403) {
      throw new AuthError(
        "transmission: this address is not in Transmission's rpc-whitelist (or it is locked after failed logins)",
      );
    }
    if (status === 421) {
      throw new ProtocolError(
        "transmission: host name not allowed — use the IP address or add it to rpc-host-whitelist",
      );
    }
    if (status >= 400) {
      throw new ProtocolError(`${this.type}: HTTP ${status}`);
    }
  }

  private legacyParams(params: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(params).map(([k, v]) =>
        k === "fields" && Array.isArray(v) ? [k, v.map(f => camel(String(f)))] : [k.replace(/_/g, "-"), v],
      ),
    );
  }
}
