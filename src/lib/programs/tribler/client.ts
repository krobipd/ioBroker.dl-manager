import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, type HttpRequest, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { asRecord, asText } from "../../core/units";
import { baseUrl, catalogEntry } from "../catalog";

/**
 * @param text an answer's body
 * @returns Tribler's reason — a refusal answers `{"error": {"handled": true, "message": "…"}}` (downloads_endpoint.py;
 *   the key check of rest_manager.py the same, recording `auth/downloads-wrong-key`), a plain text is taken as it is
 */
export function reasonOf(text: string): string {
  try {
    const error = asRecord(JSON.parse(text)).error;
    return typeof error === "string" ? error : asText(asRecord(error).message);
  } catch {
    return "";
  }
}

/**
 * Tribler's REST API (src/tribler/core/restapi): JSON over GET, PUT, PATCH, DELETE and POST, the API key in the header
 * `X-Api-Key` on every request (rest_manager.py `ApiKeyMiddleware`, which also takes `?key=` and the cookie `api_key`).
 */
export class TblClient {
  private readonly http: HttpClient;
  private readonly base: string;
  private readonly headers: Record<string, string>;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    this.http = new HttpClient(timers);
    this.base = baseUrl(cfg, catalogEntry("tribler"));
    this.headers = { "x-api-key": cfg.apiKey };
  }

  /**
   * @param method the method
   * @param path below the base (`/api/downloads`)
   * @param json a JSON body
   * @returns the answer's JSON
   */
  public async send(method: HttpRequest["method"], path: string, json?: unknown): Promise<unknown> {
    const res = await this.http.request({
      method,
      url: `${this.base}${path}`,
      headers: this.headers,
      ...(json === undefined ? {} : { json }),
    });
    if (res.status === 401) {
      throw new AuthError(`tribler: the API key was refused (${reasonOf(res.text) || "HTTP 401"})`);
    }
    if (res.status >= 400) {
      const why = reasonOf(res.text);
      throw new ProtocolError(`tribler: ${method} ${path} answered HTTP ${res.status}${why ? ` (${why})` : ""}`);
    }
    return res.json();
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }
}
