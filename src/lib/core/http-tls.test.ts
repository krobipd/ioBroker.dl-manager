import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { UnreachableError } from "./errors";
import { HttpClient } from "./http";

/** The options of every node:https request the client makes. */
const seen = vi.hoisted((): Record<string, unknown>[] => []);

// node:https as it is, every request's options noted — a test certificate would put a private key into the repository
vi.mock("node:https", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  const request = real.request as (...args: unknown[]) => unknown;
  return {
    ...real,
    request: (...args: unknown[]): unknown => {
      seen.push(args[1] as Record<string, unknown>);
      return request(...args);
    },
  };
});

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};

describe("HttpClient with selfSignedTls (NZBVortex)", () => {
  let server: Server;
  let port: number;
  beforeEach(async () => {
    seen.length = 0;
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/x-json" });
      res.end('{"result":"ok"}');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("sends a TLS request through node:https without checking the certificate", async () => {
    const c = new HttpClient(timers, { selfSignedTls: true, timeoutMs: 2000 });
    // the plain HTTP server cannot speak TLS: the handshake fails, after the request was made with these options
    await expect(c.request({ method: "GET", url: `https://127.0.0.1:${port}/api/nzb` })).rejects.toThrow(
      UnreachableError,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", rejectUnauthorized: false });
  });

  it("keeps fetch for plain HTTP, and checks every certificate without the option", async () => {
    const c = new HttpClient(timers, { selfSignedTls: true });
    const r = await c.request({ method: "GET", url: `http://127.0.0.1:${port}/api/nzb` });
    expect([r.status, r.json()]).toEqual([200, { result: "ok" }]);
    const checked = new HttpClient(timers, { timeoutMs: 2000 });
    await expect(checked.request({ method: "GET", url: `https://127.0.0.1:${port}/` })).rejects.toThrow(
      UnreachableError,
    );
    expect(seen).toEqual([]);
  });
});
