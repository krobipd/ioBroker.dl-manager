// Tribler in the container recorder: the official image (ghcr.io/tribler/tribler — Ubuntu with the release's .deb,
// user `ubuntu`), headless, started in two steps by tribler-start.sh. Routes from src/tribler/core/libtorrent/restapi/
// downloads_endpoint.py, core/restapi/settings_endpoint.py and core/versioning/restapi/versioning_endpoint.py (v8.0.7,
// v8.4.3). The downloads come from the seed server's web seed (libtorrent reads BEP 19). Every add of the recorder asks
// for 0 hops: the container has no Internet and no Tribler peer to build an anonymous circuit with — except one add in
// the driver's shape ({uri} alone), which shows what a default installation's tunnel settings make of it.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEAD_MAGNET,
  DEAD_MAGNET_HASH,
  Http,
  makeTorrent,
  payload,
  prepareTorrents,
  Recorder,
  TORRENT_FILES,
  torrentOf,
  waitFor,
} from "../lib.mjs";

const KEY = "recorderkey0123456789";
/** CORE_API_PORT — Tribler's own default is a random port (DEFAULT_CONFIG api.http_port 0). */
const PORT = 20100;
const STATE = "/state";
const DOWNLOADS = "/downloads";
/** An empty folder mounted read-only: a download into it fails at its first write. */
const READ_ONLY = "/ro";
/** A second magnet nobody seeds, added in the driver's shape: Tribler's default hops and safe seeding. */
const DEFAULT_MAGNET_HASH = "fedcba9876543210fedcba9876543210fedcba98";
const DEFAULT_MAGNET = `magnet:?xt=urn:btih:${DEFAULT_MAGNET_HASH}&dn=default-hops`;

