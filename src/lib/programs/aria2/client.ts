import { AuthError, ProtocolError } from "../../core/errors";
import { HttpClient, type HttpTimers } from "../../core/http";
import type { ProgramConfig } from "../../core/model";
import { baseUrl, catalogEntry } from "../catalog";

/** The part of a WebSocket the push channel uses (Node 22 has one built in). */
export interface MiniSocket {
  /** Subscribes to an event. */
  addEventListener(type: "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
  /** Closes the socket. */
  close(): void;
}

/** Opens a WebSocket — a seam for the tests. */
export type SocketFactory = (url: string) => MiniSocket;

/**
 * @param url the ws:// address
 * @returns Node's built-in WebSocket
 */
export const nodeSocket: SocketFactory = url =>
  new (globalThis as unknown as { WebSocket: new (u: string) => MiniSocket }).WebSocket(url);

const fault = (v: unknown): { code?: unknown; message?: unknown } | null =>
  v && typeof v === "object" && !Array.isArray(v) && "code" in v ? v : null;

/**
 * aria2 JSON-RPC (api-usenet-aria2-pyload.md § 3): every call carries `token:<secret>` as its first parameter. A
 * wrong token is `code 1` with the text "Unauthorized" — the same code every other method error has, so the text
 * decides.
 */
export class AriaClient {
  private readonly http: HttpClient;
  private readonly url: string;
  /** The WebSocket address of the same RPC endpoint. */
  public readonly wsUrl: string;
  private readonly token: string;
  private seq = 0;

  /**
   * @param cfg the settings row (the RPC secret in the API key column)
   * @param timers the adapter's timers
   */
  public constructor(cfg: ProgramConfig, timers: HttpTimers) {
    this.http = new HttpClient(timers);
    this.url = baseUrl(cfg, catalogEntry("aria2"));
    this.wsUrl = baseUrl(cfg, catalogEntry("aria2"), "ws");
    this.token = `token:${cfg.apiKey}`;
  }

  /**
   * @param method e.g. `aria2.pause`
   * @param params parameters after the token
   * @returns the call's result
   */
  public async call(method: string, params: unknown[] = []): Promise<unknown> {
    return this.send(method, [this.token, ...params]);
  }

  /**
   * Several calls in one request.
   *
   * @param calls method and parameters (after the token) of each
   * @returns each call's result, in order
   */
  public async multicall(calls: readonly (readonly [string, unknown[]])[]): Promise<unknown[]> {
    const result = await this.send("system.multicall", [
      calls.map(([methodName, params]) => ({ methodName, params: [this.token, ...params] })),
    ]);
    if (!Array.isArray(result) || result.length !== calls.length) {
      throw new ProtocolError("aria2: system.multicall answered an unexpected shape");
    }
    return result.map((r, i) => {
      const f = fault(r);
      if (f) {
        this.raise(calls[i][0], f);
      }
      return Array.isArray(r) ? r[0] : r;
    });
  }

  /** Aborts what is still waiting. */
  public close(): void {
    this.http.close();
  }

  private async send(method: string, params: unknown[]): Promise<unknown> {
    const res = await this.http.request({
      method: "POST",
      url: this.url,
      json: { jsonrpc: "2.0", id: String(++this.seq), method, params },
    });
    const body = res.json() as { result?: unknown; error?: unknown } | null;
    const f = fault(body?.error);
    if (f) {
      this.raise(method, f);
    }
    if (res.status >= 400) {
      throw new ProtocolError(`aria2: ${method} answered HTTP ${res.status}`);
    }
    return body?.result;
  }

  private raise(method: string, f: { code?: unknown; message?: unknown }): never {
    const message = typeof f.message === "string" ? f.message : "";
    if (message === "Unauthorized") {
      throw new AuthError("aria2: the RPC secret was refused");
    }
    throw new ProtocolError(`aria2: ${method} failed: ${message || `code ${String(f.code)}`}`);
  }
}
