import { recordIn } from "../../core/answer";
import { AuthError, ProtocolError, UnreachableError } from "../../core/errors";
import { HttpClient, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { baseUrl, catalogEntry } from "../catalog";

/** The APIs the driver calls — all of them CGIs of their own that read plain form fields (none takes JSON). */
export type DsApi = "SYNO.API.Auth" | "SYNO.DownloadStation.Info" | "SYNO.DownloadStation.Task";

const APIS: readonly DsApi[] = ["SYNO.API.Auth", "SYNO.DownloadStation.Info", "SYNO.DownloadStation.Task"];

/**
 * Codes after which the session is gone (Sonarr DiskStationError.cs `SessionError`: 105, 106, 107, 119). A CGI answers
 * a session it does not know with 105 as well, so 105 is a lost session first and a missing permission only when it
 * comes again on a fresh one.
 */
const SESSION_CODES: ReadonlySet<number> = new Set([105, 106, 107, 119]);

/** Login codes (DSM Login Web API Guide, error table; 405 and 411 py-synologydsm const.py) — each one an explicit no. */
const LOGIN_REFUSED: Readonly<Record<number, string>> = {
  400: "no such account or wrong password",
  401: "account disabled",
  402: "permission denied",
  403: "the account asks for a two-step verification code — the adapter cannot enter one",
  404: "two-step verification code wrong",
  405: "app portal incorrect",
  406: "two-step verification is enforced for the account",
  407: "this address is blocked after failed logins",
  408: "password expired and cannot be changed",
  409: "password expired",
  410: "password must be changed",
  411: "account locked",
};

/** Where an API lives and the highest version it takes, from `SYNO.API.Info`. */
interface ApiInfo {
  /** The CGI below `/webapi/`, e.g. `DownloadStation/task.cgi`. */
  path: string;
  /** Highest version. */
  maxVersion: number;
}

/** A refusal in DSM's envelope. */
class DsRefusal extends Error {
  /**
   * @param code the envelope's error code
   * @param what the call, for the error text
   */
  public constructor(
    public readonly code: number,
    public readonly what: string,
  ) {
    super(`downloadstation: ${what} refused — error ${code}`);
  }
}

/**
 * @param body a parsed answer
 * @param what the call, for the error text
 * @returns the answer's `data` (undefined when a command answers success alone)
 */
function dataOf(body: unknown, what: string): unknown {
  const env = recordIn(body, `Download Station's answer to ${what}`);
  if (env.success === true) {
    return env.data;
  }
  if (env.success === false) {
    // every DSM 7 answer carries {code}, the Download Station API guide of 2014 shows the bare number
    const error = env.error;
    const code = typeof error === "number" ? error : (error as { code?: unknown } | null)?.code;
    if (typeof code === "number" && Number.isInteger(code)) {
      throw new DsRefusal(code, what);
    }
  }
  throw new ProtocolError(`Download Station's answer to ${what} lost its shape — answer refused`);
}

/**
 * Synology's Web API (Sonarr DiskStationProxyBase.cs; Download Station Web API guide; cmeans/mcp-synology, measured on
 * DSM 7.1 and 7.2.2): `query.cgi` names each API's CGI and versions, `SYNO.API.Auth login` with `session=DownloadStation`
 * and `format=sid` opens a session, every later call carries it as `_sid`. Every call with a session or the password
 * goes as a form POST, so neither stands in a URL; the v1 CGIs read the plain `_sid` (a JSON API would read a sid that
 * looks like a number as a number, cmeans client.py — the driver calls none). A refusal comes with HTTP 200 and
 * `{"success": false, "error": {"code": N}}`.
 */
export class DsClient {
  private readonly http: HttpClient;
  private readonly root: string;
  private readonly user: string;
  private readonly pass: string;
  private apis: Map<DsApi, ApiInfo> | null = null;
  private sid: string | null = null;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    this.http = new HttpClient(timers);
    this.root = `${baseUrl(cfg, catalogEntry("downloadstation"))}/webapi/`;
    this.user = cfg.username;
    this.pass = cfg.password;
  }

  /**
   * @param api the API
   * @param method its method
   * @param params the method's parameters
   * @returns the answer's `data`
   */
  public async call(api: DsApi, method: string, params: Record<string, string> = {}): Promise<unknown> {
    const what = `${api} ${method}`;
    const fresh = this.sid === null;
    const sid = this.sid ?? (await this.login());
    try {
      return await this.send(api, { method, version: "1", ...params, _sid: sid }, what);
    } catch (err: unknown) {
      if (!(err instanceof DsRefusal) || !SESSION_CODES.has(err.code)) {
        throw refused(err);
      }
      this.sid = null;
      if (fresh) {
        throw sessionLost(err);
      }
    }
    try {
      return await this.send(api, { method, version: "1", ...params, _sid: await this.login() }, what);
    } catch (err: unknown) {
      if (err instanceof DsRefusal && SESSION_CODES.has(err.code)) {
        this.sid = null;
        throw sessionLost(err);
      }
      throw refused(err);
    }
  }

  /** The next call reads the API list again and opens a new session — after a failed poll. */
  public reset(): void {
    this.apis = null;
    this.sid = null;
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }

  /** @returns a new session id; a coded no to the login is a rejected login (K5), anything else a protocol error */
  private async login(): Promise<string> {
    const auth = (await this.api("SYNO.API.Auth")).maxVersion;
    let data: unknown;
    try {
      data = await this.send(
        "SYNO.API.Auth",
        {
          method: "login",
          // DSM 7 lists Auth up to 7 and refuses version 2 (Sonarr: maxVersion >= 7 ? 6 : 2)
          version: auth >= 7 ? "6" : "2",
          account: this.user,
          passwd: this.pass,
          session: "DownloadStation",
          format: "sid",
        },
        "SYNO.API.Auth login",
      );
    } catch (err: unknown) {
      if (err instanceof DsRefusal && err.code >= 400 && err.code <= 411) {
        throw new AuthError(`downloadstation: login rejected — ${LOGIN_REFUSED[err.code] ?? `error ${err.code}`}`);
      }
      throw refused(err);
    }
    const sid = recordIn(data, "Download Station's login").sid;
    if (typeof sid !== "string" || sid === "") {
      throw new ProtocolError("Download Station's login without a session id — answer refused");
    }
    this.sid = sid;
    return sid;
  }

  /**
   * @param api the API
   * @returns where it lives — Download Station not listed means the package does not run
   */
  private async api(api: DsApi): Promise<ApiInfo> {
    this.apis ??= await this.readApis();
    const info = this.apis.get(api);
    if (!info) {
      throw new UnreachableError(`Download Station does not run on this DiskStation (${api} is not listed)`);
    }
    return info;
  }

  /** @returns the CGI and highest version of each API the driver calls that DSM lists */
  private async readApis(): Promise<Map<DsApi, ApiInfo>> {
    const res = await this.http.request({
      method: "GET",
      url: `${this.root}query.cgi?api=SYNO.API.Info&version=1&method=query&query=${APIS.join(",")}`,
    });
    if (res.status !== 200) {
      throw new ProtocolError(`downloadstation: the API list answered HTTP ${res.status}`);
    }
    let data: unknown;
    try {
      data = dataOf(res.json(), "SYNO.API.Info query");
    } catch (err: unknown) {
      throw refused(err);
    }
    const listed = recordIn(data, "Download Station's API list");
    const out = new Map<DsApi, ApiInfo>();
    for (const api of APIS) {
      const entry = listed[api];
      if (entry === undefined) {
        continue;
      }
      const { path, maxVersion } = recordIn(entry, `Download Station's API list, ${api}`);
      if (typeof path !== "string" || path === "" || path.includes("..") || typeof maxVersion !== "number") {
        throw new ProtocolError(`Download Station's API list, ${api}, lost its shape — answer refused`);
      }
      out.set(api, { path: path.replace(/^\/+/, ""), maxVersion });
    }
    return out;
  }

  /**
   * @param api the API
   * @param fields the form fields, `method` and `version` among them
   * @param what the call, for the error text — never a field's value
   * @returns the answer's `data`
   */
  private async send(api: DsApi, fields: Record<string, string>, what: string): Promise<unknown> {
    const { path } = await this.api(api);
    const res = await this.http.request({ method: "POST", url: `${this.root}${path}`, form: { api, ...fields } });
    if (res.status !== 200) {
      throw new ProtocolError(`downloadstation: ${what} answered HTTP ${res.status}`);
    }
    return dataOf(res.json(), what);
  }
}

