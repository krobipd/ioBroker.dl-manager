import { runDriverContract } from "../../../../test/helpers/contract";
import { loadFixture } from "../../../../test/helpers/fixtures";
import { startMyJdServer, type MyJdServer } from "../../../../test/helpers/myjd-server";
import { AuthError, ProtocolError, UnreachableError } from "../../core/errors";
import type { ProgramConfig } from "../registry";
import { adaptParams, JdCloudTransport, jdDecrypt, jdSecret, jdSign, jdTokens } from "./cloud";
import { JdDriver } from "./driver";
import { mapJdStatus, statusTable } from "./map";

const timers = {
  setTimeout: (cb: () => void, ms: number): ioBroker.Timeout =>
    globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
  clearTimeout: (t: ioBroker.Timeout | undefined): void =>
    globalThis.clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
};
const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const EMAIL = "Test@Example.com";
const PASSWORD = "secret-pw";

describe("My.JDownloader crypto — against values computed with Python hashlib/hmac and openssl", () => {
  it("derives the account secrets and the session tokens", () => {
    const login = jdSecret(EMAIL, PASSWORD, "server");
    const device = jdSecret(EMAIL, PASSWORD, "device");
    expect(login.toString("hex")).toBe("477ab518b9521f1d010036be4879c0735f9bad3f146f8a7c32df0cba9151e566");
    expect(device.toString("hex")).toBe("03f20d28e1fe69d21b98155a1982ed2a030a3986862a2718a98a394e261da724");
    const t = jdTokens(login, device, "a1b2c3d4e5f60718293a4b5c6d7e8f90");
    expect(t.server.toString("hex")).toBe("34a557dc277e4fec4e0c9d22d58813cc242b5f0e0b6138bced1fe2ca8b3654aa");
    expect(t.device.toString("hex")).toBe("380b4a39ab32ad4c6340f22a3c47d227680228b4fc5b3405a64b67d7b71d1eb2");
  });

  it("signs a server query with HMAC-SHA256 and decrypts AES-128-CBC made by openssl", () => {
    const login = Buffer.from("477ab518b9521f1d010036be4879c0735f9bad3f146f8a7c32df0cba9151e566", "hex");
    expect(
      jdSign(login, "/my/connect?email=test%40example.com&appkey=ioBroker.download-manager&rid=1700000000000"),
    ).toBe("58a35d1c26a07b00b764ea4fbb02d231a855d9166b5a6bfd2a761a3786bc5a5a");
    const device = Buffer.from("380b4a39ab32ad4c6340f22a3c47d227680228b4fc5b3405a64b67d7b71d1eb2", "hex");
    expect(
      jdDecrypt(device, "28LpYOnFj1+wm0+EWA6ZyP2PVpDxHjFuSdHkP0hgT3TOef2Aj/AsKfSnTqLeyN6RJUna2oJLMjQ+Pr/HMbp/fw=="),
    ).toBe('{"apiVer":1,"url":"/jd/version","params":[],"rid":42}');
  });

  it("sends parameters the way myjdapi does: strings as they are, everything else as a JSON string", () => {
    expect(adaptParams([false, [], [1790633501919], { a: true }, "x", null])).toEqual([
      "false",
      [],
      ["1790633501919"],
      '{"a":true}',
      "x",
      null,
    ]);
  });
});

const READS: Record<string, [string, string]> = {
  "/jd/version": ["auth", "jd-version"],
  "/toolbar/getStatus": ["running", "toolbar-get-status"],
  "/downloadsV2/queryPackages": ["running", "query-packages"],
  "/downloadsV2/queryLinks": ["running", "query-links"],
};
const recorded = (path: string): unknown => {
  const r = READS[path];
  return r ? (loadFixture("jdownloader", "48637", r[0], r[1]).body as { data: unknown }).data : true;
};
const cfg = (base: string, password = PASSWORD, device = "PC"): ProgramConfig => ({
  type: "jdownloader-cloud",
  key: "",
  name: "",
  host: "",
  port: 0,
  https: false,
  path: base,
  username: EMAIL,
  password,
  apiKey: "",
  device,
});
const serve = (): Promise<MyJdServer> =>
  startMyJdServer({ email: EMAIL, password: PASSWORD, deviceName: "PC", handler: recorded });
const cloud = (base: string, password = PASSWORD, device = "PC"): JdDriver =>
  new JdDriver(
    cfg(base, password, device),
    { ...timers, log },
    new JdCloudTransport(cfg(base, password, device), timers, base),
    null,
  );

