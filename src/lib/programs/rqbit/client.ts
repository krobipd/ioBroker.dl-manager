import { AuthError, ProtocolError } from "../../core/errors";
import { errorField, HttpClient, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { baseUrl, catalogEntry } from "../catalog";

/**
 * How long rqbit waits in `POST /torrents` for a magnet's metadata or a `.torrent` link: 600 s unless the call names
 * `timeout_ms` (`Timeout<600_000, 3_600_000>` in handlers/torrents.rs, http_api/timeout.rs, 8.1.1 and 9.1.0). The
 * adapter names 100 s and waits ten seconds longer, so rqbit's own answer comes first and the call ends with room
 * before the 120 s in which the fleet suite D21 wants every call to a hung counterpart ended.
 */
const RQBIT_ADD_TIMEOUT_MS = 100_000;
const ADD_TIMEOUT_MS = RQBIT_ADD_TIMEOUT_MS + 10_000;

/** A JSON body (`POST /torrents/limits`). */
type JsonBody = { json: unknown };

/**
 * rqbit HTTP API (crates/librqbit/src/http_api/handlers/mod.rs): plain JSON over GET and POST, HTTP basic auth only when
 * the program runs with `RQBIT_HTTP_BASIC_AUTH_USERPASS`. An error answers with a JSON body whose `human_readable`
 * names the cause (`api_error.rs`).
 */
export class RqClient {
  private readonly http: HttpClient;
  private readonly addHttp: HttpClient;
  private readonly base: string;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    const auth = cfg.username ? { basicAuth: { user: cfg.username, pass: cfg.password } } : {};
    this.http = new HttpClient(timers, auth);
    this.addHttp = new HttpClient(timers, { ...auth, timeoutMs: ADD_TIMEOUT_MS });
    this.base = baseUrl(cfg, catalogEntry("rqbit"));
  }

  /**
   * @param path below the base, with its query (`/torrents?with_stats=true`)
   * @returns the answer's JSON
   */
  public get(path: string): Promise<unknown> {
    return this.send("GET", path);
  }

  /**
   * A route not every version serves: `GET /torrents/limits` came with 9.0 — 8.x answers 405.
   *
   * @param path below the base
   * @returns the answer's JSON, undefined when the program does not serve the route
   */
  public getIfServed(path: string): Promise<unknown> {
    return this.send("GET", path, undefined, true);
  }

  /**
   * @param path below the base
   * @param body a JSON body
   * @returns the answer's JSON
   */
  public post(path: string, body?: JsonBody): Promise<unknown> {
    return this.send("POST", path, body);
  }

  /**
   * `POST /torrents` with a magnet or a `.torrent` link as the body — rqbit answers once it has the metadata, or with its
   * timeout error after `RQBIT_ADD_TIMEOUT_MS`.
   *
   * @param link the link
   * @returns the answer's JSON
   */
  public add(link: string): Promise<unknown> {
    return this.send(
      "POST",
      `/torrents?overwrite=true&timeout_ms=${RQBIT_ADD_TIMEOUT_MS}`,
      { text: link },
      false,
      this.addHttp,
    );
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
    this.addHttp.close();
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body?: JsonBody | { text: string },
    optional = false,
    http = this.http,
  ): Promise<unknown> {
    const res = await http.request({
      method,
      url: `${this.base}${path}`,
      ...(body && "json" in body ? { json: body.json } : {}),
      ...(body && "text" in body ? { body: body.text, headers: { "content-type": "text/plain" } } : {}),
    });
    if (res.status === 401) {
      throw new AuthError("rqbit: login rejected (RQBIT_HTTP_BASIC_AUTH_USERPASS)");
    }
    if (optional && (res.status === 404 || res.status === 405)) {
      return undefined;
    }
    if (res.status >= 400) {
      const why = errorField(res.text, "human_readable");
      throw new ProtocolError(`rqbit: ${path.split("?")[0]} answered HTTP ${res.status}${why ? ` (${why})` : ""}`);
    }
    return res.json();
  }
}
