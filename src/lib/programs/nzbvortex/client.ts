import { createHash, randomUUID } from "node:crypto";
import { recordIn } from "../../core/answer";
import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { baseUrl, catalogEntry } from "../catalog";

/**
 * @param nonce the nonce NZBVortex handed out
 * @param cnonce the client's own nonce, fresh for every login
 * @param apiKey the API key
 * @returns Base64 of the SHA-256 bytes of `nonce:cnonce:apikey` (Network API documentation p. 6–7, its test vector p. 7)
 */
export function loginHash(nonce: string, cnonce: string, apiKey: string): string {
  return createHash("sha256").update(`${nonce}:${cnonce}:${apiKey}`, "utf8").digest("base64");
}

/** NZBVortex no longer knows the session: HTTP 403 with `{"result":"not_logged_in"}`. */
class SessionLost extends Error {}

/**
 * NZBVortex's Network API (documentation rev. 1.7, API level 2.3; Sonarr NzbVortexProxy.cs): every call a GET below
 * `/api/` with the answer `{"result": "ok", …}`. A login takes a nonce from `auth/nonce` (valid 30 s) and answers it with
 * the hash of nonce, own nonce and API key at `auth/login` — the key itself never travels. The session it opens goes
 * with every later call as `sessionid` and lapses after five idle minutes; a lapsed one answers HTTP 403
 * `{"result":"not_logged_in"}` (a running NZBVortex, Sonarr forum thread 16517) — the client logs in once more and asks
 * again, as NZBVortex's own web interface and its PHP example do. Error texts never carry the URL: nonce, hash and
 * session stand in its query.
 */
export class NvClient {
  private readonly http: HttpClient;
  private readonly root: string;
  private readonly apiKey: string;
  private session: string | null = null;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    // a default installation speaks HTTPS with a self-signed certificate (documentation p. 6)
    this.http = new HttpClient(timers, { selfSignedTls: true });
    this.root = `${baseUrl(cfg, catalogEntry("nzbvortex"))}/api/`;
    this.apiKey = cfg.apiKey;
  }

  /**
   * @param resource the call below `/api/`, e.g. `nzb` or `nzb/12/pause`
   * @param params its parameters
   * @returns the answer, its `result` "ok"
   */
  public async get(resource: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const fresh = this.session === null;
    const session = this.session ?? (await this.login());
    try {
      return await this.send(resource, params, session);
    } catch (err: unknown) {
      if (!(err instanceof SessionLost)) {
        throw err;
      }
      this.session = null;
      if (fresh) {
        throw refusedAtOnce();
      }
    }
    try {
      return await this.send(resource, params, await this.login());
    } catch (err: unknown) {
      if (err instanceof SessionLost) {
        this.session = null;
        throw refusedAtOnce();
      }
      throw err;
    }
  }

  /** The next call opens a new session — after a failed poll. */
  public reset(): void {
    this.session = null;
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }

  /** @returns a new session id; `loginResult` "failed" is a rejected login (K5), anything else a protocol error */
  private async login(): Promise<string> {
    const nonce = (await this.open("auth/nonce", {})).authNonce;
    if (typeof nonce !== "string" || nonce === "") {
      throw new ProtocolError("NZBVortex's nonce is missing — answer refused");
    }
    const cnonce = randomUUID();
    const answer = await this.open("auth/login", { nonce, cnonce, hash: loginHash(nonce, cnonce, this.apiKey) });
    if (answer.loginResult === "failed") {
      throw new AuthError("nzbvortex: login rejected — check the API key");
    }
    // the key is `sessionID`, the parameter after it `sessionid` (documentation p. 11; Sonarr #1168's trace)
    const id = answer.sessionID;
    if (answer.loginResult !== "successful" || typeof id !== "string" || id === "") {
      throw new ProtocolError("NZBVortex's login answer lost its shape — answer refused");
    }
    this.session = id;
    return id;
  }

  /**
   * @param resource `auth/nonce` or `auth/login` — the calls without a session
   * @param params their parameters
   * @returns the answer (the documentation shows these without `result`)
   */
  private async open(resource: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.http.request({ method: "GET", url: this.url(resource, params) });
    if (res.status !== 200) {
      throw new ProtocolError(`nzbvortex: ${resource} answered HTTP ${res.status}`);
    }
    return recordIn(res.json(), `NZBVortex's answer to ${resource}`);
  }

  /**
   * @param resource the call below `/api/`
   * @param params its parameters
   * @param session the session id
   * @returns the answer, its `result` "ok"
   */
  private async send(
    resource: string,
    params: Record<string, string>,
    session: string,
  ): Promise<Record<string, unknown>> {
    // the session goes last, as Sonarr sends it
    const res = await this.http.request({ method: "GET", url: this.url(resource, { ...params, sessionid: session }) });
    if (res.status === 403) {
      throw new SessionLost();
    }
    if (res.status !== 200) {
      throw new ProtocolError(`nzbvortex: ${resource} answered HTTP ${res.status}`);
    }
    const body = recordIn(res.json(), `NZBVortex's answer to ${resource}`);
    if (body.result === "not_logged_in") {
      throw new SessionLost();
    }
    if (body.result !== "ok") {
      const result = typeof body.result === "string" ? body.result : "no result";
      throw new ProtocolError(`nzbvortex: ${resource} refused (${result})`);
    }
    return body;
  }

  /**
   * @param resource the call below `/api/`
   * @param params its parameters
   * @returns the URL — `+`, `/` and `=` of the Base64 hash percent-encoded (documentation p. 7)
   */
  private url(resource: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params).toString();
    return `${this.root}${resource}${query ? `?${query}` : ""}`;
  }
}

/** @returns the error for a session NZBVortex refuses right after it opened it */
function refusedAtOnce(): ProtocolError {
  return new ProtocolError("nzbvortex: the new session was refused at once (HTTP 403)");
}
