// RQBit in the container recorder: the official image (FROM scratch, runs as root) with HTTP basic auth, a second rqbit
// as the seeder — rqbit reads no web seed (BEP 19), so the downloads come from a peer: the seeder holds the payloads,
// limits its upload so a download stays running, and the recorded rqbit gets it as `initial_peers`. Routes from
// crates/librqbit/src/http_api/handlers/mod.rs (v9.1.0), the add parameters from http_api_types.rs.
import { lookup } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEAD_MAGNET,
  Http,
  peer as leecher,
  prepareTorrents,
  Recorder,
  TRANSFER_LIMIT_DOWN,
  TRANSFER_LIMIT_UP,
  TRANSFER_MIN,
  torrentOf,
  waitFor,
} from "../lib.mjs";

const USER = "admin";
const PASS = "testpass1";
const DOWNLOADS = "/home/rqbit/downloads";
/** An empty folder mounted read-only: a torrent added into it cannot create its file. */
const READ_ONLY = "/ro";
/** The seeder's upload limit: 1 MiB/s keeps the 32 MiB download running for half a minute. */
const SEED_BPS = 1024 * 1024;
/** rqbit's `mbps` is MiB per second (its `human_readable` says "MiB/s"). */
const MIB = 1024 * 1024;

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
    sidecars: [
      { name: "rqseed", image, volumes: [`${join(work, "seed")}:/seed`], args: ["server", "start", "/seed"] },
      leecher(work),
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
  // until `transfer` is recorded the seeder sends at the transfer limit — rqbit 8.1.1 has no readable limits of its own
  await seed.req("POST", "/torrents/limits", { json: { upload_bps: TRANSFER_LIMIT_DOWN, download_bps: null } });
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
  /** @typedef {{ mbps?: number }} RqSpeed a speed of rqbit */
  /** @typedef {{ info_hash: string, stats?: { state?: string, finished?: boolean, live?: { download_speed?: RqSpeed, upload_speed?: RqSpeed, time_remaining?: { duration?: { secs?: number } } | null } | null } }} RqLive a torrent with its live stats */
  /** @type {(state: string) => Promise<{ torrents: RqLive[], stats: { download_speed?: RqSpeed, upload_speed?: RqSpeed } }>} records one state, returns what it recorded */
  const snapshot = async state => {
    const torrents = await get("/torrents?with_stats=true");
    w(state, "torrents", "GET /torrents?with_stats=true", torrents);
    const stats = await get("/stats");
    w(state, "stats", "GET /stats", stats);
    w(state, "limits", "GET /torrents/limits", await get("/torrents/limits"));
    return {
      torrents: /** @type {{ torrents?: RqLive[] }} */ (torrents.json()).torrents ?? [],
      stats: /** @type {{ download_speed?: RqSpeed, upload_speed?: RqSpeed }} */ (stats.json()),
    };
  };
  const add = (name, peers) =>
    post(
      `/torrents?overwrite=true&output_folder=${encodeURIComponent(DOWNLOADS)}${peers ? `&initial_peers=${peer}` : ""}`,
      { body: torrentOf(ctx.work, name).torrent },
    );

  await snapshot("empty");
  // the limits of `transfer` (B/s), set before `big` starts — it still loads when the peer leeches `check`
  await post("/torrents/limits", { json: { download_bps: TRANSFER_LIMIT_DOWN, upload_bps: TRANSFER_LIMIT_UP } });
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
  // a torrent paused while it is checked: 9.1.0 takes the pause during `initializing` (torrent_state/mod.rs), 8.1.1
  // refuses it — the answer, the list right after and, when it was taken, the list once the check ended; then it starts
  // again for the states below
  const pauseChecking = await post(`/torrents/${hash("check")}/pause`);
  w("commands", "torrent-pause-checking", `POST /torrents/${hash("check")}/pause (while checking)`, pauseChecking);
  console.log(`rqbit: pause while checking answered ${pauseChecking.status}`);
  await snapshot("checking-paused");
  if (pauseChecking.status === 200) {
    const after = new Set();
    await waitFor(
      "check ended paused",
      async () => {
        const st = (await find(hash("check")))?.stats?.state;
        after.add(st);
        return st !== "initializing";
      },
      180_000,
    ).catch(err => console.log(`rqbit: ${err.message} — recorded as it is`));
    console.log(`rqbit: states after the pause while checking: ${[...after].join(", ")}`);
    await snapshot("checked-paused");
    w(
      "commands",
      "torrent-start-checked",
      `POST /torrents/${hash("check")}/start`,
      await post(`/torrents/${hash("check")}/start`),
    );
  }
  await waitFor(
    "mixed states",
    async () => {
      const [s, d, c] = await Promise.all(["stopped", "done", "check"].map(n => find(hash(n))));
      return s?.stats?.state === "paused" && d?.stats?.finished && c?.stats?.finished;
    },
    180_000,
  );
  await snapshot("running");

  // transfer: the running state while the peer leeches `check` (through the seed server's tracker) and `big` still
  // loads — every speed the fixture hook plays tells its unit (≥ TRANSFER_MIN), `big` has a time left; the state is
  // recorded until the recorded answers carry that
  let samples = 0;
  await waitFor(
    "transfer recorded",
    async () => {
      const shot = await snapshot("transfer");
      const big = shot.torrents.find(t => t.info_hash === hash("big"))?.stats;
      const check = shot.torrents.find(t => t.info_hash === hash("check"))?.stats;
      const bigDown = (big?.live?.download_speed?.mbps ?? 0) * MIB;
      const checkUp = (check?.live?.upload_speed?.mbps ?? 0) * MIB;
      const left = big?.live?.time_remaining?.duration?.secs ?? 0;
      const down = (shot.stats.download_speed?.mbps ?? 0) * MIB;
      const up = (shot.stats.upload_speed?.mbps ?? 0) * MIB;
      console.log(
        `rqbit transfer sample ${++samples}: big ${big?.state}/${Math.round(bigDown)}/${left} check ${check?.state}/${Math.round(checkUp)} session ${Math.round(down)}/${Math.round(up)}`,
      );
      return (
        big?.state === "live" &&
        !big.finished &&
        bigDown >= TRANSFER_MIN &&
        left > 0 &&
        checkUp >= TRANSFER_MIN &&
        down >= TRANSFER_MIN &&
        up >= TRANSFER_MIN
      );
    },
    180_000,
    1000,
  );
  await post("/torrents/limits", { json: { download_bps: null, upload_bps: null } });
  await seed.req("POST", "/torrents/limits", { json: { upload_bps: SEED_BPS, download_bps: null } });

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
