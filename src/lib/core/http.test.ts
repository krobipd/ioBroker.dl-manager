import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { LOCAL_PROGRAMS } from "../api-limits";
import { CallBudget } from "./call-budget";
import { ProtocolError, UnreachableError } from "./errors";
import { HttpClient, RETRY_AFTER_DEFAULT_MS, RETRY_AFTER_MAX_MS, retryAfterMs } from "./http";

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

  // fleet suite D21: a 429 is a rate limit — the host is not called again before its retry-after ran out
  it("hands a 429 to the program's client and calls that program no more until its retry-after ran out", async () => {
    let calls = 0;
    const s = await serve((_req, _b, res) => {
      calls++;
      res.statusCode = 429;
      res.setHeader("retry-after", "60");
      res.end();
    });
    server = s.server;
    let now = 1_000_000;
    const c = new HttpClient(timers, { now: () => now });
    expect((await c.request({ method: "GET", url: s.url })).status).toBe(429);
    now += 59_000;
    const err: unknown = await c.request({ method: "GET", url: s.url }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreachableError);
    expect(String(err)).toContain("next call in 1 s");
    expect(calls).toBe(1);
    now += 1_000;
    expect((await c.request({ method: "GET", url: s.url })).status).toBe(429);
    expect(calls).toBe(2);
  });

  it("reads retry-after as seconds or an HTTP date, a minute without one, an hour at most", () => {
    const now = Date.parse("2026-10-27T10:00:00Z");
    expect(retryAfterMs("120", now)).toBe(120_000);
    expect(retryAfterMs("Tue, 27 Oct 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs(null, now)).toBe(RETRY_AFTER_DEFAULT_MS);
    expect(retryAfterMs("soon", now)).toBe(RETRY_AFTER_DEFAULT_MS);
    expect(retryAfterMs("Tue, 27 Oct 2026 09:00:00 GMT", now)).toBe(RETRY_AFTER_DEFAULT_MS);
    expect(retryAfterMs("86400", now)).toBe(RETRY_AFTER_MAX_MS);
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

  it("calls an address that is no URL a protocol error, never unreachable (review B12)", async () => {
    const req = new HttpClient(timers).request({ method: "GET", url: "http://[nas:8080]:80/" });
    await expect(req).rejects.toThrow(ProtocolError);
    await expect(req).rejects.toThrow(/no valid URL/);
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

  it("sends only with a place in its counterpart's windows, and gives the wait up when closed", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response("{}")));
    try {
      const budget = new CallBudget([
        {
          name: LOCAL_PROGRAMS,
          match: { network: "private" },
          limits: [{ max: 1, seconds: 60, per: "host", source: "t" }],
        },
        { name: "cloud", match: { host: "cloud" }, limits: [{ max: 1, seconds: 60, per: "account", source: "t" }] },
      ]);
      const local = new HttpClient({ ...timers, budget });
      await local.request({ method: "GET", url: "http://nas:1/a" });
      await local.request({ method: "GET", url: "http://pc:1/a" });
      const second = local.request({ method: "GET", url: "http://nas:1/b" });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(spy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect((await second).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(3);
      const cloud = new HttpClient({ ...timers, budget }, { counterpart: "cloud" });
      await cloud.request({ method: "GET", url: "http://cloud/a" });
      const shared = cloud.request({ method: "GET", url: "http://other/a" });
      await vi.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledTimes(4);
      cloud.close();
      await expect(shared).rejects.toThrow(/waited for its place/);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("gives the second send after a closed socket a place of its own", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const closed = new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => Promise.reject(closed))
      .mockImplementation(() => Promise.resolve(new Response("{}")));
    try {
      const budget = new CallBudget([
        {
          name: LOCAL_PROGRAMS,
          match: { network: "private" },
          limits: [{ max: 2, seconds: 60, per: "host", source: "t" }],
        },
      ]);
      const client = new HttpClient({ ...timers, budget }, { resendOnClosedSocket: true });
      expect((await client.request({ method: "GET", url: "http://nas:1/a" })).status).toBe(200);
      // two calls went out, the window of two is full
      const next = client.request({ method: "GET", url: "http://nas:1/b" });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(spy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(spy).toHaveBeenCalledTimes(3);
      expect((await next).status).toBe(200);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("counts a request without an answer from its send, stamped after the transport took it", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => {
        // the transport call itself takes time, and the program never answers
        vi.setSystemTime(Date.now() + 5);
        return new Promise<Response>((_resolve, reject) => {
          globalThis.setTimeout(() => reject(new TypeError("fetch failed")), 9_000);
        });
      })
      .mockImplementation(() => Promise.resolve(new Response("{}")));
    try {
      const budget = new CallBudget([
        {
          name: LOCAL_PROGRAMS,
          match: { network: "private" },
          limits: [{ max: 1, seconds: 60, per: "host", source: "t" }],
        },
      ]);
      const client = new HttpClient({ ...timers, budget });
      const failed = expect(client.request({ method: "GET", url: "http://nas:1/a" })).rejects.toThrow(UnreachableError);
      await vi.advanceTimersByTimeAsync(9_000);
      await failed;
      const next = client.request({ method: "GET", url: "http://nas:1/b" });
      // a window after the send (1_000_005) — not after the hand-out (1_000_000), not after the failure (1_009_005)
      await vi.advanceTimersByTimeAsync(50_999);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spy).toHaveBeenCalledTimes(2);
      expect((await next).status).toBe(200);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
