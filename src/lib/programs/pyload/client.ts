import { AuthError, ProtocolError, UnreachableError } from "../../core/errors";
import { HttpClient, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { baseUrl, catalogEntry } from "../catalog";

/**
 * pyLoad-ng REST API (api-usenet-aria2-pyload.md § 4): `/api/<function>`, reads GET, changes POST with a JSON body.
 * From 0.5.0b3.dev97 only an API key (`X-API-Key`) opens it; older builds take basic auth — the filled-in field
 * decides. 429 is pyLoad's limit of 100 calls a minute: a passing state, not a login error.
 */
export class PyClient {
  private readonly http: HttpClient;
  private readonly base: string;
  private readonly headers: Record<string, string>;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    this.http = new HttpClient(
      timers,
      !cfg.apiKey && cfg.username ? { basicAuth: { user: cfg.username, pass: cfg.password } } : {},
    );
    this.headers = cfg.apiKey ? { "x-api-key": cfg.apiKey } : {};
    this.base = `${baseUrl(cfg, catalogEntry("pyload"))}/api`;
  }

  /**
   * @param fn API function, e.g. `status_server`
   * @param query query parameters
   * @returns the parsed answer
   */
  public get(fn: string, query: Record<string, string> = {}): Promise<unknown> {
    const q = new URLSearchParams(query).toString();
    return this.send("GET", `${fn}${q ? `?${q}` : ""}`);
  }

  /**
   * @param fn API function, e.g. `pause_server`
   * @param body keyword arguments
   * @returns the parsed answer
   */
  public post(fn: string, body: Record<string, unknown> = {}): Promise<unknown> {
    return this.send("POST", fn, body);
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }

  private async send(method: "GET" | "POST", path: string, json?: Record<string, unknown>): Promise<unknown> {
    const res = await this.http.request({
      method,
      url: `${this.base}/${path}`,
      headers: this.headers,
      ...(json ? { json } : {}),
    });
    if (res.status === 401 || res.status === 403) {
      let err: unknown;
      try {
        err = (res.json() as { error?: unknown } | null)?.error;
      } catch {
        err = undefined; // a proxy or an older pyLoad answers plain text
      }
      throw new AuthError(`pyload: ${typeof err === "string" ? err : `HTTP ${res.status}`} — check the API key`);
    }
    if (res.status === 429) {
      throw new UnreachableError("pyload: too many requests (pyLoad allows 100 a minute) — raise the poll interval");
    }
    if (res.status >= 400) {
      throw new ProtocolError(`pyload: ${path.split("?")[0]} answered HTTP ${res.status}`);
    }
    return res.json();
  }
}
