// Flood in the container recorder: jesec/flood in front of one torrent program. The tag is `<flood tag>-<backend>`
// (`4.16.4-qbittorrent`); the backend runs as a sidecar from its own recorder's `prepare`, so it starts with the same
// configuration as when it is recorded alone. Flood normalises every backend into one torrent list, but each backend's
// gateway composes `status[]`, the rates and the limits itself (server/services/<backend>/), so the recordings are kept
// per backend: `test/fixtures/flood/<flood tag>-<backend>/`.
//
// Flood keeps its users in its own database: the first user registers with the backend's connection
// (POST /api/auth/register, shared/schema/Auth.ts `credentialsSchema`), every later login is
// POST /api/auth/authenticate → cookie `jwt`. rTorrent is reached over its SCGI socket, shared with the crazymax image
// through a folder both containers mount; Flood runs under the image's ids (1000) to open it. rTorrent reads no web seed,
// so — as in rtorrent.mjs — rqbit seeds the payloads and rTorrent gets it as a peer over the image's XML-RPC.
import { lookup } from "node:dns/promises";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEAD_MAGNET, Http, makeTorrent, payload, Recorder, torrentOf, waitFor } from "../lib.mjs";
import { prepare as prepareDeluge } from "./deluge.mjs";
import { prepare as prepareQbt } from "./qbittorrent.mjs";
import { methodCall, parseResponse, prepare as prepareRt, SEED_BPS } from "./rtorrent.mjs";
import { prepare as prepareTr } from "./transmission.mjs";

const USER = "admin";
const PASS = "testpass1";
const PORT = 3000;

/** A torrent only the add by URL gets: served by the seed server as a .torrent, never added as a file. */
const LATE = { name: "late", size: 1024 * 1024 };

/**
 * Each backend: its image tag (the newest the recorder records alone), its container from its own recorder and the
 * connection Flood registers (shared/schema/ClientConnectionSettings.ts).
 */
const BACKENDS = {
  rtorrent: {
    tag: "5.3.18-0.16.25",
    prepare: prepareRt,
    connection: { client: "rTorrent", type: "socket", version: 1, socket: "/rtrun/scgi.socket" },
  },
  qbittorrent: {
    tag: "5.2.3-1",
    prepare: prepareQbt,
    connection: {
      client: "qBittorrent",
      type: "web",
      version: 1,
      url: "http://qbt:8080",
      username: USER,
      password: PASS,
    },
  },
  transmission: {
    tag: "4.1.3-r0-ls362",
    prepare: prepareTr,
    connection: {
      client: "Transmission",
      type: "rpc",
      version: 1,
      url: "http://tr:9091/transmission/rpc",
      username: USER,
      password: PASS,
    },
  },
  deluge: {
    tag: "2.2.0-ls383",
    prepare: prepareDeluge,
    connection: {
      client: "Deluge",
      type: "rpc",
      version: 1,
      host: "deluge",
      port: 58846,
      username: "flood",
      password: PASS,
    },
  },
};

/**
 * @param {string} tag `<flood tag>-<backend>`
 * @returns {{ flood: string, backend: keyof typeof BACKENDS }} the parts
 */
function split(tag) {
  const at = tag.lastIndexOf("-");
  const backend = /** @type {keyof typeof BACKENDS} */ (tag.slice(at + 1));
  if (at < 1 || !BACKENDS[backend]) {
    throw new Error(`flood: tag ${tag} is not <flood tag>-<${Object.keys(BACKENDS).join("|")}>`);
  }
  return { flood: tag.slice(0, at), backend };
}