/**
 * One download of `GET /api/downloads` as far as the recorder reads it.
 *
 * @typedef {{ infohash: string, status: string, progress: number, speed_down: number, size: number }} TrDownload
 */

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag image tag
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  prepareTorrents(work);
  // a download into the read-only folder: its payload on the web seed, its own torrent
  const data = payload(2 * 1024 * 1024, 99);
  writeFileSync(join(work, "seed", "ro.bin"), data);
  const ro = makeTorrent({ name: "ro.bin", data, webseed: "http://seed:8080/ro.bin" });
  writeFileSync(join(work, "torrents", "ro.torrent"), ro.torrent);
  writeFileSync(join(work, "torrents", "ro.hash"), ro.infoHash);
  // Tribler runs as the image's user `ubuntu`: every folder it writes and every payload it opens must be open to it
  for (const dir of ["state", "downloads", "ro"]) {
    mkdirSync(join(work, dir), { recursive: true });
    chmodSync(join(work, dir), 0o777);
  }
  for (const [name, f] of Object.entries(TORRENT_FILES)) {
    if (f.present) {
      chmodSync(join(work, "downloads", `${name}.bin`), 0o666);
    }
  }
  return {
    image: `ghcr.io/tribler/tribler:${tag}`,
    name: "tribler",
    // libtorrent puts peers on a private network into its local peer class, which the session's rate limits do not
    // cover (libtorrent manual, peer classes): on a Docker range the seed server is such a peer and Tribler's limit
    // never bites — on a public-looking range (still `--internal`) it does
    subnet: "11.22.33.0/24",
    entrypoint: "/bin/bash",
    args: ["/live/tribler-start.sh"],
    env: { CORE_API_PORT: String(PORT), CORE_API_KEY: KEY, TSTATEDIR: STATE },
    volumes: [
      `${join(work, "state")}:${STATE}`,
      `${join(work, "downloads")}:${DOWNLOADS}`,
      `${join(work, "ro")}:${READ_ONLY}:ro`,
      `${resolve("test/live/programs")}:/live:ro`,
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
  const tr = new Http(`http://tribler:${PORT}`);
  const headers = { "x-api-key": KEY };
  const get = path => tr.req("GET", path, { headers });
  const json = (method, path, body) => tr.req(method, path, { headers, json: body });
  await waitFor(
    "Tribler API",
    async () => (await get("/api/versioning/versions/current").catch(() => ({ status: 0 }))).status === 200,
    420_000,
    2000,
  );

  const current = await get("/api/versioning/versions/current");
  const version = String(/** @type {{ version: string }} */ (current.json()).version);
  const rec = new Recorder("tribler", version);
  const w = (state, name, request, res) => rec.write(state, name, request, res);
  w("auth", "downloads-no-key", "GET /api/downloads (no key)", await tr.req("GET", "/api/downloads"));
  w(
    "auth",
    "downloads-wrong-key",
    "GET /api/downloads (wrong X-Api-Key)",
    await tr.req("GET", "/api/downloads", { headers: { "x-api-key": "wrong" } }),
  );
  w("auth", "version", "GET /api/versioning/versions/current", current);

  const hash = name => torrentOf(ctx.work, name).hash;
  /** @returns {Promise<TrDownload[]>} every download */
  const list = async () => /** @type {{ downloads: TrDownload[] }} */ ((await get("/api/downloads")).json()).downloads;
  const find = async h => (await list()).find(d => d.infohash === h);
  const statusOf = async h => (await find(h))?.status;
  const snapshot = async state => {
    w(state, "downloads", "GET /api/downloads", await get("/api/downloads"));
    w(state, "settings", "GET /api/settings", await get("/api/settings"));
  };
  /**
   * Waits until every named download of the recorder has its status; a timeout names what was seen last.
   *
   * @param {string} label what is waited for
   * @param {Record<string, string>} want status per torrent name
   * @param {number} timeout milliseconds
   */
  const waitStates = async (label, want, timeout) => {
    let seen = {};
    await waitFor(
      label,
      async () => {
        const all = await list();
        seen = Object.fromEntries(Object.keys(want).map(n => [n, all.find(d => d.infohash === hash(n))?.status]));
        return Object.entries(want).every(([n, st]) => seen[n] === st);
      },
      timeout,
    ).catch(err => {
      throw new Error(`${err.message} — last seen ${JSON.stringify(seen)}`);
    });
  };
  /**
   * @param {string} name torrent of the recorder
   * @param {string} [dest] download folder
   * @returns {ReturnType<Http["req"]>} the answer of the add
   */
  const addFile = (name, dest = DOWNLOADS) =>
    tr.req("PUT", `/api/downloads?anon_hops=0&safe_seeding=false&destination=${encodeURIComponent(dest)}`, {
      // sic: Tribler compares the content type with "applications/x-bittorrent" (downloads_endpoint.py add_download)
      headers: { ...headers, "content-type": "applications/x-bittorrent" },
      body: torrentOf(ctx.work, name).torrent,
    });
  const patch = (h, body) => json("PATCH", `/api/downloads/${h}`, body);

  await snapshot("empty");
  w(
    "commands",
    "put-torrent",
    "PUT /api/downloads?anon_hops=0&safe_seeding=false&destination=… (.torrent bytes)",
    await addFile("big"),
  );
  await waitFor(
    "big downloading",
    async () => {
      const d = await find(hash("big"));
      return d?.status === "DOWNLOADING" && d.progress > 0 && d.progress < 1;
    },
    120_000,
  );
  // limits in bytes per second, 0 = unlimited (download_manager.py set_session_limits → libtorrent's rate limits).
  // 100 KiB/s is far below the seed server's 1 MiB/s, so the download's rate shows whether the unit is bytes — and it
  // keeps the 32 MiB download running until the pause below stops it
  w(
    "commands",
    "settings-limits",
    "POST /api/settings {libtorrent: {max_download_rate, max_upload_rate}}",
    await json("POST", "/api/settings", { libtorrent: { max_download_rate: 102400, max_upload_rate: 51200 } }),
  );
  await new Promise(resolve => setTimeout(resolve, 8000));
  await snapshot("limited");
  await addFile("queued");
  // a stop right after the add — what the adapter's emulated pause does with a download it adds: Tribler has no
  // libtorrent handle yet, so Download.stop only marks the download user_stopped (download.py stop)
  await addFile("stopped");
  w(
    "commands",
    "patch-stop-early",
    `PATCH /api/downloads/${hash("stopped")} {state: stop} (right after its add)`,
    await patch(hash("stopped"), { state: "stop" }),
  );
  await snapshot("added");
  await addFile("done");
  await addFile("check");
  // checking: the 1 GiB payload is still hashed while the next answer is read
  const seen = new Set();
  await waitFor(
    "check hashchecking",
    async () => {
      const st = await statusOf(hash("check"));
      seen.add(st);
      return st === "HASHCHECKING";
    },
    60_000,
    20,
  ).catch(err => console.log(`tribler: ${err.message} — states seen: ${[...seen].join(", ")}, recorded as it is`));
  await snapshot("checking");
  // does the early stop hold once the download has its handle? (download.py on_add_torrent_alert resumes a download
  // without resume data for its check and pauses it after the check)
  await waitFor("early stop held", async () => (await statusOf(hash("stopped"))) === "STOPPED", 30_000).catch(
    async err => console.log(`tribler: ${err.message} — stopped.bin is ${await statusOf(hash("stopped"))}`),
  );
  await snapshot("early-stop");
  if ((await statusOf(hash("stopped"))) !== "STOPPED") {
    w(
      "commands",
      "patch-stop",
      `PATCH /api/downloads/${hash("stopped")} {state: stop}`,
      await patch(hash("stopped"), { state: "stop" }),
    );
  }
  await waitStates("mixed states", { stopped: "STOPPED", done: "SEEDING", check: "SEEDING" }, 180_000);
  await snapshot("running");

  // a magnet nobody seeds, 0 hops: metadata never comes
  w(
    "commands",
    "put-uri",
    "PUT /api/downloads {uri: <magnet>, anon_hops: 0, safe_seeding: false}",
    await json("PUT", "/api/downloads", { uri: DEAD_MAGNET, anon_hops: 0, safe_seeding: false }),
  );
  await waitFor("magnet listed", async () => Boolean(await find(DEAD_MAGNET_HASH)), 30_000);
  // the driver's add: {uri} alone — the installation's download defaults decide hops and safe seeding
  w(
    "commands",
    "put-uri-default",
    "PUT /api/downloads {uri: <magnet>} (the installation's defaults)",
    await json("PUT", "/api/downloads", { uri: DEFAULT_MAGNET }),
  );
  await waitFor("default magnet listed", async () => Boolean(await find(DEFAULT_MAGNET_HASH)), 30_000);
  await new Promise(resolve => setTimeout(resolve, 5000));
  await snapshot("metadata");

  // a download whose folder is read-only: the first piece it writes fails
  w(
    "commands",
    "put-torrent-readonly",
    "PUT /api/downloads?anon_hops=0&safe_seeding=false&destination=/ro (.torrent bytes)",
    await addFile("ro", READ_ONLY),
  );
  await waitFor("ro failed", async () => (await statusOf(hash("ro"))) === "STOPPED_ON_ERROR", 60_000).catch(err =>
    console.log(`tribler: ${err.message} — recorded as it is`),
  );
  await snapshot("error");

  // what the adapter's emulated pause stops and resumes: a download, a seed, a hash check and a magnet
  w(
    "commands",
    "patch-recheck",
    `PATCH /api/downloads/${hash("check")} {state: recheck}`,
    await patch(hash("check"), { state: "recheck" }),
  );
  await waitFor("check rechecking", async () => (await statusOf(hash("check"))) === "HASHCHECKING", 30_000, 20).catch(
    err => console.log(`tribler: ${err.message} — recorded as it is`),
  );
  const halted = [hash("big"), hash("done"), hash("check"), DEAD_MAGNET_HASH];
  for (const h of halted) {
    await patch(h, { state: "stop" });
  }
  await new Promise(resolve => setTimeout(resolve, 2000));
  await snapshot("stopped");
  w(
    "commands",
    "patch-resume",
    `PATCH /api/downloads/${hash("big")} {state: resume}`,
    await patch(hash("big"), { state: "resume" }),
  );
  for (const h of halted.slice(1)) {
    await patch(h, { state: "resume" });
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
  await snapshot("resumed");

  // the limit off again: the big download finishes
  await json("POST", "/api/settings", { libtorrent: { max_download_rate: 0, max_upload_rate: 0 } });

  // seeding: the big download finishes and keeps going
  await waitStates("big finished", { big: "SEEDING" }, 300_000);
  await snapshot("finished");

  // remove one, keep its files; commands on a hash Tribler does not know; an add without uri
  w(
    "commands",
    "delete",
    `DELETE /api/downloads/${hash("queued")} {remove_data: false}`,
    await json("DELETE", `/api/downloads/${hash("queued")}`, { remove_data: false }),
  );
  w(
    "commands",
    "patch-unknown",
    "PATCH /api/downloads/<unknown> {state: stop}",
    await patch("0".repeat(40), { state: "stop" }),
  );
  w(
    "commands",
    "delete-unknown",
    "DELETE /api/downloads/<unknown> {remove_data: false}",
    await json("DELETE", `/api/downloads/${"0".repeat(40)}`, { remove_data: false }),
  );
  w("commands", "put-no-uri", "PUT /api/downloads {}", await json("PUT", "/api/downloads", {}));
  await snapshot("removed");
  return rec;
}
