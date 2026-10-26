import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AuthError, ProtocolError, UnreachableError } from "../../src/lib/core/errors";
import {
  RATIO_INFINITE,
  STATUSES,
  type Capability,
  type Command,
  type ProgramDriver,
  type ProgramSnapshot,
  type Status,
} from "../../src/lib/core/model";
import { startFixtureServer, type FixtureServer, type RecordedCall } from "./fixture-server";

/** The fixture server of one driver, with the hooks the contract needs. */
export interface ContractServer extends FixtureServer {
  /** The next API call answers "session expired" once (programs with a login session). */
  expireSession?(): void;
  /** The next poll's secondary list fails (programs whose poll reads more than one list). */
  failSublist?(): void;
}

/** One driver's contract case. */
export interface ContractCase {
  /** Program type. */
  type: string;
  /** Starts the fixture server with the recorded answers. */
  server: () => Promise<ContractServer>;
  /** Builds the driver against the server, with accepted or rejected credentials. */
  makeDriver: (baseUrl: string, creds: { good: boolean }) => ProgramDriver;
  /** The map layer: raw status → common status, with a debug line for an unknown raw value. */
  mapStatus: (raw: string | number, debug: (msg: string) => void) => Status;
  /** Every raw status value from the research enumeration and the status it must map to. */
  statusTable: readonly (readonly [raw: string | number, expected: Status])[];
  /** A raw status no version of the program sends. */
  unknownStatus: string | number;
  /** Expected request per supported command. */
  commandCalls: Partial<Record<CommandKind, { method: string; path: string; bodyContains?: string }>>;
  /** Tells a login request from the rest. */
  isLoginCall: (call: RecordedCall) => boolean;
  /** The program has no login at all (JDownloader's local API) — the rejected-login test does not apply. */
  noLogin?: boolean;
}

type CommandKind = Exclude<Command["kind"], "extra">;

/** Which capability offers which command — a command without its capability must be refused. */
const COMMAND_CAPABILITY: Readonly<Record<CommandKind, Capability>> = {
  pauseAll: "globalPause",
  resumeAll: "globalPause",
  pause: "itemPause",
  resume: "itemPause",
  remove: "itemRemove",
  add: "add",
  setSpeedLimit: "speedLimit",
  setUploadLimit: "uploadLimit",
  setAltSpeed: "altSpeed",
};

