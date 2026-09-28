import { AuthError, ProtocolError } from "../../src/lib/core/errors";
import { HttpClient, type HttpResponse, type HttpTimers } from "../../src/lib/core/http";
import type {
  Capability,
  Command,
  DownloadItem,
  ProgramDriver,
  ProgramSnapshot,
  Status,
} from "../../src/lib/core/model";
import type { ContractServer } from "./contract";
import { startFixtureServer } from "./fixture-server";

/**
 * A minimal download program for the contract suite: login with a session cookie, a list of downloads, one
 * secondary list (categories), four commands. Its only purpose is to prove the suite catches what it must.
 */

const RAW: Readonly<Record<string, Status>> = {
  q: "queued",
  dl: "downloading",
  stop: "paused",
  done: "completed",
  err: "failed",
};

/**
 * @param raw the fake program's status
 * @param debug debug log
 * @returns the common status
 */
export function mapFakeStatus(raw: string | number, debug: (msg: string) => void): Status {
  const s = typeof raw === "string" ? RAW[raw] : undefined;
  if (!s) {
    debug(`fake: unknown status "${raw}" — shown as queued`);
    return "queued";
  }
  return s;
}

const timers: HttpTimers = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: t => globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};

/** The driver of the fake program. */
export class FakeProgramDriver implements ProgramDriver {
  public readonly type = "fake";
  public readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "globalPause",
    "itemPause",
    "itemRemove",
    "add",
    "category",
  ]);
  public readonly extras = [];
  private readonly http = new HttpClient(timers, { timeoutMs: 2000 });
  private loggedIn = false;

  /**
   * @param base server URL
   * @param user login user
   * @param pass login password
   */
  public constructor(
    private readonly base: string,
    private readonly user: string,
    private readonly pass: string,
  ) {}

  /** @returns one complete query */
  public async poll(): Promise<ProgramSnapshot> {
    const status = (await this.api("GET", "/status")).json() as { version: string; paused: boolean; speed: number };
    const raw = (await this.api("GET", "/items")).json() as {
      id: string;
      name: string;
      state: string;
      size: number;
      done: number;
      speed: number;
      eta: number;
    }[];
    let categories: Record<string, string> | null = null;
    try {
      const res = await this.api("GET", "/categories");
      categories = res.status === 200 ? (res.json() as Record<string, string>) : null;
    } catch {
      categories = null;
    }
    const items: DownloadItem[] = raw.map(r => ({
      key: r.id,
      name: r.name,
      status: mapFakeStatus(r.state, () => undefined),
      sizeBytes: r.size,
      doneBytes: r.done,
      speedBps: r.speed,
      etaSeconds: r.eta < 0 ? null : r.eta,
      category: categories?.[r.id] ?? "",
      error: "",
    }));
    return {
      status: { version: status.version, paused: status.paused, downloadBps: status.speed },
      items,
      complete: categories !== null,
    };
  }

  /** @param cmd the command */
  public async command(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "pauseAll":
        await this.api("POST", "/pause", {});
        return;
      case "resumeAll":
        await this.api("POST", "/resume", {});
        return;
      case "pause":
        await this.api("POST", "/pause", { id: cmd.key });
        return;
      case "resume":
        await this.api("POST", "/resume", { id: cmd.key });
        return;
      case "remove":
        await this.api("POST", "/remove", { id: cmd.key });
        return;
      case "add":
        await this.api("POST", "/add", { url: cmd.url });
        return;
      default:
        throw new ProtocolError(`fake: ${cmd.kind} is not supported`);
    }
  }

  /** Nothing to release. */
  public close(): Promise<void> {
    return Promise.resolve();
  }

  private async login(): Promise<void> {
    this.http.clearCookies();
    const res = await this.http.request({
      method: "POST",
      url: `${this.base}/login`,
      form: { user: this.user, pass: this.pass },
    });
    if (res.status === 403) {
      throw new AuthError("fake: login rejected");
    }
    this.loggedIn = true;
  }

  private async api(method: "GET" | "POST", path: string, json?: unknown): Promise<HttpResponse> {
    if (!this.loggedIn) {
      await this.login();
    }
    let res = await this.http.request({ method, url: `${this.base}${path}`, json });
    if (res.status === 403) {
      this.loggedIn = false;
      await this.login();
      res = await this.http.request({ method, url: `${this.base}${path}`, json });
    }
    if (res.status >= 500 && path !== "/categories") {
      throw new ProtocolError(`fake: HTTP ${res.status}`);
    }
    return res;
  }
}

/** @returns the fake program's server with the contract hooks */
export async function startFakeProgram(): Promise<ContractServer> {
  let expire = false;
  let failCategories = false;
  const s = await startFixtureServer(call => {
    if (call.path === "/login") {
      return call.body === "user=admin&pass=good"
        ? { body: "Ok.", headers: { "set-cookie": "SID=s1; HttpOnly" } }
        : { status: 403, body: "Fails." };
    }
    if (call.headers.cookie !== "SID=s1" || expire) {
      expire = false;
      return { status: 403, body: "Forbidden" };
    }
    switch (call.path) {
      case "/status":
        return { body: { version: "1.2.3", paused: false, speed: 1_048_576 } };
      case "/items":
        return {
          body: [
            {
              id: "a1b2c3d4e5",
              name: "Ubuntu ISO",
              state: "dl",
              size: 4_000_000_000,
              done: 1_000_000_000,
              speed: 1_048_576,
              eta: 2861,
            },
            { id: "f6g7h8i9j0", name: "Backup", state: "done", size: 10, done: 10, speed: 0, eta: -1 },
          ],
        };
      case "/categories":
        if (failCategories) {
          failCategories = false;
          return { status: 500, body: "boom" };
        }
        return { body: { a1b2c3d4e5: "linux" } };
      default:
        return { body: "Ok." };
    }
  });
  return {
    ...s,
    expireSession: () => {
      expire = true;
    },
    failSublist: () => {
      failCategories = true;
    },
  };
}