/**
 * Runner side: the backend's container as a sidecar, the late torrent, Flood.
 *
 * @param {string} work work directory on the runner
 * @param {string} tag `<flood tag>-<backend>`
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  const { flood, backend } = split(tag);
  const side = BACKENDS[backend].prepare(work, BACKENDS[backend].tag);
  // the late torrent: payload and .torrent in the seed folder (http://seed:8080/late.torrent), web-seeded
  const data = payload(LATE.size, 90);
  writeFileSync(join(work, "seed", `${LATE.name}.bin`), data);
  const late = makeTorrent({ name: `${LATE.name}.bin`, data, webseed: `http://seed:8080/${LATE.name}.bin` });
  writeFileSync(join(work, "seed", `${LATE.name}.torrent`), late.torrent);
  writeFileSync(join(work, "torrents", `${LATE.name}.torrent`), late.torrent);
  writeFileSync(join(work, "torrents", `${LATE.name}.hash`), late.infoHash);
  const volumes = [...(side.volumes ?? [])];
  const floodVolumes = [];
  if (backend === "rtorrent") {
    const run = join(work, "rtrun");
    mkdirSync(run, { recursive: true });
    chmodSync(run, 0o777);
    volumes.push(`${run}:/var/run/rtorrent`);
    floodVolumes.push(`${run}:/rtrun`);
    // Flood's rTorrent gateway creates the destination in its own file system before every add (rTorrent
    // clientGatewayService.ts `fs.promises.mkdir(destination)`) — the two share the download folder, as they do when
    // Flood starts rTorrent itself
    floodVolumes.push(`${join(work, "downloads")}:/downloads`);
  }
  if (backend === "deluge") {
    // the daemon answers only local clients unless allow_remote; Flood logs in with an account of the auth file
    // (deluge/core/authmanager.py adds localclient beside it). A partial core.conf updates the defaults (config.py).
    const dir = join(work, "deluge");
    writeFileSync(join(dir, "auth"), `flood:${PASS}:10\n`);
    writeFileSync(
      join(dir, "core.conf"),
      `${JSON.stringify({ file: 1, format: 1 })}${JSON.stringify({
        allow_remote: true,
        download_location: "/downloads",
        dht: false,
        lsd: false,
        utpex: false,
        upnp: false,
        natpmp: false,
        max_active_downloading: 1,
        max_active_limit: 20,
        max_active_seeding: 20,
        dont_count_slow_torrents: false,
      })}`,
    );
  }
  return {
    image: `jesec/flood:${flood}`,
    name: "flood",
    ...(backend === "rtorrent" ? { user: "1000:1000" } : {}),
    volumes: floodVolumes,
    args: ["--auth", "default", "--rundir", "/tmp/flood", "--port", String(PORT)],
    sidecars: [...(side.sidecars ?? []), { name: side.name, image: side.image, env: side.env, volumes }],
  };
}

/**
 * rTorrent's part: the seeder and the peer, over the crazymax image's XML-RPC (rtorrent.mjs).
 *
 * @param {{ work: string }} ctx paths
 * @returns {Promise<{ started: (name: string) => Promise<void> }>} hands the seeder to a started torrent
 */
