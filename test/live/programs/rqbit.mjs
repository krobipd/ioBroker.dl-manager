// RQBit in the container recorder: the official image (FROM scratch, runs as root) with HTTP basic auth, a second rqbit
// as the seeder — rqbit reads no web seed (BEP 19), so the downloads come from a peer: the seeder holds the payloads,
// limits its upload so a download stays running, and the recorded rqbit gets it as `initial_peers`. Routes from
// crates/librqbit/src/http_api/handlers/mod.rs (v9.1.0), the add parameters from http_api_types.rs.
import { lookup } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEAD_MAGNET, Http, prepareTorrents, Recorder, torrentOf, waitFor } from "../lib.mjs";

const USER = "admin";
const PASS = "testpass1";
const DOWNLOADS = "/home/rqbit/downloads";
/** An empty folder mounted read-only: a torrent added into it cannot create its file. */
const READ_ONLY = "/ro";
/** The seeder's upload limit: 1 MiB/s keeps the 32 MiB download running for half a minute. */
const SEED_BPS = 1024 * 1024;

/**
 * One torrent of `GET /torrents?with_stats=true` as far as the recorder reads it.
 *
 * @typedef {{ info_hash: string, stats?: { state: string, finished: boolean, progress_bytes: number, error?: string | null, live?: { snapshot?: { peer_stats?: { live?: number } } } | null } }} RqTorrent
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
  mkdirSync(join(work, "ro"), { recursive: true });
  const image = `ikatson/rqbit:${tag}`;
  return {
    image,
    name: "rq",
    env: { RQBIT_HTTP_BASIC_AUTH_USERPASS: `${USER}:${PASS}` },
    volumes: [`${join(work, "downloads")}:${DOWNLOADS}`, `${join(work, "ro")}:${READ_ONLY}:ro`],
    sidecars: [{ name: "rqseed", image, volumes: [`${join(work, "seed")}:/seed`], args: ["server", "start", "/seed"] }],
  };
}

/**
 * Recorder side.
 *
 * @param {{ work: string }} ctx paths
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(ctx) {
  const auth = pass => ({ authorization: `Basic ${Buffer.from(`${USER}:${pass}`).toString("base64")}` });
  const rq = new Http("http://rq:3030");
  const seed = new Http("http://rqseed:3030");
  const get = path => rq.req("GET", path, { headers: auth(PASS) });
  const post = (path, o = {}) => rq.req("POST", path, { ...o, headers: { ...auth(PASS), ...o.headers } });
  await waitFor("rqbit API", async () => (await get("/").catch(() => ({ status: 0 }))).status === 200, 180_000);
  await waitFor("seeder API", async () => (await seed.req("GET", "/").catch(() => ({ status: 0 }))).status === 200);

  const root = await get("/");
  const version = String(/** @type {{ version: string }} */ (root.json()).version);
  const rec = new Recorder("rqbit", version);
  rec.write("auth", "root-no-auth", "GET / (no basic auth)", await rq.req("GET", "/"));
  rec.write(
    "auth",
    "root-wrong",
    "GET / (basic auth, wrong password)",
    await rq.req("GET", "/", { headers: auth("x") }),
  );
  rec.write("auth", "root", "GET / (basic auth)", root);
  const w = (state, name, request, res) => rec.write(state, name, request, res);

  // the seeder: the three payloads it holds, upload held at SEED_BPS
  for (const name of ["big", "queued", "stopped"]) {
    const res = await seed.req("POST", "/torrents?overwrite=true&output_folder=/seed", {
      body: torrentOf(ctx.work, name).torrent,
    });
    if (res.status !== 200) {
      throw new Error(`seeder refused ${name}: ${res.status} ${res.text.slice(0, 200)}`);
    }
  }
  await seed.req("POST", "/torrents/limits", { json: { upload_bps: SEED_BPS, download_bps: null } });
  /**
   * @param {Http} http one of the two rqbit instances
   * @returns {Promise<RqTorrent[]>} its torrents with their stats
   */
  const torrentsOf = async http =>
    /** @type {{ torrents: RqTorrent[] }} */ (
      (await http.req("GET", "/torrents?with_stats=true", { headers: auth(PASS) })).json()
    ).torrents;
  const seedList = () => torrentsOf(seed);
  await waitFor("seeder ready", async () => (await seedList()).every(t => t.stats?.finished), 120_000);
  const peer = `${(await lookup("rqseed", { family: 4 })).address}:4240`;

  const list = () => torrentsOf(rq);
  const find = async h => (await list()).find(t => t.info_hash === h);
  const hash = name => torrentOf(ctx.work, name).hash;
  const snapshot = async state => {
    w(state, "torrents", "GET /torrents?with_stats=true", await get("/torrents?with_stats=true"));
    w(state, "stats", "GET /stats", await get("/stats"));
    w(state, "limits", "GET /torrents/limits", await get("/torrents/limits"));
  };
  const add = (name, peers) =>
    post(
      `/torrents?overwrite=true&output_folder=${encodeURIComponent(DOWNLOADS)}${peers ? `&initial_peers=${peer}` : ""}`,
      { body: torrentOf(ctx.work, name).torrent },
    );

  await snapshot("empty");
  w(
    "commands",
    "torrents-post-file",
    "POST /torrents?overwrite=true&output_folder=… (.torrent bytes)",
    await add("big", true),
  );
  await waitFor(
    "big downloading",
    async () => {
      const t = await find(hash("big"));
      return t?.stats?.state === "live" && t.stats.progress_bytes > 0 && !t.stats.finished;
    },
    120_000,
  );
  await add("queued", true);
  await add("stopped", true);
  w(
    "commands",
    "torrent-pause",
    `POST /torrents/${hash("stopped")}/pause`,
    await post(`/torrents/${hash("stopped")}/pause`),
  );
  for (const name of ["done", "check"]) {
    await add(name, false);
  }
  // checking: the 1 GiB payload is still hashed while the next answer is read
  const seen = new Set();
  await waitFor(
    "check initializing",
    async () => {
      const st = (await find(hash("check")))?.stats?.state;
      seen.add(st);
      return st === "initializing";
    },
    30_000,
    20,
  ).catch(err => {
    throw new Error(`${err.message} — states seen: ${[...seen].join(", ")}`);
  });
  await snapshot("checking");
  await waitFor(
    "mixed states",
    async () => {
      const [s, d, c] = await Promise.all(["stopped", "done", "check"].map(n => find(hash(n))));
      return s?.stats?.state === "paused" && d?.stats?.finished && c?.stats?.finished;
    },
    180_000,
  );
  await snapshot("running");

  // a magnet nobody seeds: rqbit resolves the metadata inside the POST (up to 600 s) — what the list shows meanwhile;
  // the recorder's own deadline ends the POST, so its "answer" is no recording
  const magnet = post("/torrents?overwrite=true", { body: DEAD_MAGNET }).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 3000));
  await snapshot("metadata");
  await magnet;

  // waiting: the seeder forgets "stopped", then it starts again — live, bytes left, no peer, nothing coming in. Not
  // every run reaches it (a peer may still be connected); what the list shows is recorded either way.
  await seed.req("POST", `/torrents/${hash("stopped")}/forget`, { headers: auth(PASS) });
  w(
    "commands",
    "torrent-start",
    `POST /torrents/${hash("stopped")}/start`,
    await post(`/torrents/${hash("stopped")}/start`),
  );
  await waitFor(
    "stopped without peers",
    async () => {
      const s = (await find(hash("stopped")))?.stats;
      return s?.state === "live" && !s.finished && s.live?.snapshot?.peer_stats?.live === 0;
    },
    30_000,
  ).catch(err => console.log(`rqbit: ${err.message} — recorded as it is`));
  await snapshot("stalled");

  // a torrent whose file cannot be created (read-only folder): rqbit refuses the add with 400 and its reason, the list
  // never shows it — no recording reaches the error state, its rows come from the source (TorrentStatsState::Error)
  w(
    "commands",
    "torrents-post-readonly",
    "POST /torrents?overwrite=true&output_folder=/ro (.torrent bytes, read-only folder)",
    await post(`/torrents?overwrite=true&output_folder=${encodeURIComponent(READ_ONLY)}`, {
      body: torrentOf(ctx.work, "gone").torrent,
    }),
  );

  // completed: a finished torrent paused
  await post(`/torrents/${hash("done")}/pause`);
  await waitFor("done paused", async () => (await find(hash("done")))?.stats?.state === "paused");
  await snapshot("completed");
  await post(`/torrents/${hash("done")}/start`);

  // limits in bytes per second, null = unlimited (limits.rs LimitsConfig)
  w(
    "commands",
    "limits-set",
    "POST /torrents/limits",
    await post("/torrents/limits", { json: { download_bps: 2048000, upload_bps: 512000 } }),
  );
  await snapshot("limited");
  w(
    "commands",
    "limits-clear",
    "POST /torrents/limits",
    await post("/torrents/limits", { json: { download_bps: null, upload_bps: null } }),
  );

  // seeding: the big download finishes and stays live
  await waitFor("big finished", async () => (await find(hash("big")))?.stats?.finished, 240_000, 1000);
  await snapshot("finished");

  // remove one, keep its files
  w(
    "commands",
    "torrent-forget",
    `POST /torrents/${hash("queued")}/forget`,
    await post(`/torrents/${hash("queued")}/forget`),
  );
  w("commands", "torrent-unknown", "POST /torrents/<unknown>/pause", await post(`/torrents/${"0".repeat(40)}/pause`));
  return rec;
}
