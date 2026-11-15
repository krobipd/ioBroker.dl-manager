import { recordIn } from "../../core/answer";
import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { asText } from "../../core/units";
import { baseUrl, catalogEntry } from "../catalog";

/**
 * Hadouken's JSON-RPC API (Sonarr's HadoukenProxy.cs; Hadouken 5.2.0 src/http/http_server.cpp, js/rpc.js): POST to
 * `<root>api` with basic auth on every request — a request without it, or with a wrong one, gets 401. Hadouken finds the
 * login only under the header named exactly `Authorization` (http_server.cpp) and reads a body only behind the one named
 * exactly `Content-Length` (connection_handler.cpp; fetch writes it in lower case and the connection drops without an
 * answer, live-programs run 43714685079), so the calls go through node:http. A refused call answers HTTP 200 with an
 * `error` object (`Method not found`, or `Internal server error` with the script's message in `data.message`).
 */
export class HkClient {
  private readonly http: HttpClient;
  private readonly url: string;
  private id = 0;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    this.http = new HttpClient(timers, {
      basicAuth: { user: cfg.username, pass: cfg.password },
      exactHeaderNames: true,
    });
    this.url = baseUrl(cfg, catalogEntry("hadouken"));
  }

  /**
   * @param method the RPC method, e.g. `webui.list`
   * @param params its positional parameters
   * @returns the call's `result` (undefined when the method returns nothing — `webui.perform`, `webui.setSettings`)
   */
  public async call(method: string, params: readonly unknown[] = []): Promise<unknown> {
    this.id++;
    const res = await this.http.request({
      method: "POST",
      url: this.url,
      json: { jsonrpc: "2.0", id: this.id, method, params },
    });
    if (res.status === 401) {
      throw new AuthError("hadouken: login rejected");
    }
    if (res.status >= 300) {
      throw new ProtocolError(`hadouken: ${method} answered HTTP ${res.status} ${res.text.trim().slice(0, 80)}`);
    }
    const body = recordIn(res.json(), `Hadouken's answer to ${method}`);
    if (body.error !== undefined && body.error !== null) {
      const error = recordIn(body.error, `Hadouken's error for ${method}`);
      const data = error.data;
      const detail = typeof data === "object" && data !== null ? asText((data as { message?: unknown }).message) : "";
      throw new ProtocolError(`hadouken: ${method} refused — ${asText(error.message)}${detail ? `: ${detail}` : ""}`);
    }
    return body.result;
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }
}
