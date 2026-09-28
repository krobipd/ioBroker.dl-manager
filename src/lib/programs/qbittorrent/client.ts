import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, type HttpResponse, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../registry";

/**
 * qBittorrent WebAPI v2 (api-torrent.md § 1.2): cookie login (the cookie name changes with the version, so it is
 * taken as it comes), or an API key as bearer token from 5.2. A 403 on the login is a banned address; a 403
 * elsewhere is an expired session — one new login, one repeat. Never sends Origin or Referer.
 */
export class QbClient {
  private readonly http: HttpClient;
  private readonly base: string;
  private loggedIn = false;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(
    private readonly cfg: ProgramConfig,
    timers: HttpTimers,
  ) {
    this.http = new HttpClient(timers);
    const path = cfg.path.replace(/\/+$/, "");
    this.base = `${cfg.https ? "https" : "http"}://${cfg.host}:${cfg.port || 8080}${path && !path.startsWith("/") ? `/${path}` : path}/api/v2`;
  }

  /** @returns whether the next call logs in first (a new session — the version is read again) */
  public get needsLogin(): boolean {
    return !this.cfg.apiKey && !this.loggedIn;
  }

  /**
   * @param path below `/api/v2/`, e.g. `sync/maindata?rid=0`
   * @returns the answer
   */
  public get(path: string): Promise<HttpResponse> {
    return this.send("GET", path);
  }

  /**
   * @param path below `/api/v2/`
   * @param form form fields
   * @param multipart send as multipart/form-data (`torrents/add`)
   * @returns the answer
   */
  public post(path: string, form: Record<string, string> = {}, multipart = false): Promise<HttpResponse> {
    return this.send("POST", path, form, multipart);
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    form?: Record<string, string>,
    multipart = false,
  ): Promise<HttpResponse> {
    if (this.needsLogin) {
      await this.login();
    }
    const once = (): Promise<HttpResponse> =>
      this.http.request({
        method,
        url: `${this.base}/${path}`,
        ...(this.cfg.apiKey ? { headers: { authorization: `Bearer ${this.cfg.apiKey}` } } : {}),
        ...(form ? (multipart ? { multipart: form } : { form }) : {}),
      });
    let res = await once();
    if (res.status === 403 || res.status === 401) {
      if (this.cfg.apiKey) {
        throw new AuthError(`qbittorrent: the API key was refused (HTTP ${res.status})`);
      }
      this.loggedIn = false;
      await this.login();
      res = await once();
      if (res.status === 403 || res.status === 401) {
        throw new AuthError(`qbittorrent: access refused after a new login (HTTP ${res.status})`);
      }
    }
    if (res.status >= 400) {
      throw new ProtocolError(
        `qbittorrent: ${path.split("?")[0]} answered HTTP ${res.status} ${res.text.slice(0, 80)}`,
      );
    }
    return res;
  }

  private async login(): Promise<void> {
    this.http.clearCookies();
    const res = await this.http.request({
      method: "POST",
      url: `${this.base}/auth/login`,
      form: { username: this.cfg.username, password: this.cfg.password },
    });
    if (res.status === 403) {
      throw new AuthError("qbittorrent: this address is banned after failed logins — wait or restart qBittorrent");
    }
    if (res.status === 401 || res.text.trim() === "Fails.") {
      throw new AuthError("qbittorrent: login rejected");
    }
    const cookie = res.headers.getSetCookie().length > 0;
    if (res.status >= 300 || (!cookie && res.text.trim() !== "Ok.")) {
      throw new ProtocolError(`qbittorrent: unexpected login answer HTTP ${res.status} ${res.text.slice(0, 80)}`);
    }
    this.loggedIn = true;
  }
}
