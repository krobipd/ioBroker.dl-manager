import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ProtocolError, UnreachableError } from "./errors";
import { HttpClient } from "./http";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => handler(req, body, res));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("HttpClient", () => {
  it("sends once more when a server closed the kept-alive socket (NZBGet) — only with the option", async () => {
    const closed = (): TypeError => new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
    const ok = new Response("{}", { status: 200 });
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(closed()).mockResolvedValueOnce(ok);
    try {
      const r = await new HttpClient(timers, { resendOnClosedSocket: true }).request({
        method: "POST",
        url: "http://x/",
      });
      expect(r.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockReset().mockRejectedValueOnce(closed());
      await expect(new HttpClient(timers).request({ method: "POST", url: "http://x/" })).rejects.toThrow(
        UnreachableError,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("sends a multipart body with its own boundary", async () => {
    let type = "";
    let body = "";
    const s = await serve((req, b, res) => {
      type = req.headers["content-type"] ?? "";
      body = b;
      res.end("Ok.");
    });
    server = s.server;
    await new HttpClient(timers).request({
      method: "POST",
      url: s.url,
      multipart: { urls: "magnet:?xt=1", stopped: "true" },
    });
    expect(type).toMatch(/^multipart\/form-data; boundary=/);
    expect(body).toContain('name="urls"');
    expect(body).toContain("magnet:?xt=1");
  });

  it("sends JSON and form bodies and parses a JSON answer", async () => {
    const seen: { type?: string; body: string }[] = [];
    const s = await serve((req, body, res) => {
      seen.push({ type: req.headers["content-type"], body });
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
    server = s.server;
    const c = new HttpClient(timers);
    const r = await c.request({ method: "POST", url: `${s.url}/a`, json: { x: 1 } });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    await c.request({ method: "POST", url: `${s.url}/b`, form: { user: "a b", pass: "p&q" } });
    expect(seen).toEqual([
      { type: "application/json", body: '{"x":1}' },
      { type: "application/x-www-form-urlencoded", body: "user=a+b&pass=p%26q" },
    ]);
  });

  it("keeps cookies the program sets and sends them back", async () => {
    const cookies: (string | undefined)[] = [];
    const s = await serve((req, _b, res) => {
      cookies.push(req.headers.cookie);
      res.setHeader("set-cookie", ["SID=abc; HttpOnly; path=/", "other=1"]);
      res.end("Ok.");
    });
    server = s.server;
    const c = new HttpClient(timers);
    await c.request({ method: "GET", url: `${s.url}/login` });
    await c.request({ method: "GET", url: `${s.url}/list` });
    expect(cookies).toEqual([undefined, "SID=abc; other=1"]);
    c.clearCookies();
    await c.request({ method: "GET", url: `${s.url}/list` });
    expect(cookies[2]).toBeUndefined();
  });

  it("sends basic auth when configured", async () => {
    let auth: string | undefined;
    const s = await serve((req, _b, res) => {
      auth = req.headers.authorization;
      res.end("");
    });
    server = s.server;
    await new HttpClient(timers, { basicAuth: { user: "u", pass: "p" } }).request({ method: "GET", url: s.url });
    expect(auth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("refuses to follow a redirect — it is a login page or a wrong path", async () => {
    const s = await serve((_req, _b, res) => {
      res.statusCode = 302;
      res.setHeader("location", "/login.html");
      res.end();
    });
    server = s.server;
    await expect(new HttpClient(timers).request({ method: "GET", url: s.url })).rejects.toThrow(ProtocolError);
  });

  it("calls 502, 503 and 504 — a proxy in front of a program that is down — unreachable", async () => {
    for (const status of [502, 503, 504]) {
      const s = await serve((_req, _b, res) => {
        res.statusCode = status;
        res.end("Bad Gateway");
      });
      server = s.server;
      const err: unknown = await new HttpClient(timers).request({ method: "GET", url: s.url }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnreachableError);
      expect(String(err)).toContain(`HTTP ${status}`);
      await new Promise<void>(resolve => s.server.close(() => resolve()));
      server = undefined;
    }
  });

  it("hands a 500 to the program's client — JDownloader answers its own errors with it", async () => {
    const s = await serve((_req, _b, res) => {
      res.statusCode = 500;
      res.end('{"type":"INTERNAL_SERVER_ERROR"}');
    });
    server = s.server;
    expect((await new HttpClient(timers).request({ method: "GET", url: s.url })).status).toBe(500);
  });

  it("gives up after the deadline as unreachable", async () => {
    const s = await serve(() => undefined);
    server = s.server;
    const c = new HttpClient(timers, { timeoutMs: 50 });
    await expect(c.request({ method: "GET", url: s.url })).rejects.toThrow(/no answer within 0.05 s/);
    server.closeAllConnections();
  });

  it("resends only on a closed socket, never on another network error", async () => {
    const refused = (): TypeError => new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(refused());
    try {
      const c = new HttpClient(timers, { resendOnClosedSocket: true });
      await expect(c.request({ method: "POST", url: "http://x/" })).rejects.toThrow(UnreachableError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps no cookie without a name", async () => {
    const cookies: (string | undefined)[] = [];
    const s = await serve((req, _b, res) => {
      cookies.push(req.headers.cookie);
      res.setHeader("set-cookie", ["=orphan", "SID=abc"]);
      res.end("Ok.");
    });
    server = s.server;
    const c = new HttpClient(timers);
    await c.request({ method: "GET", url: s.url });
    await c.request({ method: "GET", url: s.url });
    expect(cookies[1]).toBe("SID=abc");
  });

  it("reports a refused connection as unreachable", async () => {
    const s = await serve((_req, _b, res) => res.end());
    const url = s.url;
    await new Promise<void>(resolve => s.server.close(() => resolve()));
    await expect(new HttpClient(timers).request({ method: "GET", url })).rejects.toThrow(UnreachableError);
  });

  it("close() aborts a request that is still waiting (long poll at shutdown)", async () => {
    const s = await serve(() => undefined);
    server = s.server;
    const c = new HttpClient(timers, { timeoutMs: 60_000 });
    const pending = c.request({ method: "GET", url: s.url });
    await new Promise(resolve => setTimeout(resolve, 50));
    c.close();
    await expect(pending).rejects.toThrow(UnreachableError);
    server.closeAllConnections();
  });

  it("calls a body that is not JSON a protocol error", async () => {
    const s = await serve((_req, _b, res) => res.end("<html>"));
    server = s.server;
    const r = await new HttpClient(timers).request({ method: "GET", url: s.url });
    expect(r.text).toBe("<html>");
    expect(() => r.json()).toThrow(ProtocolError);
  });
});