/**
 * @param err a session code on a session that was just opened
 * @returns the error: 105 on a fresh session is the account's missing right to Download Station, an explicit no
 */
function sessionLost(err: DsRefusal): Error {
  return err.code === 105
    ? new AuthError("downloadstation: the account may not use Download Station (error 105)")
    : new ProtocolError(`downloadstation: the new session was refused at once (error ${err.code})`);
}

/**
 * @param err what a call threw
 * @returns a refusal as a protocol error, everything else unchanged
 */
function refused(err: unknown): unknown {
  return err instanceof DsRefusal ? new ProtocolError(`downloadstation: ${err.what} refused — error ${err.code}`) : err;
}

/**
 * @param data the answer to `pause`, `resume` or `delete` with a list of ids
 * @param what the call, for the error text
 * @returns the error code per id, 0 = done (Download Station API guide p. 25: `[{error, id}]`; live 0 and 405)
 */
export function perId(data: unknown, what: string): Map<string, number> {
  if (!Array.isArray(data)) {
    throw new ProtocolError(`Download Station's answer to ${what} is no list — answer refused`);
  }
  const out = new Map<string, number>();
  for (const entry of data) {
    const { id, error } = recordIn(entry, `an entry of Download Station's answer to ${what}`);
    if (typeof id !== "string" || typeof error !== "number") {
      throw new ProtocolError(`an entry of Download Station's answer to ${what} lost its shape — answer refused`);
    }
    out.set(id, error);
  }
  return out;
}
