// aria2 in the container recorder: Alpine's aria2 package (no official image; the package is installed in the
// default network, then the container joins the internal one), JSON-RPC with a secret token, HTTP downloads from the
// throttled seed server. The tag is the Alpine release. api-usenet-aria2-pyload.md § 3. For `transfer` aria2 also
// seeds the torrent `check` to the recording's peer (aria2 uploads only torrents).
import { join } from "node:path";
import {
  DEAD_MAGNET,
  Http,
  peer,
  prepareHttpFiles,
  prepareTorrents,
  Recorder,
  TRANSFER_LIMIT_DOWN,
  TRANSFER_LIMIT_UP,
  TRANSFER_MIN,
  torrentOf,
  waitFor,
} from "../lib.mjs";

const SECRET = "testsecret1";
/**
 * The most a speed of `transfer` can really be: the seed server sends 1 MiB/s, the peer loads at most 600 KiB/s. aria2
 * shows a download's speed of its first second far above it (run 43856921553: 638785000 B/s, upload 32768000 B/s).
 */
const PLAUSIBLE = 1024 * 1024;

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag Alpine release
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  prepareHttpFiles(work);
  prepareTorrents(work, ["check"]);
  return {
    image: `alpine:${tag}`,
    name: "aria2",
    internet: true,
    volumes: [`${join(work, "downloads")}:/downloads`],
    sidecars: [peer(work)],
    args: [
      "sh",
      "-c",
      [
        "apk add --no-cache aria2 >/dev/null &&",
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
 * @param {{ work: string }} ctx paths
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(ctx) {
  const http = new Http("http://aria2:6800");
  let seq = 0;
  /**
   * @param {string} method RPC method
   * @param {unknown[]} params params after the token
   * @param {string} [secret] token
   * @returns {Promise<{ status: number, text: string, headers: Record<string,string>, json: () => unknown, sent: string }>} answer
   */
  const rpc = async (method, params = [], secret = SECRET) => {
    const body = { jsonrpc: "2.0", id: String(++seq), method, params: [`token:${secret}`, ...params] };
    const res = await http.req("POST", "/jsonrpc", { json: body });
    return { ...res, sent: JSON.stringify(body).replace(secret, "<secret>") };
  };
  const result = async (method, params) =>
    /** @type {{ result?: unknown }} */ ((await rpc(method, params)).json()).result;
  /**
   * @param {{ json: () => unknown }} res an addUri answer
   * @returns {string} the GID aria2 gave the download
   */
  const gidOf = res => /** @type {{ result: string }} */ (res.json()).result;
  await waitFor("aria2 RPC", async () => (await rpc("aria2.getVersion")).status === 200, 300_000, 1000);

  const versionRes = await rpc("aria2.getVersion");
  const rec = new Recorder(
    "aria2",
    String(/** @type {{ result: { version: string } }} */ (versionRes.json()).result.version),
  );
  const w = (state, name, res) => rec.write(state, name, `POST /jsonrpc ${res.sent}`, res);
  w("auth", "token-wrong", await rpc("aria2.getVersion", [], "wrong"));
  w("auth", "version", versionRes);

  /** @typedef {{ gid?: string, status?: string, downloadSpeed?: string, uploadSpeed?: string }} AriaEntry a download (numbers come as text) */
  /** @type {(state: string) => Promise<{ active: AriaEntry[], waiting: AriaEntry[], stat: AriaEntry }>} records one state, returns what it recorded */
  const snapshot = async state => {
    const active = await rpc("aria2.tellActive");
    w(state, "tell-active", active);
    const waiting = await rpc("aria2.tellWaiting", [0, 1000]);
    w(state, "tell-waiting", waiting);
    w(state, "tell-stopped", await rpc("aria2.tellStopped", [0, 1000]));
    const stat = await rpc("aria2.getGlobalStat");
    w(state, "global-stat", stat);
    w(state, "global-option", await rpc("aria2.getGlobalOption"));
    return {
      active: /** @type {{ result?: AriaEntry[] }} */ (active.json()).result ?? [],
      waiting: /** @type {{ result?: AriaEntry[] }} */ (waiting.json()).result ?? [],
      stat: /** @type {{ result?: AriaEntry }} */ (stat.json()).result ?? {},
    };
  };
  const status = async gid =>
    /** @type {{ status?: string } | undefined} */ (await result("aria2.tellStatus", [gid, ["status", "errorCode"]]))
      ?.status;
  const add = (name, options = {}) => rpc("aria2.addUri", [[`http://seed:8080/${name}.bin`], options]);

  await snapshot("empty");

  // complete, then error (404)
  const smallRes = await add("small");
  w("commands", "add-uri", smallRes);
  const small = gidOf(smallRes);
  await waitFor("small complete", async () => (await status(small)) === "complete", 60_000);
  const missing = gidOf(await rpc("aria2.addUri", [["http://seed:8080/missing.bin"]]));
  await waitFor("missing error", async () => (await status(missing)) === "error", 60_000);
  await snapshot("finished-and-failed");

  // running: one active, one waiting (max 1 concurrent), one added paused; the limits of `transfer` (B/s) are set
  // before `big` starts, so it still loads when the peer leeches `check`
  await rpc("aria2.changeGlobalOption", [
    {
      "max-overall-download-limit": String(TRANSFER_LIMIT_DOWN),
      "max-overall-upload-limit": String(TRANSFER_LIMIT_UP),
    },
  ]);
  const big = gidOf(await add("big"));
  const queued = gidOf(await add("queued"));
  const stoppedRes = await add("stopped", { pause: "true" });
  w("commands", "add-uri-paused", stoppedRes);
  await waitFor("big active", async () => (await status(big)) === "active" && (await status(queued)) === "waiting");
  await snapshot("running");

  // transfer: the running state while the peer leeches `check` from aria2 and `big` still loads — `check` goes to the
  // front of the queue and gets the second place (`queued` keeps waiting), seeded without a recheck of its 1 GiB; the
  // state is recorded until the recorded answers carry every speed at TRANSFER_MIN
  const checkRes = await rpc("aria2.addTorrent", [
    torrentOf(ctx.work, "check").torrent.toString("base64"),
    [],
    { dir: "/downloads", "bt-seed-unverified": "true", "seed-ratio": "0" },
    0,
  ]);
  const check = gidOf(checkRes);
  await rpc("aria2.changeGlobalOption", [{ "max-concurrent-downloads": "2" }]);
  let samples = 0;
  await waitFor(
    "transfer recorded",
    async () => {
      const shot = await snapshot("transfer");
      const b = shot.active.find(e => e.gid === big);
      const c = shot.active.find(e => e.gid === check);
      console.log(
        `aria2 transfer sample ${++samples}: big ${b?.status}/${b?.downloadSpeed} check ${c?.status}/${c?.uploadSpeed} queued ${shot.waiting.some(e => e.gid === queued) ? "waiting" : "-"} global ${shot.stat.downloadSpeed}/${shot.stat.uploadSpeed}`,
      );
      const real = v => Number(v ?? 0) >= TRANSFER_MIN && Number(v) <= PLAUSIBLE;
      return (
        real(b?.downloadSpeed) &&
        real(c?.uploadSpeed) &&
        shot.waiting.some(e => e.gid === queued) &&
        real(shot.stat.downloadSpeed) &&
        real(shot.stat.uploadSpeed)
      );
    },
    180_000,
    1000,
  );
  // back to the state before: `check` gone without a trace, one place, no limit
  const removed = await rpc("aria2.forceRemove", [check]);
  console.log(`aria2 forceRemove check: ${removed.status} ${removed.text.slice(0, 200)}`);
  // a seeding torrent force-removed reads "complete", not "removed" (runs 43857599965 and 43872646144) — what counts is
  // that `check` is in neither list any more; what tellStatus says on the way goes to the log
  await waitFor(
    "check out of the lists",
    async () => {
      const shot = await Promise.all([rpc("aria2.tellActive"), rpc("aria2.tellWaiting", [0, 1000])]);
      /** @type {(r: { json: () => unknown }) => AriaEntry[]} the entries of a list answer */
      const entries = r => /** @type {{ result?: AriaEntry[] }} */ (r.json()).result ?? [];
      const listed = shot.some(r => entries(r).some(e => e.gid === check));
      const st = await rpc("aria2.tellStatus", [check, ["status", "errorCode"]]);
      console.log(`aria2 check after forceRemove: listed ${listed}, tellStatus ${st.text.slice(0, 160)}`);
      return !listed;
    },
    60_000,
    2000,
  );
  await rpc("aria2.removeDownloadResult", [check]);
  await rpc("aria2.changeGlobalOption", [
    { "max-concurrent-downloads": "1", "max-overall-download-limit": "0", "max-overall-upload-limit": "0" },
  ]);

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
  const magnet = gidOf(magnetRes);
  await waitFor("magnet active", async () => (await status(magnet)) === "active");
  await snapshot("metadata");
  await rpc("aria2.forceRemove", [magnet]);

  // finish, then remove (status "removed") and drop the result
  await waitFor("big complete", async () => (await status(big)) === "complete", 180_000, 1000);
  // unpauseAll released the paused one too — remove a freshly added paused download
  const doomed = gidOf(await add("stopped", { pause: "true" }));
  w("commands", "remove", await rpc("aria2.remove", [doomed]));
  // run 36489750113: after remove, tellStatus never said "removed" — record what it does say, accept both
  await waitFor("doomed gone", async () => {
    const st = await rpc("aria2.tellStatus", [doomed, ["status"]]);
    const answer = /** @type {{ result?: { status?: string }, error?: unknown }} */ (st.json());
    const s = answer.result?.status;
    if (s === "removed" || answer.error) {
      w("commands", "tell-status-after-remove", st);
      return true;
    }
    return false;
  });
  await snapshot("finished");
  w("commands", "remove-download-result", await rpc("aria2.removeDownloadResult", [missing]));
  return rec;
}
