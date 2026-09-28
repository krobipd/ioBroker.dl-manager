// aria2 in the container recorder: Alpine's aria2 package (no official image; the package is installed in the
// default network, then the container joins the internal one), JSON-RPC with a secret token, HTTP downloads from the
// throttled seed server. The tag is the Alpine release. api-usenet-aria2-pyload.md § 3.
import { join } from "node:path";
import { DEAD_MAGNET, Http, prepareHttpFiles, Recorder, waitFor } from "../lib.mjs";

const SECRET = "testsecret1";

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag Alpine release
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  prepareHttpFiles(work);
  return {
    image: `alpine:${tag}`,
    name: "aria2",
    internet: true,
    volumes: [`${join(work, "downloads")}:/downloads`],
    args: [
      "sh",
      "-c",
      [
        "apk add --no-cache aria2 >/dev/null",
        `exec aria2c --enable-rpc --rpc-listen-all=true --rpc-listen-port=6800 --rpc-secret=${SECRET}`,
        "--dir=/downloads --max-concurrent-downloads=1 --enable-dht=false --bt-enable-lpd=false",
        "--enable-peer-exchange=false --file-allocation=none",
      ].join(" "),
    ],
  };
}

/**
 * Recorder side.
 *
 * @param {object} _ctx paths (unused)
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(_ctx) {
  const http = new Http("http://aria2:6800");
  let seq = 0;
  /**
   * @param {string} method RPC method
   * @param {unknown[]} params params after the token
   * @param {string} [secret] token
   * @returns {Promise<{ status: number, text: string, headers: Record<string,string>, json: () => Record<string, unknown>, sent: string }>} answer
   */
  const rpc = async (method, params = [], secret = SECRET) => {
    const body = { jsonrpc: "2.0", id: String(++seq), method, params: [`token:${secret}`, ...params] };
    const res = await http.req("POST", "/jsonrpc", { json: body });
    return { ...res, sent: JSON.stringify(body).replace(secret, "<secret>") };
  };
  const result = async (method, params) => (await rpc(method, params)).json().result;
  await waitFor("aria2 RPC", async () => (await rpc("aria2.getVersion")).status === 200, 300_000, 1000);

  const versionRes = await rpc("aria2.getVersion");
  const rec = new Recorder("aria2", String(versionRes.json().result.version));
  const w = (state, name, res) => rec.write(state, name, `POST /jsonrpc ${res.sent}`, res);
  w("auth", "token-wrong", await rpc("aria2.getVersion", [], "wrong"));
  w("auth", "version", versionRes);

  const snapshot = async state => {
    w(state, "tell-active", await rpc("aria2.tellActive"));
    w(state, "tell-waiting", await rpc("aria2.tellWaiting", [0, 1000]));
    w(state, "tell-stopped", await rpc("aria2.tellStopped", [0, 1000]));
    w(state, "global-stat", await rpc("aria2.getGlobalStat"));
    w(state, "global-option", await rpc("aria2.getGlobalOption"));
  };
  const status = async gid => (await result("aria2.tellStatus", [gid, ["status", "errorCode"]]))?.status;
  const add = (name, options = {}) => rpc("aria2.addUri", [[`http://seed:8080/${name}.bin`], options]);

  await snapshot("empty");

  // complete, then error (404)
  const smallRes = await add("small");
  w("commands", "add-uri", smallRes);
  const small = smallRes.json().result;
  await waitFor("small complete", async () => (await status(small)) === "complete", 60_000);
  const missing = (await rpc("aria2.addUri", [["http://seed:8080/missing.bin"]])).json().result;
  await waitFor("missing error", async () => (await status(missing)) === "error", 60_000);
  await snapshot("finished-and-failed");

  // running: one active (1 MiB/s), one waiting (max 1 concurrent), one added paused
  const big = (await add("big")).json().result;
  const queued = (await add("queued")).json().result;
  const stoppedRes = await add("stopped", { pause: "true" });
  w("commands", "add-uri-paused", stoppedRes);
  const stopped = stoppedRes.json().result;
  await waitFor("big active", async () => (await status(big)) === "active" && (await status(queued)) === "waiting");
  await snapshot("running");

  // single pause/unpause
  w("commands", "pause", await rpc("aria2.pause", [queued]));
  await waitFor("queued paused", async () => (await status(queued)) === "paused");
  await snapshot("item-paused");
  w("commands", "unpause", await rpc("aria2.unpause", [queued]));

  // global pause (aria2 has no global flag — pauseAll pauses what exists)
  w("commands", "pause-all", await rpc("aria2.pauseAll"));
  await waitFor("all paused", async () => (await status(big)) === "paused");
  await snapshot("paused-all");
  w("commands", "unpause-all", await rpc("aria2.unpauseAll"));

  // limits
  w(
    "commands",
    "change-global-option",
    await rpc("aria2.changeGlobalOption", [{ "max-overall-download-limit": "2M", "max-overall-upload-limit": "500K" }]),
  );
  await snapshot("limited");
  await rpc("aria2.changeGlobalOption", [{ "max-overall-download-limit": "0", "max-overall-upload-limit": "0" }]);

  // loading torrent metadata: a magnet nobody seeds, started past the queue
  await rpc("aria2.changeGlobalOption", [{ "max-concurrent-downloads": "5" }]);
  const magnetRes = await rpc("aria2.addUri", [[DEAD_MAGNET]]);
  w("commands", "add-uri-magnet", magnetRes);
  const magnet = magnetRes.json().result;
  await waitFor("magnet active", async () => (await status(magnet)) === "active");
  await snapshot("metadata");
  await rpc("aria2.forceRemove", [magnet]);

  // finish, then remove (status "removed") and drop the result
  await waitFor("big complete", async () => (await status(big)) === "complete", 180_000, 1000);
  w("commands", "remove", await rpc("aria2.remove", [stopped]));
  await waitFor("stopped removed", async () => (await status(stopped)) === "removed");
  await snapshot("finished");
  w("commands", "remove-download-result", await rpc("aria2.removeDownloadResult", [missing]));
  return rec;
}
