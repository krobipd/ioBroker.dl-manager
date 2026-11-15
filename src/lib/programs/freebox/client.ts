import { createHmac } from "node:crypto";
import { FREEBOX } from "../../api-limits";
import { recordIn } from "../../core/answer";
import { AuthError, ProtocolError, UnreachableError } from "../../core/errors";
import { HttpClient, type HttpRequest, type HttpResponse, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { asRecord, asText } from "../../core/units";
import { errText } from "../../err-text";
import { baseUrl, catalogEntry, type Endpoint } from "../catalog";
import { FREEBOX_ROOTS } from "./certs";

/** The app id the adapter pairs with — an app token holds only for the app id it was granted to. */
export const APP_ID = "net.iobroker.dl-manager";

/**
 * @param appToken the app token the pairing gave
 * @param challenge the Freebox's current challenge
 * @returns the session password: hex of HMAC-SHA1 over the challenge, keyed with the app token (documentation, login,
 *   "Obtaining a session token")
 */
export function sessionPassword(appToken: string, challenge: string): string {
  return createHmac("sha1", appToken).update(challenge, "utf8").digest("hex");
}

/** What a call sends: JSON (`PUT downloads/{id}`, the config) or a form (`POST downloads/add` takes no JSON). */
export interface FbxBody {
  /** JSON body. */
  json?: unknown;
  /** Form body, `application/x-www-form-urlencoded`. */
  form?: Record<string, string>;
}

/** Where Freebox OS grants an app its rights — its interface is French. */
const ACCESS = "Paramètres de la Freebox › Gestion des accès › Applications";

/** The Freebox no longer knows the session (`auth_required`, `invalid_session`) — its answer may carry the challenge. */
class SessionLost extends Error {
  /** @param challenge the next challenge, from the refusal's `result` */
  public constructor(public readonly challenge: string | null) {
    super("session lost");
  }
}

/**
 * @param code the refusal's `error_code`
 * @param challenge the challenge the refusal carries, if any
 * @param what the call
 * @returns the error to throw — `msg` is French and only names what `error_code` says
 */
function refusal(code: string, challenge: unknown, what: string): Error {
  switch (code) {
    case "auth_required":
    case "invalid_session":
      return new SessionLost(typeof challenge === "string" && challenge !== "" ? challenge : null);
    case "invalid_token":
      return new AuthError("freebox: the app token is no longer valid — pair the card with the Freebox again");
    case "pending_token":
      return new AuthError("freebox: the app token was never confirmed on the Freebox — pair the card again");
    case "insufficient_rights":
      // the session holds the right to the downloads (the login checks it) — one call needs another right (writing the
      // config may need `settings`, no source shows it): that call fails, the polls go on
      return new ProtocolError(`freebox: ${what} needs a right the app lacks — grant it in Freebox OS (${ACCESS})`);
    case "denied_from_external_ip":
      return new AuthError("freebox: the Freebox refuses this app from outside its network");
    case "new_apps_denied":
    case "apps_denied":
      return new AuthError(`freebox: the Freebox lets no app in (${code})`);
    case "ratelimited":
      return new UnreachableError("freebox: too many failed logins from this address — the Freebox waits");
    default:
      return new ProtocolError(`freebox: ${what} refused (${code || "no error code"})`);
  }
}

/** @returns the text for a session without the right to the downloads */
function insufficient(): string {
  return `freebox: the app lacks the right to the downloads — grant it in Freebox OS (${ACCESS}), then save the card again`;
}

/**
 * @param res one answer
 * @param what the call
 * @returns the answer's `result` — undefined when the answer has none (an empty download list is `{"success":true}`)
 */
function resultOf(res: HttpResponse, what: string): unknown {
  let body: Record<string, unknown>;
  try {
    body = recordIn(res.json(), `the Freebox's answer to ${what}`);
  } catch (err: unknown) {
    if (res.status !== 200) {
      throw new ProtocolError(`freebox: ${what} answered HTTP ${res.status}`);
    }
    throw err;
  }
  if (body.success === true) {
    return body.result;
  }
  if (body.success !== false) {
    throw new ProtocolError(`the Freebox's answer to ${what} lost its shape — answer refused`);
  }
  throw refusal(asText(body.error_code), asRecord(body.result).challenge, what);
}

/**
 * @param http the client
 * @param req one request
 * @param host the host of the card
 * @returns the answer; a certificate that does not hold for the host is a settings error with its way out
 */
async function sendTo(http: HttpClient, req: HttpRequest, host: string): Promise<HttpResponse> {
  try {
    return await http.request(req);
  } catch (err: unknown) {
    // node: "Hostname/IP does not match certificate's altnames" — the certificate holds for mafreebox.freebox.fr only
    if (err instanceof UnreachableError && /altnames/i.test(errText(err))) {
      throw new ProtocolError(
        `freebox: the Freebox's certificate does not hold for ${host} — enter mafreebox.freebox.fr as host, or switch HTTPS off`,
      );
    }
    throw err;
  }
}

/**
 * @param timers the adapter's timers
 * @returns a client for the Freebox: Free's roots trusted beside node's own, the calls held by the Freebox's window
 */
function httpFor(timers: HttpTimers): HttpClient {
  return new HttpClient(timers, { trustedCa: FREEBOX_ROOTS, counterpart: FREEBOX });
}

/**
 * The Freebox OS API (documentation 4.0, the same objects up to 16.0; Sonarr FreeboxDownloadProxy.cs): every answer is
 * `{"success": true, "result": …}` or `{"success": false, "error_code": …, "msg": …}`. A session comes from the app
 * token the pairing gave: `GET login/` hands out a challenge, `POST login/session/` answers it with HMAC-SHA1 of the
 * challenge keyed with the token — the token itself never travels after the pairing — and every later call carries
 * the session in `X-Fbx-App-Auth`. A lapsed session answers HTTP 403 `auth_required` with the next challenge in its
 * `result` (a running Freebox, Radarr #11651 and #9938): the client opens a new session with it and asks once more.
 */
export class FbxClient {
  private readonly http: HttpClient;
  private readonly root: string;
  private readonly host: string;
  private readonly appToken: string;
  private session: string | null = null;

  /**
   * @param cfg the settings row — the app token in `apiKey`
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    this.http = httpFor(timers);
    this.root = `${baseUrl(cfg, catalogEntry("freebox"))}/`;
    this.host = cfg.host;
    this.appToken = cfg.apiKey;
  }

  /**
   * @returns the answer of `GET /api_version` — below the API's own path, no session, no envelope (documentation,
   *   index "API version")
   */
  public async apiVersion(): Promise<Record<string, unknown>> {
    const what = "api_version";
    const res = await sendTo(this.http, { method: "GET", url: versionUrl(this.root) }, this.host);
    if (res.status !== 200) {
      throw new ProtocolError(`freebox: ${what} answered HTTP ${res.status}`);
    }
    return recordIn(res.json(), `the Freebox's answer to ${what}`);
  }

  /**
   * @param method HTTP method
   * @param resource the call below the API's path, e.g. `downloads/` or `downloads/12`
   * @param body what it sends
   * @returns the answer's `result`, undefined when it has none
   */
  public async call(method: HttpRequest["method"], resource: string, body: FbxBody = {}): Promise<unknown> {
    const fresh = this.session === null;
    let challenge: string | null = null;
    const session = this.session ?? (await this.login(null));
    try {
      return await this.send(method, resource, body, session);
    } catch (err: unknown) {
      if (!(err instanceof SessionLost)) {
        throw err;
      }
      this.session = null;
      if (fresh) {
        throw refusedAtOnce();
      }
      challenge = err.challenge;
    }
    try {
      return await this.send(method, resource, body, await this.login(challenge));
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

  /**
   * @param challenge the challenge a refusal handed over, null = ask `GET login/`
   * @returns a new session token; a session without the right to the downloads is refused like a rejected login
   */
  private async login(challenge: string | null): Promise<string> {
    const current = challenge ?? challengeOf(await this.open("GET", "login/"));
    const result = recordIn(
      await this.open("POST", "login/session/", {
        json: { app_id: APP_ID, password: sessionPassword(this.appToken, current) },
      }),
      "the Freebox's session",
    );
    const token = result.session_token;
    if (typeof token !== "string" || token === "") {
      throw new ProtocolError("the Freebox's session token is missing — answer refused");
    }
    // the rights of the app (documentation, login: "permissions"); without `downloader` every download call is refused
    if (asRecord(result.permissions).downloader === false) {
      throw new AuthError(insufficient());
    }
    this.session = token;
    return token;
  }

  /**
   * @param method HTTP method
   * @param resource `login/` or `login/session/` — the calls without a session
   * @param body what it sends
   * @returns the answer's `result`
   */
  private async open(method: HttpRequest["method"], resource: string, body: FbxBody = {}): Promise<unknown> {
    try {
      return resultOf(await sendTo(this.http, this.request(method, resource, body), this.host), resource);
    } catch (err: unknown) {
      if (err instanceof SessionLost) {
        throw new ProtocolError(`freebox: ${resource} asked for a session`);
      }
      throw err;
    }
  }

  /**
   * @param method HTTP method
   * @param resource the call below the API's path
   * @param body what it sends
   * @param session the session token
   * @returns the answer's `result`
   */
  private async send(
    method: HttpRequest["method"],
    resource: string,
    body: FbxBody,
    session: string,
  ): Promise<unknown> {
    const req = this.request(method, resource, body);
    req.headers = { "X-Fbx-App-Auth": session };
    return resultOf(await sendTo(this.http, req, this.host), resource);
  }

  /**
   * @param method HTTP method
   * @param resource the call below the API's path
   * @param body what it sends
   * @returns the request
   */
  private request(method: HttpRequest["method"], resource: string, body: FbxBody): HttpRequest {
    return { method, url: `${this.root}${resource}`, json: body.json, form: body.form };
  }
}

/**
 * @param root the API's base with its trailing `/`, e.g. `https://mafreebox.freebox.fr:443/api/v8/`
 * @returns the URL of `api_version`, which sits beside `api/` (`/api_version` on a box, `<prefix>/api_version` behind a
 *   proxy's path)
 */
export function versionUrl(root: string): string {
  return `${root.replace(/api\/v\d+\/$/, "")}api_version`;
}

/**
 * @param result the answer of `GET login/`
 * @returns its challenge
 */
function challengeOf(result: unknown): string {
  const challenge = recordIn(result, "the Freebox's login answer").challenge;
  if (typeof challenge !== "string" || challenge === "") {
    throw new ProtocolError("the Freebox's challenge is missing — answer refused");
  }
  return challenge;
}

/** @returns the error for a session the Freebox refuses right after it opened it */
function refusedAtOnce(): ProtocolError {
  return new ProtocolError("freebox: the new session was refused at once (HTTP 403)");
}

/** How the pairing ended without a token. */
export type PairRefusal = "denied" | "timeout" | "unknown";

/** What a pairing gives: the app token, or why the Freebox gave none. */
export type PairOutcome = { token: string } | { refused: PairRefusal };

/** Who asks — the Freebox shows it on its display and in its list of apps. */
export interface PairingApp {
  /** The app's name. */
  name: string;
  /** The app's version. */
  version: string;
  /** The device the app runs on. */
  device: string;
}

/** How often the pairing asks the Freebox, and for how long. */
export interface PairingPace {
  /** Pause between two questions, ms. */
  everyMs: number;
  /** The longest wait for the user's answer at the Freebox, ms. */
  maxMs: number;
}

/** The pace of a pairing: every 2 s for up to 5 minutes — the Freebox ends a request it waits on itself (`timeout`). */
export const PAIRING_PACE: PairingPace = { everyMs: 2000, maxMs: 5 * 60 * 1000 };

/**
 * The pairing (documentation, login, "Obtaining an app_token"): `POST login/authorize/` asks the Freebox for an app
 * token, the user grants it with the arrow keys on the Freebox's own display, and `GET login/authorize/{track_id}`
 * tells when: `pending` until he did, then `granted` or `denied`, `timeout` when he did not in time, `unknown` for a
 * request the Freebox no longer knows. Only from the Freebox's own network.
 *
 * @param cfg the card's address
 * @param timers the adapter's timers — a timer the adapter refuses (it stops) ends the wait
 * @param app who asks
 * @param pace how often and how long
 * @returns the app token once granted, else why not
 */
export async function pairFreebox(
  cfg: Endpoint,
  timers: HttpTimers,
  app: PairingApp,
  pace: PairingPace = PAIRING_PACE,
): Promise<PairOutcome> {
  const http = httpFor(timers);
  const root = `${baseUrl(cfg, catalogEntry("freebox"))}/`;
  const ask = async (req: HttpRequest, what: string): Promise<Record<string, unknown>> =>
    recordIn(resultOf(await sendTo(http, req, cfg.host), what), `the Freebox's answer to ${what}`);
  try {
    const granted = await ask(
      {
        method: "POST",
        url: `${root}login/authorize/`,
        json: { app_id: APP_ID, app_name: app.name, app_version: app.version, device_name: app.device },
      },
      "login/authorize/",
    );
    const token = granted.app_token;
    const track = granted.track_id;
    if (typeof token !== "string" || token === "" || typeof track !== "number" || !Number.isInteger(track)) {
      throw new ProtocolError("the Freebox's answer to the pairing lost its shape — answer refused");
    }
    for (let waited = 0; ; waited += pace.everyMs) {
      const status = asText(
        (await ask({ method: "GET", url: `${root}login/authorize/${track}` }, "login/authorize")).status,
      );
      if (status === "granted") {
        return { token };
      }
      if (status === "denied" || status === "timeout" || status === "unknown") {
        return { refused: status };
      }
      if (status !== "pending") {
        throw new ProtocolError(`the Freebox's pairing answered "${status}"`);
      }
      if (waited >= pace.maxMs) {
        return { refused: "timeout" };
      }
      if (!(await pause(timers, pace.everyMs))) {
        throw new UnreachableError("the adapter stopped while the Freebox waited for its confirmation");
      }
    }
  } finally {
    http.close();
  }
}

/**
 * @param timers the adapter's timers
 * @param ms how long
 * @returns true after the pause, false at once when the adapter refuses a timer (it stops)
 */
function pause(timers: HttpTimers, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    if (timers.setTimeout(() => resolve(true), ms) === undefined) {
      resolve(false);
    }
  });
}
