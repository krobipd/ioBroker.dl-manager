import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the server saw. */
export interface RecordedCall {
  /** HTTP method. */
  method: string;
  /** Path without the query. */
  path: string;
  /** Query string without `?`. */
  query: string;
  /** Request body. */
  body: string;
  /** Request headers. */
  headers: IncomingMessage["headers"];
}

/** What a route answers. */
export interface FixtureAnswer {
  /** HTTP status, default 200. */
  status?: number;
  /** Body; an object is sent as JSON. */
  body?: unknown;
  /** Extra headers. */
  headers?: Record<string, string | string[]>;
}

/** A running fixture server. */
export interface FixtureServer {
  /** e.g. `http://127.0.0.1:41234` */
  baseUrl: string;
  /** Every request, in order. */
  calls: RecordedCall[];
  /** Stops the server. */
  close(): Promise<void>;
}

/**
 * A local HTTP server that answers with recorded program answers — the drivers' tests never reach a real program.
 *
 * @param route answers one request
 * @returns the running server
 */
export async function startFixtureServer(route: (call: RecordedCall) => FixtureAnswer): Promise<FixtureServer> {
  const calls: RecordedCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const [path, query = ""] = (req.url ?? "/").split("?", 2);
      const call: RecordedCall = { method: req.method ?? "GET", path, query, body, headers: req.headers };
      calls.push(call);
      const a = route(call);
      res.statusCode = a.status ?? 200;
      for (const [k, v] of Object.entries(a.headers ?? {})) {
        res.setHeader(k, v);
      }
      if (a.body === undefined || typeof a.body === "string") {
        res.end(a.body ?? "");
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(a.body));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
