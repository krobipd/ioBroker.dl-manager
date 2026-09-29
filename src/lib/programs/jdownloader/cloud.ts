import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { AuthError, ProtocolError, UnreachableError } from "../../core/errors";
import { HttpClient, type HttpResponse, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { checkJdCall, type JdTransport } from "./client";

/** The adapter's own app key — the web interface's prefix would trigger special behaviour in `config/set`. */
const APP_KEY = "ioBroker.dl-manager";
const API = "https://api.jdownloader.org";

/**
 * @param email account e-mail (lower-cased for the secret)
 * @param password account password
 * @param domain `server` (login secret) or `device`
 * @returns SHA-256(lower(email) + password + domain), raw
 */
export function jdSecret(email: string, password: string, domain: "server" | "device"): Buffer {
  return createHash("sha256").update(`${email.toLowerCase()}${password}${domain}`, "utf8").digest();
}

/**
 * @param serverBase login secret (first connect) or the previous server token (reconnect)
 * @param deviceSecret the account's device secret
 * @param sessionToken hex session token
 * @returns the tokens of the new session
 */
export function jdTokens(
  serverBase: Buffer,
  deviceSecret: Buffer,
  sessionToken: string,
): { server: Buffer; device: Buffer } {
  const session = Buffer.from(sessionToken, "hex");
  return {
    server: createHash("sha256")
      .update(Buffer.concat([serverBase, session]))
      .digest(),
    device: createHash("sha256")
      .update(Buffer.concat([deviceSecret, session]))
      .digest(),
  };
}

/**
 * @param key HMAC key
 * @param data the signed text
 * @returns hex HMAC-SHA256
 */
export function jdSign(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/**
 * @param token 32-byte token: IV = first 16 bytes, key = last 16
 * @param text plain text
 * @returns Base64 AES-128-CBC with PKCS#7 padding
 */
export function jdEncrypt(token: Buffer, text: string): string {
  const c = createCipheriv("aes-128-cbc", token.subarray(16, 32), token.subarray(0, 16));
  return Buffer.concat([c.update(text, "utf8"), c.final()]).toString("base64");
}

/**
 * @param token 32-byte token
 * @param data Base64 ciphertext
 * @returns the plain text
 */
export function jdDecrypt(token: Buffer, data: string): string {
  const d = createDecipheriv("aes-128-cbc", token.subarray(16, 32), token.subarray(0, 16));
  return Buffer.concat([d.update(Buffer.from(data.trim(), "base64")), d.final()]).toString("utf8");
}

/**
 * Parameters as myjdapi sends them over the cloud: strings as they are, lists element by element, everything else
 * as a JSON string.
 *
 * @param params positional parameters
 * @returns the adapted list
 */
export function adaptParams(params: readonly unknown[]): unknown[] {
  return params.map(p =>
    p === null ? null : typeof p === "string" ? p : Array.isArray(p) ? adaptParams(p) : JSON.stringify(p),
  );
}

/**
 * @param res a failed answer
 * @param token the token its body may be encrypted with
 * @returns the error type of My.JDownloader's body (plain or encrypted), empty when unreadable
 */
function errorType(res: HttpResponse, token: Buffer | null): string {
  const read = (text: string): string => {
    const t = (JSON.parse(text) as { type?: unknown } | null)?.type;
    return typeof t === "string" ? t : "";
  };
  try {
    return read(res.text);
  } catch {
    try {
      return token ? read(jdDecrypt(token, res.text)) : "";
    } catch {
      return "";
    }
  }
}

/**
 * JDownloader through My.JDownloader (api-jdownloader.md § 1.1, reference myjdapi 1.1.11): login with signed server
 * calls, AES-128-CBC device calls under `/t_<session>_<device>`, one reconnect with the regain token on TOKEN_INVALID.
 */
export class JdCloudTransport implements JdTransport {
  private readonly http: HttpClient;
  private readonly login: Buffer;
  private readonly device: Buffer;
  private session: Session | null = null;
  private deviceId = "";
  private rid = 0;

  /**
   * @param cfg the settings row: e-mail in `username`, password, device name in `device`
   * @param timers the adapter's timers
   * @param base the API address (tests point it at a local server)
   */
  public constructor(
    private readonly cfg: ProgramConfig,
    timers: HttpTimers,
    private readonly base = API,
  ) {
    this.http = new HttpClient(timers, { timeoutMs: 20_000 });
    this.login = jdSecret(cfg.username, cfg.password, "server");
    this.device = jdSecret(cfg.username, cfg.password, "device");
  }

  /**
   * @param path `/<namespace>/<method>`
   * @param params positional parameters
   * @returns the answer's `data`
   */
  public async call(path: string, params: unknown[] = []): Promise<unknown> {
    checkJdCall(path, params);
    if (!this.session) {
      await this.connect();
    }
    try {
      return await this.deviceCall(path, params);
    } catch (err: unknown) {
      if (!(err instanceof TokenInvalid)) {
        throw err;
      }
      await this.reconnect();
      return this.deviceCall(path, params);
    }
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }

  private nextRid(): number {
    this.rid = Math.max(this.rid + 1, Date.now());
    return this.rid;
  }

  private async server(path: string, query: [string, string][], key: Buffer): Promise<Record<string, unknown>> {
    const q = [...query, ["rid", String(this.nextRid())]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const signed = `${path}?${q}`;
    const res = await this.http.request({
      method: "GET",
      url: `${this.base}${signed}&signature=${jdSign(key, signed)}`,
    });
    if (res.status !== 200) {
      const type = errorType(res, key);
      if (type === "AUTH_FAILED" || type === "ERROR_EMAIL_NOT_CONFIRMED" || res.status === 401) {
        throw new AuthError(`jdownloader-cloud: My.JDownloader refused the login (${type || res.status})`);
      }
      if (type === "TOKEN_INVALID") {
        throw new TokenInvalid();
      }
      if (["TOO_MANY_REQUESTS", "MAINTENANCE", "OVERLOAD", "OFFLINE"].includes(type) || res.status >= 500) {
        throw new UnreachableError(`jdownloader-cloud: My.JDownloader answered ${type || res.status}`);
      }
      throw new ProtocolError(`jdownloader-cloud: ${path} answered HTTP ${res.status} ${type}`);
    }
    return JSON.parse(jdDecrypt(key, res.text)) as Record<string, unknown>;
  }

  private adopt(answer: Record<string, unknown>, serverBase: Buffer): Session {
    if (typeof answer.sessiontoken !== "string" || typeof answer.regaintoken !== "string") {
      throw new ProtocolError("jdownloader-cloud: login answer without session token");
    }
    const t = jdTokens(serverBase, this.device, answer.sessiontoken);
    this.session = { token: answer.sessiontoken, regain: answer.regaintoken, server: t.server, device: t.device };
    return this.session;
  }

  /**
   * Logs in and names the JDownloader instances of the account — the settings dialog offers them to choose from.
   * The session stays open for calls to the instance named in the settings row.
   *
   * @returns the instance names, as the account lists them
   */
  public async listDevices(): Promise<string[]> {
    return (await this.devices()).map(d => (typeof d.name === "string" ? d.name : "")).filter(n => n !== "");
  }

  /** @returns the account's device list, after a fresh login */
  private async devices(): Promise<{ id?: unknown; name?: unknown }[]> {
    this.session = null;
    const s = this.adopt(
      await this.server(
        "/my/connect",
        [
          ["email", this.cfg.username],
          ["appkey", APP_KEY],
        ],
        this.login,
      ),
      this.login,
    );
    const list = await this.server("/my/listdevices", [["sessiontoken", s.token]], s.server).catch((err: unknown) => {
      this.session = null;
      throw err;
    });
    return Array.isArray(list.list) ? (list.list as { id?: unknown; name?: unknown }[]) : [];
  }

  private async connect(): Promise<void> {
    const devices = await this.devices();
    const found = devices.find(d => d.name === this.cfg.device);
    if (!found || typeof found.id !== "string") {
      // no device, no session: the next call logs in and looks again (a PC that boots later)
      this.session = null;
      const known = devices.map(d => String(d.name)).join(", ") || "none";
      throw new ProtocolError(
        `jdownloader-cloud: device "${this.cfg.device}" not found in the account — known: ${known}`,
      );
    }
    this.deviceId = found.id;
  }

  private async reconnect(): Promise<void> {
    const s = this.session;
    if (!s) {
      await this.connect();
      return;
    }
    try {
      this.adopt(
        await this.server(
          "/my/reconnect",
          [
            ["appkey", APP_KEY],
            ["sessiontoken", s.token],
            ["regaintoken", s.regain],
          ],
          s.server,
        ),
        s.server,
      );
    } catch (err: unknown) {
      if (!(err instanceof TokenInvalid)) {
        throw err;
      }
      await this.connect();
    }
  }

  private async deviceCall(path: string, params: unknown[]): Promise<unknown> {
    const s = this.session;
    if (!s) {
      throw new TokenInvalid();
    }
    const body = JSON.stringify({ apiVer: 1, url: path, params: adaptParams(params), rid: this.nextRid() });
    const res = await this.http.request({
      method: "POST",
      url: `${this.base}/t_${s.token}_${this.deviceId}${path}`,
      headers: { "content-type": "application/aesjson-jd; charset=utf-8" },
      body: jdEncrypt(s.device, body),
    });
    if (res.status !== 200) {
      const type = errorType(res, s.device);
      if (type === "TOKEN_INVALID") {
        throw new TokenInvalid();
      }
      if (type === "AUTH_FAILED") {
        throw new AuthError("jdownloader-cloud: the device refused the session (AUTH_FAILED)");
      }
      if (type === "OFFLINE" || type === "TOO_MANY_REQUESTS" || res.status >= 500) {
        throw new UnreachableError(
          `jdownloader-cloud: ${type === "OFFLINE" ? "the device is offline" : type || `HTTP ${res.status}`}`,
        );
      }
      throw new ProtocolError(`jdownloader-cloud: ${path} answered HTTP ${res.status} ${type}`);
    }
    return (JSON.parse(jdDecrypt(s.device, res.text)) as { data?: unknown } | null)?.data;
  }
}

/** The session is gone — one reconnect, one repeat. */
class TokenInvalid extends Error {}

/** One My.JDownloader session: its tokens and the keys derived from them. */
interface Session {
  /** Session token (hex). */
  token: string;
  /** Regain token for `/my/reconnect`. */
  regain: string;
  /** Server key of this session. */
  server: Buffer;
  /** Device key of this session. */
  device: Buffer;
}

/**
 * The settings dialog's My.JDownloader step: log in with the typed account and name its JDownloader instances.
 *
 * @param email account e-mail
 * @param password account password
 * @param timers the adapter's timers
 * @param base the API address (tests point it at a local server)
 * @returns the instance names
 */
export async function listMyJdDevices(
  email: string,
  password: string,
  timers: HttpTimers,
  base = API,
): Promise<string[]> {
  const transport = new JdCloudTransport(
    {
      type: "jdownloader-cloud",
      key: "",
      name: "",
      host: "",
      port: 0,
      https: false,
      path: "",
      username: email,
      password,
      apiKey: "",
      device: "",
    },
    timers,
    base,
  );
  try {
    return await transport.listDevices();
  } finally {
    transport.close();
  }
}
