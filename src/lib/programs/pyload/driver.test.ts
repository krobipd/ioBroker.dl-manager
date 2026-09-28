import { runDriverContract, type ContractServer } from "../../../../test/helpers/contract";
import { startFixtureServer } from "../../../../test/helpers/fixture-server";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { UnreachableError } from "../../core/errors";
import type { ProgramConfig } from "../registry";
import { PyDriver } from "./driver";
import { mapPyStatus, statusTable } from "./map";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const cfg = (base: string, apiKey = "good"): ProgramConfig => {
  const u = new URL(base);
  return {
    type: "pyload",
    key: "",
    name: "",
    host: u.hostname,
    port: Number(u.port),
    https: false,
    path: "",
    username: "",
    password: "",
    apiKey,
    device: "",
  };
};

/**
 * pyLoad from the recordings: `X-API-Key` decides; reads by function name.
 *
 * @param opts server behaviour
 * @param opts.limited answer 429 (rate limit)
 */
async function pyServer(opts: { limited?: boolean } = {}): Promise<ContractServer> {
  const f = (state: string, name: string): { status: number; body: unknown } => {
    const r = loadFixture("pyload", "0.5.0", state, name);
    // a recorded JSON string ("0.5.0") goes out as JSON again, not as plain text
    const json = typeof r.body === "string" && r.headers?.["content-type"]?.includes("json");
    return { status: r.status, body: json ? JSON.stringify(r.body) : r.body };
  };
  return startFixtureServer(call => {
    if (call.headers["x-api-key"] !== "good") {
      return f("auth", "key-wrong");
    }
    if (opts.limited) {
      return { status: 429, body: { error: "Too many requests" } };
    }
    const fn = call.path.replace(/^\/api\//, "");
    if (fn === "get_server_version") {
      return f("auth", "version");
    }
    if (fn === "get_config_value") {
      return { body: new URLSearchParams(call.query).get("option") === "limit_speed" ? false : -1 };
    }
    if (call.method === "GET") {
      return f("running", fn.replace(/_/g, "-"));
    }
    return { body: null };
  });
}

runDriverContract({
  type: "pyload",
  server: () => pyServer(),
  makeDriver: (base, creds) => new PyDriver(cfg(base, creds.good ? "good" : "bad"), { ...timers, log }),
  mapStatus: mapPyStatus,
  statusTable,
  unknownStatus: 99,
  commandCalls: {
    pauseAll: { method: "POST", path: "/api/pause_server" },
    resumeAll: { method: "POST", path: "/api/unpause_server" },
    remove: { method: "POST", path: "/api/delete_packages", bodyContains: '"package_ids":[1]' },
    add: { method: "POST", path: "/api/add_package", bodyContains: '"links":["magnet:' },
    setSpeedLimit: {
      method: "POST",
      path: "/api/set_config_value",
      bodyContains: '"option":"limit_speed","value":true',
    },
  },
  isLoginCall: call => call.headers["x-api-key"] === "bad",
});

describe("pyLoad driver", () => {
  it("calls pyLoad's rate limit a passing state, not a login error", async () => {
    const s = await pyServer({ limited: true });
    try {
      await expect(new PyDriver(cfg(s.baseUrl), { ...timers, log }).poll()).rejects.toThrow(UnreachableError);
    } finally {
      await s.close();
    }
  });

  it("reads the speed limit only every tenth poll", async () => {
    const s = await pyServer();
    try {
      const d = new PyDriver(cfg(s.baseUrl), { ...timers, log });
      for (let i = 0; i < 11; i++) {
        await d.poll();
      }
      expect(s.calls.filter(c => c.path === "/api/get_config_value")).toHaveLength(4);
    } finally {
      await s.close();
    }
  });
});
