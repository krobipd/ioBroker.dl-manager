import { AuthError, ProtocolError, UnreachableError } from "../../core/errors";
import { HttpClient, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../registry";

/**
 * deluge-web JSON-RPC (api-torrent.md § 3): password login (cookie `_session_id`), then the web UI must be connected
 * to a daemon — the first host of its list. `error.code === 1` means "not authenticated": one new login, one repeat.
 */
export class DlClient {
  private readonly http: HttpClient;
  private readonly url: string;
  private seq = 0;
  private ready = false;
  /** Version of the daemon the web UI is connected to. */
  public version = "";

  /**
   * @param cfg the settings row (only the password is used — Deluge has no user)
   * @param timers the adapter's timers
   */
  public constructor(
    private readonly cfg: ProgramConfig,
    timers: HttpTimers,
  ) {
    this.http = new HttpClient(timers);
    const path = cfg.path.replace(/\/+$/, "");
    this.url = `${cfg.https ? "https" : "http"}://${cfg.host}:${cfg.port || 8112}${path && !path.startsWith("/") ? `/${path}` : path}/json`;
  }

  /**
   * @param method e.g. `web.update_ui`
   * @param params positional parameters
   * @returns the call's `result`
   */
  public async call(method: string, params: unknown[] = []): Promise<unknown> {
    if (!this.ready) {
      await this.connect();
    }
    try {
      return await this.raw(method, params);
    } catch (err: unknown) {
      if (!(err instanceof SessionLost)) {
        throw err;
      }
      this.ready = false;
      await this.connect();
      return this.raw(method, params);
    }
  }

  /** The web UI lost its daemon: log in and connect it again on the next call. */
  public reset(): void {
    this.ready = false;
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }

  private async connect(): Promise<void> {
    this.http.clearCookies();
    if ((await this.raw("auth.login", [this.cfg.password])) !== true) {
      throw new AuthError("deluge: password rejected");
    }
    const hosts = await this.raw("web.get_hosts");
    const first = Array.isArray(hosts) && Array.isArray(hosts[0]) ? String(hosts[0][0]) : "";
    if (!first) {
      throw new ProtocolError("deluge: the web UI knows no daemon (connection manager is empty)");
    }
    const status = await this.raw("web.get_host_status", [first]);
    if (Array.isArray(status)) {
      this.version = typeof status[2] === "string" ? status[2] : "";
      if (status[1] === "Offline") {
        throw new UnreachableError("deluge: the daemon behind the web UI is offline");
      }
    }
    if ((await this.raw("web.connected")) !== true) {
      await this.raw("web.connect", [first]);
    }
    this.ready = true;
  }

  private async raw(method: string, params: unknown[] = []): Promise<unknown> {
    const res = await this.http.request({ method: "POST", url: this.url, json: { method, params, id: ++this.seq } });
    if (res.status >= 400) {
      throw new ProtocolError(`deluge: ${method} answered HTTP ${res.status}`);
    }
    const body = res.json() as { result?: unknown; error?: { code?: unknown; message?: unknown } | null } | null;
    const error = body?.error;
    if (error) {
      if (error.code === 1) {
        throw new SessionLost();
      }
      throw new ProtocolError(`deluge: ${method} failed: ${String(error.message)}`);
    }
    return body?.result;
  }
}

/** `error.code === 1` — the session is gone. */
class SessionLost extends Error {}