const sample = (kind: CommandKind, key: string): Command => {
  switch (kind) {
    case "pause":
    case "resume":
    case "remove":
      return { kind, key };
    case "add":
      return { kind, url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" };
    case "setSpeedLimit":
    case "setUploadLimit":
      return { kind, bps: 2_000_000 };
    case "setAltSpeed":
      return { kind, on: true };
    default:
      return { kind };
  }
};

/**
 * The network hook's drift (fleet master test/network-hook.js, section 7): of every object's keys the first of each three
 * is gone, the second null, the third of another type.
 *
 * @param value a parsed answer
 * @returns it drifted
 */
function drift(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(drift);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  Object.entries(value).forEach(([key, v], i) => {
    if (i % 3 === 1) {
      out[key] = null;
    } else if (i % 3 === 2) {
      out[key] =
        typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : typeof v === "string" || v === null
            ? 0
            : drift(v);
    }
  });
  return out;
}

/**
 * A proxy in front of a fixture server that drifts the JSON of exactly one answer, the n-th it passes on.
 *
 * @param target the fixture server
 * @param n which answer drifts (0 = the first)
 * @returns the running proxy
 */
async function startDriftProxy(target: string, n: number): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let seen = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      void (async () => {
        const headers = Object.fromEntries(
          Object.entries(req.headers).filter(
            ([k, v]) => typeof v === "string" && k !== "host" && k !== "content-length",
          ),
        ) as Record<string, string>;
        const real = await fetch(`${target}${req.url ?? "/"}`, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
          redirect: "manual",
        });
        let text = await real.text();
        if (seen++ === n) {
          try {
            text = JSON.stringify(drift(JSON.parse(text)));
          } catch {
            // not JSON — it goes on as it came, like in the network hook
          }
        }
        res.statusCode = real.status;
        for (const [k, v] of real.headers) {
          if (k !== "content-length" && k !== "content-encoding" && k !== "transfer-encoding") {
            res.setHeader(k, v);
          }
        }
        const cookies = real.headers.getSetCookie();
        if (cookies.length) {
          res.setHeader("set-cookie", cookies);
        }
        res.end(text);
      })().catch(() => {
        res.statusCode = 599;
        res.end();
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const unknownOrNonNegative = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/**
 * The contract every driver passes. Declares its own describe/it blocks.
 *
 * @param c the driver's case
 */
export function runDriverContract(c: ContractCase): void {
  describe(`driver contract — ${c.type}`, () => {
    let server: ContractServer;
    beforeEach(async () => {
      server = await c.server();
    });
    afterEach(async () => {
      await server.close();
    });

    it("calls a reverse proxy that answers 502 for a program that is down unreachable", async () => {
      const proxy = await startFixtureServer(() => ({ status: 502, body: "Bad Gateway" }));
      const driver = c.makeDriver(proxy.baseUrl, { good: true });
      try {
        await expect(driver.poll()).rejects.toBeInstanceOf(UnreachableError);
      } finally {
        await driver.close();
        await proxy.close();
      }
    });

    it("maps every researched raw status to its common status, silently", () => {
      const lines: string[] = [];
      for (const [raw, expected] of c.statusTable) {
        expect([raw, c.mapStatus(raw, m => lines.push(m))]).toEqual([raw, expected]);
      }
      expect(lines).toEqual([]);
    });

    it("maps an unknown raw status to queued and names it in a debug line", () => {
      const lines: string[] = [];
      expect(c.mapStatus(c.unknownStatus, m => lines.push(m))).toBe("queued");
      expect(lines.join("\n")).toContain(String(c.unknownStatus));
    });

    it("polls a complete snapshot with valid statuses and units (unknown = null)", async () => {
      const d = c.makeDriver(server.baseUrl, { good: true });
      const s = await d.poll();
      expect(s.complete).toBe(true);
      expect(typeof s.status.version).toBe("string");
      expect(unknownOrNonNegative(s.status.downloadBps)).toBe(true);
      expect(s.items.length).toBeGreaterThan(0);
      for (const i of s.items) {
        expect(STATUSES).toContain(i.status);
        expect(typeof i.key === "string" && i.key.length > 0).toBe(true);
        for (const v of [i.sizeBytes, i.doneBytes, i.speedBps, i.etaSeconds, i.uploadBps]) {
          expect(unknownOrNonNegative(v)).toBe(true);
        }
        expect(i.ratio === RATIO_INFINITE || unknownOrNonNegative(i.ratio)).toBe(true);
      }
      await d.close();
    });

    it("sends exactly the expected request for each offered command and refuses the others", async () => {
      const d = c.makeDriver(server.baseUrl, { good: true });
      const key = (await d.poll()).items[0].key;
      for (const kind of Object.keys(COMMAND_CAPABILITY) as CommandKind[]) {
        const offered = d.capabilities.has(COMMAND_CAPABILITY[kind]);
        const expected = c.commandCalls[kind];
        if (!offered) {
          await expect(d.command(sample(kind, key)), kind).rejects.toThrow(ProtocolError);
          continue;
        }
        expect(expected, `capability of ${kind} without an expected request`).toBeDefined();
        const from = server.calls.length;
        await d.command(sample(kind, key));
        const made = server.calls.slice(from).filter(call => !c.isLoginCall(call));
        expect(
          made.some(
            call =>
              call.method === expected?.method &&
              call.path === expected.path &&
              (!expected.bodyContains || `${call.query}\n${call.body}`.includes(expected.bodyContains)),
          ),
          `${kind}: ${JSON.stringify(made.map(m => [m.method, m.path, m.query, m.body]))}`,
        ).toBe(true);
      }
      await d.close();
    });

    it("gives up after ONE rejected login with an AuthError", async ({ skip }) => {
      if (c.noLogin) {
        skip();
      }
      const d = c.makeDriver(server.baseUrl, { good: false });
      await expect(d.poll()).rejects.toThrow(AuthError);
      expect(server.calls.filter(c.isLoginCall)).toHaveLength(1);
      await d.close();
    });

    it("logs in again once and repeats the call when the session expired", async ({ skip }) => {
      if (!server.expireSession) {
        skip();
      }
      const d = c.makeDriver(server.baseUrl, { good: true });
      await d.poll();
      server.expireSession?.();
      const s = await d.poll();
      expect(s.complete).toBe(true);
      expect(server.calls.filter(c.isLoginCall)).toHaveLength(2);
      await d.close();
    });

    // fleet suite C26b (network hook, section 7): an answer whose JSON drifted deletes no download — each answer of a
    // clean poll drifted on its own, the driver refuses it or keeps every download
    it("refuses a drifted answer instead of losing a download or the version", async () => {
      const clean = c.makeDriver(server.baseUrl, { good: true });
      const from = server.calls.length;
      const before = await clean.poll();
      const calls = server.calls.length - from;
      await clean.close();
      const keys = before.items.map(i => i.key);
      for (let n = 0; n < calls; n++) {
        const proxy = await startDriftProxy(server.baseUrl, n);
        const d = c.makeDriver(proxy.baseUrl, { good: true });
        try {
          let last: ProgramSnapshot | null = null;
          for (let poll = 0; poll < 3; poll++) {
            try {
              last = await d.poll();
            } catch {
              last = null;
              continue;
            }
            const kept = new Set(last.items.map(i => i.key));
            expect(
              last.complete ? keys.filter(k => !kept.has(k)) : [],
              `answer ${n} drifted, poll ${poll}: downloads a complete snapshot lost`,
            ).toEqual([]);
          }
          expect(last?.status.version, `answer ${n} drifted: the version of the last poll`).toBe(before.status.version);
        } finally {
          await d.close();
          await proxy.close();
        }
      }
    });

    it("reports a poll with a failed secondary list as incomplete instead of failing", async ({ skip }) => {
      if (!server.failSublist) {
        skip();
      }
      const d = c.makeDriver(server.baseUrl, { good: true });
      server.failSublist?.();
      const s = await d.poll();
      expect(s.complete).toBe(false);
      await d.close();
    });
  });
}
