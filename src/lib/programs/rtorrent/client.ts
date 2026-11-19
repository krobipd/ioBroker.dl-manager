import { listIn } from "../../core/answer";
import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { baseUrl, catalogEntry } from "../catalog";
import { methodCall, multicallResult, parseResponse, type RpcParam } from "./xmlrpc";

/** One call of a `system.multicall`. */
export interface RpcCall {
  /** The method. */
  method: string;
  /** Its parameters — rTorrent wants the target first (`""` for none). */
  params: readonly RpcParam[];
}

/**
 * rTorrent's XML-RPC over HTTP. rTorrent itself speaks SCGI; a web server in front of it (nginx, lighttpd, ruTorrent's)
 * serves it at a path — `/RPC2` by convention — and does the login: HTTP basic auth, when it asks for one.
 */
export class RtClient {
  private readonly http: HttpClient;
  private readonly url: string;

  /**
   * @param cfg the settings row
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    this.http = new HttpClient(timers, cfg.username ? { basicAuth: { user: cfg.username, pass: cfg.password } } : {});
    this.url = baseUrl(cfg, catalogEntry("rtorrent"));
  }

  /**
   * @param method the method
   * @param params its parameters, the target first
   * @returns the result; a fault of rTorrent throws a ProtocolError
   */
  public async call(method: string, ...params: RpcParam[]): Promise<unknown> {
    const res = await this.http.request({
      method: "POST",
      url: this.url,
      body: methodCall(method, params),
      headers: { "content-type": "text/xml" },
    });
    if (res.status === 401 || res.status === 403) {
      throw new AuthError("rTorrent: login rejected (the web server in front of its XML-RPC)");
    }
    if (res.status >= 400) {
      throw new ProtocolError(`rTorrent: XML-RPC answered HTTP ${res.status}`);
    }
    return parseResponse(res.text);
  }

  /**
   * Several calls in one request.
   *
   * @param calls the calls
   * @returns their results in the same order; a call rTorrent refused throws a ProtocolError
   */
  public async multicall(calls: readonly RpcCall[]): Promise<unknown[]> {
    const results = listIn(
      await this.call(
        "system.multicall",
        calls.map(c => ({ methodName: c.method, params: c.params })),
      ),
      "rTorrent's multicall answer",
    );
    if (results.length !== calls.length) {
      throw new ProtocolError(`rTorrent answered ${results.length} of ${calls.length} calls — answer refused`);
    }
    return results.map((r, i) => multicallResult(r, calls[i].method));
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }
}
