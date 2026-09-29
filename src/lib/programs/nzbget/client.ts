import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { baseUrl, catalogEntry } from "../catalog";

/**
 * NZBGet JSON-RPC (api-usenet-aria2-pyload.md § 2): `POST /jsonrpc`, basic auth, positional parameters. NZBGet closes
 * the connection after every answer — the client sends once more on a closed kept-alive socket.
 */
export class NzbClient {
  private readonly http: HttpClient;
  private readonly url: string;
  private seq = 0;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    this.http = new HttpClient(timers, {
      resendOnClosedSocket: true,
      ...(cfg.username ? { basicAuth: { user: cfg.username, pass: cfg.password } } : {}),
    });
    this.url = `${baseUrl(cfg, catalogEntry("nzbget"))}/jsonrpc`;
  }

  /**
   * @param method e.g. `listgroups`
   * @param params positional parameters
   * @returns the call's `result`
   */
  public async call(method: string, params: unknown[] = []): Promise<unknown> {
    const res = await this.http.request({ method: "POST", url: this.url, json: { method, params, id: ++this.seq } });
    if (res.status === 401 || res.status === 403) {
      throw new AuthError("nzbget: login rejected (ControlUsername / ControlPassword)");
    }
    if (res.status >= 400) {
      throw new ProtocolError(`nzbget: ${method} answered HTTP ${res.status}`);
    }
    const body = res.json() as { result?: unknown; error?: { message?: unknown } | null } | null;
    if (body?.error) {
      throw new ProtocolError(`nzbget: ${method} failed: ${String(body.error.message)}`);
    }
    return body?.result;
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }
}
