import { recordIn } from "../../core/answer";
import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, errorField, type HttpRequest, type HttpResponse, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { asText } from "../../core/units";
import { baseUrl, catalogEntry } from "../catalog";

/**
 * Flood's API below `<address>/api` (server/routes/api): JSON, the session in the cookie `jwt` that
 * `POST /api/auth/authenticate` sets (auth.ts `sendAuthenticationResponse`). A 401 on any other route is an expired or
 * unknown session — one new login, one repeat. Flood started with `--auth none` takes any name and password
 * (auth.ts: the config user), so both stay optional.
 */
export class FloodClient {
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
    this.base = `${baseUrl(cfg, catalogEntry("flood"))}/api`;
  }

  /**
   * @param method the method
   * @param path below `/api` (`/torrents`)
   * @param json a JSON body
   * @returns the answer's JSON, undefined for an empty answer (start, stop, delete)
   */
  public async send(method: HttpRequest["method"], path: string, json?: unknown): Promise<unknown> {
    return this.parse(method, path, await this.authed(method, path, json));
  }

  /**
   * Flood names its version only in its OpenAPI document, which 4.12 brought (4.11 answers 404, recording
   * 4.11.0-rtorrent `auth/openapi`).
   *
   * @returns the version, null where Flood has no document
   */
  public async version(): Promise<string | null> {
    const res = await this.authed("GET", "/openapi.json");
    if (res.status === 404) {
      return null;
    }
    const doc = recordIn(this.parse("GET", "/openapi.json", res), "Flood's OpenAPI document");
    return asText(recordIn(doc.info, "the info of Flood's OpenAPI document").version);
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }

  /**
   * @param method the method
   * @param path below `/api`
   * @param json a JSON body
   * @returns the answer, after one new login when the session was refused
   */
  private async authed(method: HttpRequest["method"], path: string, json?: unknown): Promise<HttpResponse> {
    if (!this.loggedIn) {
      await this.login();
    }
    const once = (): Promise<HttpResponse> =>
      this.http.request({ method, url: `${this.base}${path}`, ...(json === undefined ? {} : { json }) });
    let res = await once();
    if (res.status === 401) {
      this.loggedIn = false;
      await this.login();
      res = await once();
      if (res.status === 401) {
        throw new AuthError("flood: access refused after a new login (HTTP 401)");
      }
    }
    return res;
  }

  /**
   * @param method the method, for the error text
   * @param path the path, for the error text
   * @param res the answer
   * @returns its JSON, undefined when it is empty
   */
  private parse(method: string, path: string, res: HttpResponse): unknown {
    if (res.status >= 400) {
      const why = errorField(res.text, "message");
      throw new ProtocolError(`flood: ${method} ${path} answered HTTP ${res.status}${why ? ` (${why})` : ""}`);
    }
    return res.text.trim() ? res.json() : undefined;
  }

  private async login(): Promise<void> {
    this.http.clearCookies();
    const res = await this.http.request({
      method: "POST",
      url: `${this.base}/auth/authenticate`,
      json: { username: this.cfg.username, password: this.cfg.password },
    });
    if (res.status === 401 || res.status === 400) {
      const why = errorField(res.text, "message");
      throw new AuthError(`flood: login rejected${why ? ` (${why})` : ""}`);
    }
    if (res.status >= 300 || !res.headers.getSetCookie().some(c => c.startsWith("jwt="))) {
      throw new ProtocolError(`flood: unexpected login answer HTTP ${res.status} ${res.text.slice(0, 80)}`);
    }
    this.loggedIn = true;
  }
}
