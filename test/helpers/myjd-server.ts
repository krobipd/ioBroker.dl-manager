import { createHash } from "node:crypto";
import { jdDecrypt, jdEncrypt, jdSecret, jdSign } from "../../src/lib/programs/jdownloader/cloud";
import type { ContractServer } from "./contract";
import { startFixtureServer, type FixtureAnswer, type RecordedCall } from "./fixture-server";

/** Answers a device call (`/<ns>/<method>` with its decoded parameters) with the `data` it returns. */
export type DeviceHandler = (path: string, params: unknown[]) => unknown;

/** A My.JDownloader server in the test: real signatures and AES, one account, one device. */
export interface MyJdServer extends ContractServer {
  /** The next device call answers TOKEN_INVALID once. */
  expireSession(): void;
  /** Session tokens handed out so far. */
  sessions: string[];
}

/**
 * @param opts account and device
 * @param opts.email account e-mail
 * @param opts.password account password
 * @param opts.deviceName the device's name in the account
 * @param opts.handler answers device calls
 * @returns the running server; recorded device calls carry the decrypted path and body
 */
export async function startMyJdServer(opts: {
  email: string;
  password: string;
  deviceName: string;
  handler: DeviceHandler;
}): Promise<MyJdServer> {
  const login = jdSecret(opts.email, opts.password, "server");
  const device = jdSecret(opts.email, opts.password, "device");
  const sessions: string[] = [];
  let serverToken: Buffer | null = null;
  let deviceToken: Buffer | null = null;
  let expire = false;
  let lastRid = 0;
  const newSession = (): { sessiontoken: string; regaintoken: string } => {
    const sessiontoken = createHash("sha256").update(`s${sessions.length}`).digest("hex").slice(0, 32);
    sessions.push(sessiontoken);
    serverToken = createHash("sha256")
      .update(Buffer.concat([serverToken ?? login, Buffer.from(sessiontoken, "hex")]))
      .digest();
    deviceToken = createHash("sha256")
      .update(Buffer.concat([device, Buffer.from(sessiontoken, "hex")]))
      .digest();
    return { sessiontoken, regaintoken: `r${sessions.length}` };
  };
  const failure = (status: number, type: string): FixtureAnswer => ({ status, body: { src: "MYJD", type } });
  const signed = (call: RecordedCall, key: Buffer): boolean => {
    const i = call.query.lastIndexOf("&signature=");
    return (
      i > 0 && jdSign(key, `${call.path}?${call.query.slice(0, i)}`) === call.query.slice(i + "&signature=".length)
    );
  };
  const s = await startFixtureServer(call => {
    const q = new URLSearchParams(call.query);
    const rid = Number(q.get("rid") ?? 0);
    if (call.path === "/my/connect") {
      if (!signed(call, login)) {
        return failure(403, "AUTH_FAILED");
      }
      serverToken = null;
      return { body: jdEncrypt(login, JSON.stringify({ ...newSession(), rid })) };
    }
    if (call.path === "/my/reconnect") {
      if (!serverToken || !signed(call, serverToken)) {
        return failure(403, "AUTH_FAILED");
      }
      const key = serverToken;
      return { body: jdEncrypt(key, JSON.stringify({ ...newSession(), rid })) };
    }
    if (call.path === "/my/listdevices") {
      if (!serverToken || !signed(call, serverToken)) {
        return failure(403, "TOKEN_INVALID");
      }
      return {
        body: jdEncrypt(
          serverToken,
          JSON.stringify({ list: [{ id: "dev1", name: opts.deviceName, type: "jd" }], rid }),
        ),
      };
    }
    const m = /^\/t_([0-9a-f]+)_dev1(\/.+)$/.exec(call.path);
    if (!m || !deviceToken || m[1] !== sessions.at(-1)) {
      return failure(403, "TOKEN_INVALID");
    }
    if (expire) {
      expire = false;
      return failure(403, "TOKEN_INVALID");
    }
    const req = JSON.parse(jdDecrypt(deviceToken, call.body)) as { url: string; params: unknown[]; rid: number };
    if (req.rid <= lastRid) {
      return failure(400, "BAD_PARAMETERS");
    }
    lastRid = req.rid;
    // the recorded call shows what the adapter asked, not the ciphertext
    call.path = req.url;
    call.body = JSON.stringify(req);
    const params = req.params.map(p => {
      try {
        return typeof p === "string" ? (JSON.parse(p) as unknown) : p;
      } catch {
        return p;
      }
    });
    return { body: jdEncrypt(deviceToken, JSON.stringify({ data: opts.handler(req.url, params), rid: req.rid })) };
  });
  return {
    ...s,
    sessions,
    expireSession: () => {
      expire = true;
    },
  };
}