async function rtorrentSide(ctx) {
  const rt = new Http("http://rt:8000");
  const auth = { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}` };
  const rpc = async (method, ...params) => {
    const res = await rt.req("POST", "/RPC2", {
      body: methodCall(method, params),
      headers: { "content-type": "text/xml", ...auth },
    });
    const r = parseResponse(res.text);
    if (res.status !== 200 || r.fault) {
      throw new Error(`${method}: HTTP ${res.status} ${JSON.stringify(r.fault ?? res.text.slice(0, 200))}`);
    }
    return r.value;
  };
  await waitFor("rTorrent XML-RPC", async () => Boolean(await rpc("system.client_version", "")), 180_000);
  await rpc("method.set_key", "", "event.download.finished", "move_complete").catch(err =>
    console.log(`flood/rtorrent: ${err.message} — finished downloads may move to /downloads/complete`),
  );
  await rpc("protocol.encryption.set", "", "allow_incoming", "enable_retry");
  const seed = new Http("http://rqseed:3030");
  await waitFor("seeder API", async () => (await seed.req("GET", "/").catch(() => ({ status: 0 }))).status === 200);
  for (const name of ["big", "queued", "stopped", LATE.name]) {
    const res = await seed.req("POST", "/torrents?overwrite=true&output_folder=/seed", {
      body: torrentOf(ctx.work, name).torrent,
    });
    if (res.status !== 200) {
      throw new Error(`seeder refused ${name}: ${res.status} ${res.text.slice(0, 200)}`);
    }
  }
  await seed.req("POST", "/torrents/limits", { json: { upload_bps: SEED_BPS, download_bps: null } });
  await waitFor(
    "seeder ready",
    async () =>
      /** @type {{ torrents: { stats?: { finished?: boolean } }[] }} */ (
        (await seed.req("GET", "/torrents?with_stats=true")).json()
      ).torrents.every(t => t.stats?.finished),
    120_000,
  );
  const peer = `${(await lookup("rqseed", { family: 4 })).address}:4240`;
  return {
    // the peer only once the start is through (rtorrent.mjs `load`: 0.9.8 drops a handshake begun before)
    started: async name => {
      const h = torrentOf(ctx.work, name).hash.toUpperCase();
      await waitFor(
        `${name} started in rTorrent`,
        async () => Number(await rpc("d.is_hash_checked", h)) === 1 && Number(await rpc("d.is_active", h)) === 1,
      );
      await rpc("add_peer", h, peer);
    },
  };
}

/**
 * Recorder side.
 *
 * @param {{ work: string, tag: string }} ctx paths and the matrix tag
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(ctx) {
  const { flood, backend } = split(ctx.tag);
  const base = `http://flood:${PORT}`;
  const fl = new Http(base);
  await waitFor("Flood", async () => (await fl.req("GET", "/api/auth/verify")).status === 200, 180_000);
  const rec = new Recorder("flood", `${flood}-${backend}`);
  const w = (state, name, request, res) => rec.write(state, name, request, res);
  w("auth", "verify-initial", "GET /api/auth/verify (no user yet)", await fl.req("GET", "/api/auth/verify"));
  const side = backend === "rtorrent" ? await rtorrentSide(ctx) : { started: async () => undefined };

  w(
    "auth",
    "register",
    "POST /api/auth/register {username, password, client: <backend connection>, level: 10}",
    await fl.req("POST", "/api/auth/register", {
      json: { username: USER, password: PASS, client: BACKENDS[backend].connection, level: 10 },
    }),
  );
  const connected = await waitFor(
    "Flood connected to the backend",
    async () => {
      const r = await fl.req("GET", "/api/client/connection-test");
      return r.status === 200 && /** @type {{ isConnected?: boolean }} */ (r.json()).isConnected ? r : null;
    },
    180_000,
    1000,
  );
  w("auth", "connection-test", "GET /api/client/connection-test", connected);
  if (backend === "qbittorrent") {
    // qBittorrent refreshes torrent states every 1.5 s by default (qbittorrent.mjs) — the check of `check` ends between
    // two refreshes, and Flood asks qBittorrent anew on every GET /api/torrents (torrents.ts → fetchTorrentList)
    const qb = new Http("http://qbt:8080");
    const login = await qb.req("POST", "/api/v2/auth/login", { form: { username: USER, password: PASS } });
    if (login.status >= 300) {
      throw new Error(`flood/qbittorrent: login failed: ${login.status} ${login.text}`);
    }
    await qb.req("POST", "/api/v2/app/setPreferences", { form: { json: JSON.stringify({ refresh_interval: 50 }) } });
  }

  const fresh = () => new Http(base);
  w(
    "auth",
    "authenticate-wrong",
    "POST /api/auth/authenticate {username, password: wrong}",
    await fresh().req("POST", "/api/auth/authenticate", { json: { username: USER, password: "wrong" } }),
  );
  w(
    "auth",
    "authenticate-empty",
    "POST /api/auth/authenticate {username: '', password: ''}",
    await fresh().req("POST", "/api/auth/authenticate", { json: { username: "", password: "" } }),
  );
  const api = new Http(base);
  w(
    "auth",
    "authenticate-ok",
    "POST /api/auth/authenticate {username, password}",
    await api.req("POST", "/api/auth/authenticate", { json: { username: USER, password: PASS } }),
  );
  if (!api.cookies.has("jwt")) {
    throw new Error("flood: no jwt cookie after the login");
  }
  w("auth", "torrents-no-cookie", "GET /api/torrents (no cookie)", await fresh().req("GET", "/api/torrents"));
  const forged = fresh();
  forged.cookies.set("jwt", "not-a-token");
  w(
    "auth",
    "torrents-bad-cookie",
    "GET /api/torrents (cookie jwt=not-a-token)",
    await forged.req("GET", "/api/torrents"),
  );
  w("auth", "verify", "GET /api/auth/verify", await api.req("GET", "/api/auth/verify"));
  const openapi = await api.req("GET", "/api/openapi.json");
  let doc;
  try {
    doc = /** @type {{ openapi?: unknown, info?: unknown }} */ (openapi.json());
  } catch {
    doc = undefined;
  }
  // the document describes every route — only what tells the version is kept
  w(
    "auth",
    "openapi",
    doc ? "GET /api/openapi.json (kept: openapi, info)" : "GET /api/openapi.json",
    doc ? { ...openapi, text: JSON.stringify({ openapi: doc.openapi, info: doc.info }) } : openapi,
  );

  /**
   * @param {string} method HTTP method
   * @param {string} path below the server
   * @param {unknown} [json] body
   */
  const call = (method, path, json) => api.req(method, path, json === undefined ? {} : { json });
  const snapshot = async state => {
    w(state, "torrents", "GET /api/torrents", await call("GET", "/api/torrents"));
    w(state, "settings", "GET /api/client/settings", await call("GET", "/api/client/settings"));
  };
  /** @returns {Promise<Record<string, { status?: string[], bytesDone?: number }>>} the torrents by hash */
  const list = async () =>
    /** @type {{ torrents?: Record<string, { status?: string[], bytesDone?: number }> }} */ (
      (await call("GET", "/api/torrents")).json()
    ).torrents ?? {};
  const H = name => torrentOf(ctx.work, name).hash.toUpperCase();
  const statusOf = async name => (await list())[H(name)]?.status ?? [];
  const has = async (name, st) => (await statusOf(name)).includes(st);
  // the payloads lie in /downloads; rTorrent's own default in the crazymax image is another folder (rtorrent.mjs loads
  // with d.directory.set), the other three backends start with /downloads
  const dest = backend === "rtorrent" ? { destination: "/downloads" } : {};
  const addFile = (name, start) =>
    call("POST", "/api/torrents/add-files", {
      files: [torrentOf(ctx.work, name).torrent.toString("base64")],
      start,
      ...dest,
    });
  /**
   * The limits as a whole settings object: Flood's Deluge gateway sends every key of `setClientSettings`, an unsent one
   * as None, and Deluge stores it (state `partial`) — so every limit goes in on top of what GET answered.
   *
   * @param {Record<string, number>} limits throttle keys in B/s
   * @returns {Promise<{ status: number, text: string }>} the answer
   */
  const writeLimits = async limits => {
    const now = /** @type {Record<string, unknown>} */ ((await call("GET", "/api/client/settings")).json());
    return call("PATCH", "/api/client/settings", { ...now, ...limits });
  };
  /**
   * @param {string} label what is awaited
   * @param {() => Promise<unknown>} probe true when there
   * @param {number} ms deadline
   * @param {number} [every] pause between probes
   * @returns {Promise<boolean>} reached — a miss is logged and recorded as it is
   */
  const reach = (label, probe, ms, every) =>
    waitFor(label, probe, ms, every).then(
      () => true,
      async err => {
        console.log(`flood: ${err.message} — recorded as it is; statuses ${JSON.stringify(await list())}`);
        return false;
      },
    );

  await snapshot("empty");
  // limits in B/s as Flood's settings page writes them (shared/types/ClientSettings.ts); each backend converts
  w(
    "commands",
    "settings-limits",
    "PATCH /api/client/settings {...GET /api/client/settings, throttleGlobalDownSpeed: 102400, throttleGlobalUpSpeed: 51200}",
    await writeLimits({ throttleGlobalDownSpeed: 102400, throttleGlobalUpSpeed: 51200 }),
  );
  await snapshot("limited");
  w(
    "commands",
    "settings-unlimited",
    "PATCH /api/client/settings {...GET /api/client/settings, throttleGlobalDownSpeed: 0, throttleGlobalUpSpeed: 0}",
    await writeLimits({ throttleGlobalDownSpeed: 0, throttleGlobalUpSpeed: 0 }),
  );
  await snapshot("unlimited");

  w(
    "commands",
    "add-files",
    "POST /api/torrents/add-files {files: [<.torrent>], start: true}",
    await addFile("big", true),
  );
  await side.started("big");
  await waitFor(
    "big downloading",
    async () => {
      const t = (await list())[H("big")];
      return t && (t.bytesDone ?? 0) > 0 && (t.status ?? []).includes("downloading");
    },
    120_000,
  );
  await addFile("queued", true);
  if (backend === "rtorrent") {
    await side.started("queued");
  }
  w(
    "commands",
    "add-files-stopped",
    "POST /api/torrents/add-files {files: [<.torrent>], start: false}",
    await addFile("stopped", false),
  );
  await addFile("done", true);
  await addFile("gone", true);
  await addFile("check", true);
  w(
    "commands",
    "add-urls-magnet",
    "POST /api/torrents/add-urls {urls: [<magnet>], start: true}",
    await call("POST", "/api/torrents/add-urls", { urls: [DEAD_MAGNET], start: true }),
  );
  w(
    "commands",
    "add-urls-empty",
    "POST /api/torrents/add-urls {urls: [], start: true}",
    await call("POST", "/api/torrents/add-urls", { urls: [], start: true }),
  );
  await reach(
    "mixed states",
    async () =>
      (await has("stopped", "stopped")) &&
      (await has("done", "complete")) &&
      (await has("gone", "complete")) &&
      (await has("check", "complete")),
    180_000,
  );
  await new Promise(resolve => setTimeout(resolve, 3000));
  await snapshot("running");

  // a low limit while big loads: whether the backend takes Flood's B/s as B/s (Deluge's gateway hands the number to
  // Deluge's KiB/s settings unchanged — source only, settings-limits ran on an empty list)
  w(
    "commands",
    "settings-throttle",
    "PATCH /api/client/settings {...GET /api/client/settings, throttleGlobalDownSpeed: 102400, throttleGlobalUpSpeed: 51200}",
    await writeLimits({ throttleGlobalDownSpeed: 102400, throttleGlobalUpSpeed: 51200 }),
  );
  await new Promise(resolve => setTimeout(resolve, 6000));
  await snapshot("throttled");
  await writeLimits({ throttleGlobalDownSpeed: 0, throttleGlobalUpSpeed: 0 });

  w(
    "commands",
    "check-hash",
    "POST /api/torrents/check-hash {hashes: [check]}",
    await call("POST", "/api/torrents/check-hash", { hashes: [H("check")] }),
  );
  await reach("check checking", () => has("check", "checking"), 30_000, 20);
  await snapshot("checking");
  await reach("check complete", async () => !(await has("check", "checking")), 120_000);

  w(
    "commands",
    "stop",
    "POST /api/torrents/stop {hashes: [done]}",
    await call("POST", "/api/torrents/stop", {
      hashes: [H("done")],
    }),
  );
  await reach("done stopped", () => has("done", "stopped"), 30_000);
  await snapshot("completed");
  w(
    "commands",
    "start",
    "POST /api/torrents/start {hashes: [done]}",
    await call("POST", "/api/torrents/start", {
      hashes: [H("done")],
    }),
  );

  // missing payload, the way each backend's own recorder reaches its failed state: qBittorrent an unreadable file and a
  // check, Transmission the file gone, a check and a start, Deluge and rTorrent the file gone and a check
  const gone = join(ctx.work, "downloads", "gone.bin");
  if (backend === "qbittorrent") {
    chmodSync(gone, 0o000);
  } else {
    rmSync(gone);
  }
  await call("POST", "/api/torrents/check-hash", { hashes: [H("gone")] });
  if (backend === "transmission") {
    await call("POST", "/api/torrents/start", { hashes: [H("gone")] });
  }
  await reach(
    "gone failing",
    async () => {
      const st = await statusOf("gone");
      return st.includes("error") || (!st.includes("checking") && !st.includes("complete"));
    },
    60_000,
    200,
  );
  await snapshot("missing");

  await reach("big complete", () => has("big", "complete"), 240_000, 1000);
  await snapshot("finished");

  // added stopped by URL — what the answer names decides whether a held add has a key
  w(
    "commands",
    "add-urls-stopped",
    "POST /api/torrents/add-urls {urls: [http://seed:8080/late.torrent], start: false}",
    await call("POST", "/api/torrents/add-urls", {
      urls: [`http://seed:8080/${LATE.name}.torrent`],
      start: false,
      ...dest,
    }),
  );
  await reach("late listed", async () => Boolean((await list())[H(LATE.name)]), 60_000);
  await snapshot("added-stopped");

  // the emulated pause: stop every torrent not stopped yet, then start exactly these
  const running = Object.entries(await list())
    .filter(([, t]) => !(t.status ?? []).includes("stopped"))
    .map(([h]) => h);
  w(
    "commands",
    "stop-all",
    "POST /api/torrents/stop {hashes: <every running>}",
    await call("POST", "/api/torrents/stop", { hashes: running }),
  );
  await reach(
    "all stopped",
    async () => Object.values(await list()).every(t => (t.status ?? []).includes("stopped")),
    30_000,
  );
  await snapshot("all-stopped");
  w(
    "commands",
    "start-all",
    "POST /api/torrents/start {hashes: <the stopped ones>}",
    await call("POST", "/api/torrents/start", { hashes: running }),
  );
  await new Promise(resolve => setTimeout(resolve, 3000));
  await snapshot("resumed");

  w(
    "commands",
    "delete",
    "POST /api/torrents/delete {hashes: [queued], deleteData: false}",
    await call("POST", "/api/torrents/delete", { hashes: [H("queued")], deleteData: false }),
  );
  await reach("queued gone", async () => !(await list())[H("queued")], 30_000);
  await snapshot("removed");

  const unknown = "F".repeat(40);
  w(
    "commands",
    "stop-unknown",
    "POST /api/torrents/stop {hashes: [unknown]}",
    await call("POST", "/api/torrents/stop", { hashes: [unknown] }),
  );
  w(
    "commands",
    "delete-unknown",
    "POST /api/torrents/delete {hashes: [unknown], deleteData: false}",
    await call("POST", "/api/torrents/delete", { hashes: [unknown], deleteData: false }),
  );
  // Deluge and rTorrent refuse an unknown hash (500) — does the known one in the same list stop anyway?
  w(
    "commands",
    "stop-mixed",
    "POST /api/torrents/stop {hashes: [done, unknown]}",
    await call("POST", "/api/torrents/stop", { hashes: [H("done"), unknown] }),
  );
  await new Promise(resolve => setTimeout(resolve, 3000));
  await snapshot("stop-mixed");
  await call("POST", "/api/torrents/start", { hashes: [H("done")] });

  // last, because it may break the backend: only the two limits, as Flood's API allows (Partial<ClientSettings>)
  w(
    "commands",
    "settings-partial",
    "PATCH /api/client/settings {throttleGlobalDownSpeed: 0, throttleGlobalUpSpeed: 0}",
    await call("PATCH", "/api/client/settings", { throttleGlobalDownSpeed: 0, throttleGlobalUpSpeed: 0 }),
  );
  await snapshot("partial");
  return rec;
}
