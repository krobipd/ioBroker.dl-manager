import { recordIn } from "../../core/answer";
import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, type HttpResponse, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { baseUrl, catalogEntry } from "../catalog";

/**
 * The token in `token.html`, read as µTorrent's own Web UI reads it (webui.js `requestToken`: the first text between
 * `>` and `<` of `<html><div id='token' style='display:none;'>…</div></html>`).
 */
const TOKEN = />([^<]+)</;

/**
 * µTorrent's Web UI API under `/gui/` (Sonarr's UTorrentProxy.cs, recorded on µTorrent Server 3.3 build 30470): basic
 * auth on every request, a token from `token.html` in the query of every call and the `GUID` cookie of that token
 * request. A call with a token µTorrent no longer knows — or without the cookie it belongs to — gets 400 "invalid
 * request" (recordings `auth/bad-token`, `auth/no-cookie`); one new token, one repeat. 401 is a refused login.
 */
export class UtClient {
  private readonly http: HttpClient;
  private readonly base: string;
  private token: string | null = null;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    this.http = new HttpClient(timers, cfg.username ? { basicAuth: { user: cfg.username, pass: cfg.password } } : {});
    this.base = baseUrl(cfg, catalogEntry("utorrent"));
  }

  /**
   * @param query the query after the token, e.g. `list=1` or `action=stop&hash=…`
   * @returns the answer's object (every one carries `build`)
   */
  public async call(query: string): Promise<Record<string, unknown>> {
    const answer = await this.tryCall(query);
    if (!answer) {
      throw new ProtocolError(`utorrent: ${query.split("&")[0]} answered HTTP 400 invalid request with a new token`);
    }
    return answer;
  }

  /**
   * @param query the query after the token
   * @returns the answer's object, null when µTorrent refuses it with a token just fetched — an action this build does
   *   not know answers 400 "invalid request" like a stale token (recording `probe/unknown-action`)
   */
  public async tryCall(query: string): Promise<Record<string, unknown> | null> {
    if (!this.token) {
      await this.login();
    }
    let res = await this.send(query);
    if (res.status === 400) {
      await this.login();
      res = await this.send(query);
    }
    if (res.status === 400) {
      return null;
    }
    if (res.status === 401) {
      this.token = null;
      throw new AuthError("utorrent: login rejected");
    }
    const what = query.split("&")[0];
    if (res.status >= 300) {
      throw new ProtocolError(`utorrent: ${what} answered HTTP ${res.status} ${res.text.trim().slice(0, 80)}`);
    }
    let body: unknown;
    try {
      body = res.json();
    } catch {
      throw new ProtocolError(`utorrent: ${what} answered no JSON`);
    }
    return recordIn(body, `µTorrent's answer to ${what}`);
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }

  /**
   * @param query the query after the token
   * @returns the raw answer
   */
  private send(query: string): Promise<HttpResponse> {
    return this.http.request({
      method: "GET",
      url: `${this.base}/?token=${encodeURIComponent(this.token ?? "")}&${query}`,
    });
  }

  private async login(): Promise<void> {
    this.token = null;
    this.http.clearCookies();
    const res = await this.http.request({ method: "GET", url: `${this.base}/token.html` });
    if (res.status === 401) {
      throw new AuthError("utorrent: login rejected");
    }
    const token = res.status < 300 ? TOKEN.exec(res.text)?.[1] : undefined;
    if (!token) {
      throw new ProtocolError(`utorrent: token.html answered HTTP ${res.status} without a token`);
    }
    this.token = token;
  }
}