runDriverContract({
  type: "jdownloader-cloud",
  server: serve,
  makeDriver: (base, creds) => cloud(base, creds.good ? PASSWORD : "wrong"),
  mapStatus: mapJdStatus,
  statusTable,
  unknownStatus: "FinalLinkState:SOMETHING_NEW",
  commandCalls: {
    pauseAll: { method: "POST", path: "/downloadcontroller/stop" },
    resumeAll: { method: "POST", path: "/downloadcontroller/start" },
    pause: { method: "POST", path: "/downloadsV2/setEnabled", bodyContains: '"params":["false",[],["1790633501919"]]' },
    resume: { method: "POST", path: "/downloadsV2/setEnabled", bodyContains: '"params":["true",[],["1790633501919"]]' },
    remove: { method: "POST", path: "/downloadsV2/removeLinks", bodyContains: '"params":[[],["1790633501919"]]' },
    add: { method: "POST", path: "/linkgrabberv2/addLinks", bodyContains: "autostart" },
    setSpeedLimit: { method: "POST", path: "/config/set", bodyContains: '"DownloadSpeedLimit","2000000"' },
  },
  isLoginCall: call => call.path === "/my/connect" || call.path === "/my/reconnect",
});

describe("JDownloader over My.JDownloader", () => {
  it("names the program type jdownloader-cloud and asks the cloud at most every 30 s", () => {
    const d = cloud("http://127.0.0.1:1");
    expect(d.type).toBe("jdownloader-cloud");
    expect(d.minIntervalMs).toBe(30_000);
    expect(d.subscribe(() => undefined)).toBeTypeOf("function");
  });

  it("calls a device name the account does not know a protocol error that lists the known ones", async () => {
    const s = await serve();
    try {
      await expect(cloud(s.baseUrl, PASSWORD, "Laptop").poll()).rejects.toThrow(/Laptop.*PC/);
      await expect(cloud(s.baseUrl, PASSWORD, "Laptop").poll()).rejects.toThrow(ProtocolError);
    } finally {
      await s.close();
    }
  });

  it("rejects wrong account data with a login error", async () => {
    const s = await serve();
    try {
      await expect(cloud(s.baseUrl, "wrong").poll()).rejects.toThrow(AuthError);
    } finally {
      await s.close();
    }
  });

  it("reconnects with the regain token on TOKEN_INVALID and never reuses a request id", async () => {
    const s = await serve();
    try {
      const d = cloud(s.baseUrl);
      await d.poll();
      s.expireSession();
      const snap = await d.poll();
      expect(snap.items.length).toBeGreaterThan(0);
      expect(s.calls.filter(c => c.path === "/my/reconnect")).toHaveLength(1);
      expect(s.sessions).toHaveLength(2);
    } finally {
      await s.close();
    }
  });
});

describe("My.JDownloader failures", () => {
  it("keeps working over two expired sessions in a row", async () => {
    const s = await serve();
    try {
      const d = cloud(s.baseUrl);
      await d.poll();
      s.expireSession();
      await d.poll();
      s.expireSession();
      expect((await d.poll()).items.length).toBeGreaterThan(0);
      expect(s.calls.filter(c => c.path === "/my/reconnect")).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it("reads an encrypted TOKEN_INVALID and logs in afresh when the reconnect is refused as well", async () => {
    const s = await serve();
    try {
      const d = cloud(s.baseUrl);
      await d.poll();
      s.faults.encryptErrors = true;
      s.faults.reconnect = { status: 403, type: "TOKEN_INVALID" };
      s.expireSession();
      expect((await d.poll()).items.length).toBeGreaterThan(0);
      expect(s.calls.filter(c => c.path === "/my/connect")).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it("gives every failure of the service its error kind", async () => {
    const cases: [(f: MyJdServer["faults"]) => void, unknown][] = [
      [f => (f.connect = { status: 403, type: "ERROR_EMAIL_NOT_CONFIRMED" }), AuthError],
      [f => (f.connect = { status: 401, type: "" }), AuthError],
      [f => (f.connect = { status: 403, type: "MAINTENANCE" }), UnreachableError],
      [f => (f.noToken = true), /without session token/],
      [f => (f.devices = [{ name: "PC" }]), /not found/],
      [f => (f.device = { status: 403, type: "AUTH_FAILED" }), AuthError],
      [f => (f.device = { status: 403, type: "OFFLINE" }), /device is offline/],
    ];
    for (const [fault, err] of cases) {
      const s = await serve();
      try {
        fault(s.faults);
        const got: unknown = await cloud(s.baseUrl)
          .poll()
          .then(
            () => "resolved",
            (e: unknown) => e,
          );
        if (err instanceof RegExp) {
          expect(String(got)).toMatch(err);
        } else {
          expect(got).toBeInstanceOf(err as typeof Error);
        }
      } finally {
        await s.close();
      }
    }
  });
});

describe("My.JDownloader device that appears later (final review I4)", () => {
  it("looks for the device again on the next poll", async () => {
    const s = await serve();
    try {
      s.faults.devices = [];
      const d = cloud(s.baseUrl);
      await expect(d.poll()).rejects.toThrow(/not found/);
      delete s.faults.devices;
      expect((await d.poll()).items.length).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });

  it("logs in afresh after the device list itself failed", async () => {
    const s = await serve();
    try {
      s.faults.listdevices = { status: 503, type: "MAINTENANCE" };
      const d = cloud(s.baseUrl);
      await expect(d.poll()).rejects.toThrow(UnreachableError);
      delete s.faults.listdevices;
      expect((await d.poll()).items.length).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });
});
