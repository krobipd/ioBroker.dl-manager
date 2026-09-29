import { ProtocolError } from "../../core/errors";
import { HttpClient, type HttpTimers } from "../../core/http";
import { baseUrl, catalogEntry, type Endpoint } from "../catalog";

/** The one call JD's API knows: a namespace path and positional parameters; the answer's `data`. */
export interface JdTransport {
  /** Calls `/<namespace>/<method>`. */
  call(path: string, params?: unknown[]): Promise<unknown>;
  /** Aborts what is still waiting. */
  close(): void;
}

/**
 * The only methods the adapter sends. The local API has no login and would also run `system/exitJD` or change any
 * setting — the list keeps the adapter to what it needs (api-jdownloader.md § 1.2.2).
 */
export const JD_METHODS: ReadonlySet<string> = new Set([
  "/downloadsV2/queryPackages",
  "/downloadsV2/queryLinks",
  "/downloadsV2/setEnabled",
  "/downloadsV2/resumeLinks",
  "/downloadsV2/removeLinks",
  "/downloadsV2/forceDownload",
  "/downloadcontroller/start",
  "/downloadcontroller/stop",
  "/downloadcontroller/pause",
  "/downloadcontroller/getCurrentState",
  "/toolbar/getStatus",
  "/config/get",
  "/config/set",
  "/linkgrabberv2/addLinks",
  "/jd/version",
  "/events/subscribe",
  "/events/listen",
]);

/** Settings the adapter may read or write through `config/get|set`. */
const CONFIG_KEYS = new Set(["DownloadSpeedLimit", "DownloadSpeedLimitEnabled"]);
/** The settings interface the adapter may touch (the speed limit only). */
export const GENERAL_SETTINGS = "org.jdownloader.settings.GeneralSettings";

/**
 * Keeps both transports to the fixed method list and the two speed-limit settings.
 *
 * @param path `/<namespace>/<method>`
 * @param params positional parameters
 */
export function checkJdCall(path: string, params: readonly unknown[]): void {
  if (!JD_METHODS.has(path)) {
    throw new ProtocolError(`jdownloader: ${path} is not a method the adapter uses`);
  }
  if (
    (path === "/config/set" || path === "/config/get") &&
    (params[0] !== GENERAL_SETTINGS || !CONFIG_KEYS.has(String(params[2])))
  ) {
    throw new ProtocolError(
      "jdownloader: config access is limited to DownloadSpeedLimit and DownloadSpeedLimitEnabled",
    );
  }
}

/**
 * @param cfg host, port (0 = 3128), https, path of the settings row
 * @returns the base URL of JD's local API
 */
export function jdBaseUrl(cfg: Endpoint): string {
  return baseUrl(cfg, catalogEntry("jdownloader"));
}

/** JD's local "Deprecated API": plain HTTP, no login, `{data}` around every answer. */
export class JdLocalTransport implements JdTransport {
  private readonly http: HttpClient;
  private rid = 0;

  /**
   * @param base base URL (`jdBaseUrl`)
   * @param timers the adapter's timers
   * @param timeoutMs deadline per request (the event long poll needs 35 s)
   */
  public constructor(
    private readonly base: string,
    timers: HttpTimers,
    timeoutMs = 10_000,
  ) {
    this.http = new HttpClient(timers, { timeoutMs });
  }

  /**
   * @param path `/<namespace>/<method>` from JD_METHODS
   * @param params positional parameters
   * @returns the answer's `data`
   */
  public async call(path: string, params: unknown[] = []): Promise<unknown> {
    checkJdCall(path, params);
    const res = await this.http.request({
      method: "POST",
      url: `${this.base}${path}`,
      json: { apiVer: 1, url: path, params, rid: ++this.rid },
    });
    if (res.status === 404) {
      throw new ProtocolError(
        `jdownloader: ${path} not found — is the local API ("Deprecated API") switched on in JD's advanced settings?`,
      );
    }
    if (res.status >= 400) {
      const type = (res.json() as { type?: unknown } | null)?.type;
      throw new ProtocolError(`jdownloader: HTTP ${res.status}${typeof type === "string" ? ` ${type}` : ""}`);
    }
    const body = res.json();
    return body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  }

  /** Aborts a waiting long poll. */
  public close(): void {
    this.http.close();
  }
}
