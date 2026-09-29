import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { baseUrl, catalogEntry } from "../catalog";

/**
 * SABnzbd API (api-usenet-aria2-pyload.md § 1): `GET /api?mode=…&apikey=…&output=json`. Every 403 — missing or wrong
 * key, host name check — is a login error; the runner then asks no more, because each failed call writes a warning
 * into SABnzbd.
 */
export class SabClient {
  private readonly http: HttpClient;
  private readonly base: string;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(
    private readonly cfg: ProgramConfig,
    timers: HttpTimers,
  ) {
    this.http = new HttpClient(timers);
    this.base = `${baseUrl(cfg, catalogEntry("sabnzbd"))}/api`;
  }

  /**
   * @param params query parameters besides apikey and output
   * @returns the parsed answer
   */
  public call(params: Record<string, string>): Promise<Record<string, unknown>> {
    return this.send({ ...params, apikey: this.cfg.apiKey });
  }

  /**
   * The calls that need no key (`mode=auth`, `mode=version`) — the quiet connection test.
   *
   * @param params query parameters besides output
   * @returns the parsed answer
   */
  public callWithoutKey(params: Record<string, string>): Promise<Record<string, unknown>> {
    return this.send(params);
  }

  /** @returns the configured API key */
  public get apiKey(): string {
    return this.cfg.apiKey;
  }

  private async send(params: Record<string, string>): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ ...params, output: "json" });
    const res = await this.http.request({ method: "GET", url: `${this.base}?${query.toString()}` });
    if (res.status === 403 || res.status === 401) {
      throw new AuthError(
        `sabnzbd: ${res.text.trim() || `HTTP ${res.status}`} — check the API key (and the host name whitelist)`,
      );
    }
    if (res.status >= 400) {
      throw new ProtocolError(`sabnzbd: mode=${params.mode} answered HTTP ${res.status}`);
    }
    const body = res.json();
    if (!body || typeof body !== "object") {
      throw new ProtocolError(`sabnzbd: mode=${params.mode} answered without an object`);
    }
    const b = body as Record<string, unknown>;
    if (b.status === false) {
      throw new ProtocolError(
        `sabnzbd: mode=${params.mode} failed: ${typeof b.error === "string" ? b.error : "no reason"}`,
      );
    }
    return b;
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }
}
