// rTorrent in the container recorder: crazymax/rtorrent-rutorrent, XML-RPC through its nginx (port 8000, any path, HTTP
// basic auth from /passwd/rpc.htpasswd). rTorrent reads no web seed (BEP 19), so a second program — rqbit — seeds the
// payloads and rTorrent gets it as a peer with `add_peer` (src/command_download.cc, 0.9.8 and 0.16.x). The image moves a
// finished download to /downloads/complete; the recorder removes that event first, so every file stays where it is.
// The status fields are ruTorrent's (js/rtorrent.js: is_open, d.state, is_active, d.hashing, is_hash_checking,
// d.message) — the driver derives its status from the same ones. For `transfer` rTorrent also seeds the torrent `check`
// to the recording's peer (lib.mjs `peer`).
import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEAD_MAGNET,
  Http,
  peer as leecher,
  prepareTorrents,
  Recorder,
  TORRENT_FILES,
  TRANSFER_MIN,
  torrentOf,
  waitFor,
} from "../lib.mjs";

const USER = "admin";
const PASS = "testpass1";
const DOWNLOADS = "/downloads";
export const SEEDER = "ikatson/rqbit:9.1.0";
/** The seeder's upload limit: 1 MiB/s keeps the 32 MiB download running for half a minute. */
export const SEED_BPS = 1024 * 1024;

/** What one poll of the driver asks for every torrent (`d.multicall2` on the view `main`). */
export const FIELDS = [
  "d.hash=",
  "d.name=",
  "d.state=",
  "d.is_open=",
  "d.is_active=",
  "d.complete=",
  "d.hashing=",
  "d.is_hash_checking=",
  "d.size_bytes=",
  "d.completed_bytes=",
  "d.down.rate=",
  "d.up.rate=",
  "d.up.total=",
  "d.ratio=",
  "d.peers_connected=",
  "d.message=",
  "d.custom1=",
  "d.load_date=",
  "d.timestamp.finished=",
  "d.custom=dlm_held",
];

/** One poll of the driver: the global rates and limits and the torrent list, in one `system.multicall`. */
const POLL = [
  { methodName: "throttle.global_down.rate", params: [""] },
  { methodName: "throttle.global_up.rate", params: [""] },
  { methodName: "throttle.global_down.max_rate", params: [""] },
  { methodName: "throttle.global_up.max_rate", params: [""] },
  { methodName: "d.multicall2", params: ["", "main", ...FIELDS] },
];

// ---- XML-RPC, as small as the recorder needs it ----

/**
 * @param {string} s text
 * @returns {string} escaped for XML
 */
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * @param {unknown} v a parameter
 * @returns {string} its `<value>`
 */
function value(v) {
  if (Buffer.isBuffer(v)) {
    return `<value><base64>${v.toString("base64")}</base64></value>`;
  }
  if (typeof v === "number") {
    // i4 is plain XML-RPC; i8 only where the value needs it (an extension both xmlrpc-c and 0.16's parser read)
    const n = Math.trunc(v);
    return Math.abs(n) < 2 ** 31 ? `<value><i4>${n}</i4></value>` : `<value><i8>${n}</i8></value>`;
  }
  if (Array.isArray(v)) {
    return `<value><array><data>${v.map(value).join("")}</data></array></value>`;
  }
  if (v !== null && typeof v === "object") {
    const members = Object.entries(v).map(([k, m]) => `<member><name>${esc(k)}</name>${value(m)}</member>`);
    return `<value><struct>${members.join("")}</struct></value>`;
  }
  return `<value><string>${esc(String(v))}</string></value>`;
}

/**
 * @param {string} method method name
 * @param {unknown[]} params parameters
 * @returns {string} the request body
 */
export const methodCall = (method, params) =>
  `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params
    .map(p => `<param>${value(p)}</param>`)
    .join("")}</params></methodCall>`;

/** @typedef {{ name: string, children: XmlNode[], text: string }} XmlNode */

/**
 * @param {string} text an XML document
 * @returns {XmlNode} its element tree under a root
 */
function xmlTree(text) {
  /** @type {XmlNode} */
  const root = { name: "#root", children: [], text: "" };
  const stack = [root];
  const decode = s =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&amp;/g, "&");
  for (const m of text.matchAll(/<\?[^>]*\?>|<(\/?)([\w.:-]+)[^>]*?(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[2]) {
      if (m[1]) {
        stack.pop();
      } else {
        /** @type {XmlNode} */
        const node = { name: m[2], children: [], text: "" };
        top.children.push(node);
        if (!m[3]) {
          stack.push(node);
        }
      }
    } else if (m[4] !== undefined) {
      top.text += decode(m[4]);
    }
  }
  return root;
}

/**
 * @param {XmlNode | undefined} v a `<value>`
 * @returns {unknown} its content
 */
function fromValue(v) {
  const t = v?.children[0];
  if (!t) {
    return v?.text ?? null;
  }
  switch (t.name) {
    case "i4":
    case "i8":
    case "int":
    case "double":
      return Number(t.text);
    case "boolean":
      return t.text.trim() === "1";
    case "array":
      return (t.children.find(c => c.name === "data")?.children ?? []).map(fromValue);
    case "struct":
      return Object.fromEntries(
        t.children.map(m => [
          m.children.find(c => c.name === "name")?.text ?? "",
          fromValue(m.children.find(c => c.name === "value")),
        ]),
      );
    case "nil":
      return null;
    default:
      return t.text;
  }
}

/**
 * @param {string} text a `methodResponse`
 * @returns {{ value?: unknown, fault?: unknown }} the result or the fault
 */
export function parseResponse(text) {
  const resp = xmlTree(text).children.find(c => c.name === "methodResponse");
  const fault = resp?.children.find(c => c.name === "fault");
  if (fault) {
    return { fault: fromValue(fault.children[0]) };
  }
  return { value: fromValue(resp?.children.find(c => c.name === "params")?.children[0]?.children[0]) };
}

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag image tag
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  prepareTorrents(work);
  // rTorrent runs as uid 1000 and writes into the folder and the payloads the runner created
  chmodSync(join(work, "downloads"), 0o777);
  for (const [name, f] of Object.entries(TORRENT_FILES)) {
    if (f.present) {
      chmodSync(join(work, "downloads", `${name}.bin`), 0o666);
    }
  }
  mkdirSync(join(work, "passwd"), { recursive: true });
  // the peer's own log of its messages (interested, choke, request), read when `check` does not upload. The peer
  // starts with the first 16 MiB of `check` (zeros, four pieces, found by its integrity check): with nothing it sends no
  // bitfield, and 0.16.25 never queued its `interested` for an upload slot (run 43885023470: the peer said interested,
  // rTorrent's choke queue stayed at queued:0)
  mkdirSync(join(work, "peerlog"), { recursive: true, mode: 0o777 });
  const leech = /** @type {{ volumes: string[], args: string[] }} */ (leecher(work));
  leech.volumes.push(`${join(work, "peerlog")}:/peerlog`);
  leech.args[2] = leech.args[2]
    .replace("mkdir -p /leech &&", "mkdir -p /leech && truncate -s 16M /leech/check.bin &&")
    .replace(
      " /torrents/check.torrent",
      " --check-integrity=true --log=/peerlog/aria2.log --log-level=debug /torrents/check.torrent",
    );
  // nginx reads RFC 2307 `{PLAIN}` entries (ngx_http_auth_basic_module) — a test password needs no hash
  writeFileSync(join(work, "passwd", "rpc.htpasswd"), `${USER}:{PLAIN}${PASS}\n`);
  return {
    image: `crazymax/rtorrent-rutorrent:${tag}`,
    name: "rt",
    volumes: [`${join(work, "downloads")}:${DOWNLOADS}`, `${join(work, "passwd")}:/passwd`],
    sidecars: [
      { name: "rqseed", image: SEEDER, volumes: [`${join(work, "seed")}:/seed`], args: ["server", "start", "/seed"] },
      leech,
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
  const rt = new Http("http://rt:8000");
  const seed = new Http("http://rqseed:3030");
  const basic = pass => ({ authorization: `Basic ${Buffer.from(`${USER}:${pass}`).toString("base64")}` });
  /**
   * @param {string} method method name
   * @param {unknown[]} params parameters
   * @param {string | null} [pass] basic auth password, null = none
   */
  const send = (method, params, pass = PASS) =>
    rt.req("POST", "/RPC2", {
      body: methodCall(method, params),
      headers: { "content-type": "text/xml", ...(pass === null ? {} : basic(pass)) },
    });
  /**
   * @param {string} method method name
   * @param {...unknown} params parameters
   * @returns {Promise<unknown>} the result; a fault throws
   */
  const rpc = async (method, ...params) => {
    const res = await send(method, params);
    const r = parseResponse(res.text);
    if (res.status !== 200 || r.fault) {
      throw new Error(`${method}: HTTP ${res.status} ${JSON.stringify(r.fault ?? res.text.slice(0, 200))}`);
    }
    return r.value;
  };
  await waitFor(
    "rTorrent XML-RPC",
    async () => (await send("system.client_version", [""]).catch(() => ({ status: 0 }))).status === 200,
    180_000,
  );
  await waitFor("seeder API", async () => (await seed.req("GET", "/").catch(() => ({ status: 0 }))).status === 200);

  const version = String(await rpc("system.client_version", ""));
  const rec = new Recorder("rtorrent", version);
  const w = (state, name, request, res) => rec.write(state, name, request, res);
  w(
    "auth",
    "no-auth",
    "POST /RPC2 system.client_version (no basic auth)",
    await send("system.client_version", [""], null),
  );
  w(
    "auth",
    "wrong",
    "POST /RPC2 system.client_version (wrong password)",
    await send("system.client_version", [""], "x"),
  );
  w("auth", "version", "POST /RPC2 system.client_version", await send("system.client_version", [""]));
  w("auth", "list-methods", "POST /RPC2 system.listMethods", await send("system.listMethods", []));
  // the image's move of a finished download (.rtorrent.rc `method.set_key = event.download.finished,move_complete`)
  await rpc("method.set_key", "", "event.download.finished", "move_complete").catch(err =>
    console.log(`rtorrent: ${err.message} — finished downloads may move to /downloads/complete`),
  );

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
  await waitFor(
    "seeder ready",
    async () =>
      /** @type {{ torrents: { stats?: { finished?: boolean } }[] }} */ (
        (await seed.req("GET", "/torrents?with_stats=true")).json()
      ).torrents.every(t => t.stats?.finished),
    120_000,
  );
  const peer = `${(await lookup("rqseed", { family: 4 })).address}:4240`;
  // outgoing handshakes plain: the image tries an encrypted one first (.rtorrent.rc `protocol.encryption.set =
  // allow_incoming,try_outgoing,enable_retry`) and rqbit speaks none — not the cause of 0.9.8's stuck first download
  // (red with and without it), kept so the handshake is one thing less in question
  await rpc("protocol.encryption.set", "", "allow_incoming", "enable_retry");
  // rTorrent's own log of connections and peers, read when the first download does not start (it showed why 0.9.8
  // never connected to the seeder in three runs of four — see `load`)
  const RT_LOG = "rt-debug.log";
  await rpc("log.open_file", "", "dbg", `${DOWNLOADS}/${RT_LOG}`).catch(err =>
    console.log(`rtorrent: log: ${err.message}`),
  );
  for (const group of [
    "connection_debug",
    "peer_debug",
    "torrent_debug",
    "info",
    "peer_choke_queue",
    "peer_list_events",
  ]) {
    await rpc("log.add_output", "", group, "dbg").catch(err => console.log(`rtorrent: log ${group}: ${err.message}`));
  }

  const hash = name => torrentOf(ctx.work, name).hash.toUpperCase();
  /** @returns {Promise<Record<string, Record<string, unknown>>>} every torrent by hash, keyed by field */
  const list = async () => {
    const rows = /** @type {unknown[][]} */ (await rpc("d.multicall2", "", "main", ...FIELDS));
    return Object.fromEntries(
      rows.map(r => [String(r[0]), Object.fromEntries(FIELDS.map((f, i) => [f.replace(/=.*$/, ""), r[i]]))]),
    );
  };
  const find = async name => (await list())[hash(name)];
  const snapshot = async state =>
    w(
      state,
      "poll",
      "POST /RPC2 system.multicall (global rates and limits, d.multicall2 main)",
      await send("system.multicall", [POLL]),
    );
  /**
   * @param {string} name key of TORRENT_FILES
   * @param {boolean} withPeer hand rTorrent the seeder
   * @returns {Promise<{ status: number, text: string }>} the answer of load.raw_start
   */
  const load = async (name, withPeer) => {
    const res = await send("load.raw_start", ["", torrentOf(ctx.work, name).torrent, `d.directory.set=${DOWNLOADS}`]);
    if (withPeer) {
      // the peer only once the start is through: 0.9.8 pauses and resumes a torrent it just loaded before its hash
      // check, drops the handshake begun meanwhile ("Handshake dropped: download inactive", its debug log) and never
      // tries that address again
      await waitFor(
        `${name} started`,
        async () =>
          Boolean(await find(name)) &&
          Number(await rpc("d.is_hash_checked", hash(name))) === 1 &&
          Number(await rpc("d.is_active", hash(name))) === 1,
      );
      await rpc("add_peer", hash(name), peer);
    }
    return res;
  };

  await snapshot("empty");
  w(
    "commands",
    "load-raw-start",
    "POST /RPC2 load.raw_start('', <.torrent>, d.directory.set=…)",
    await load("big", true),
  );
  // the seeder is handed again every 10 s — a second safety net next to the wait for the start in `load`
  let probes = 0;
  await waitFor(
    "big downloading",
    async () => {
      const t = await find("big");
      if (++probes % 20 === 0) {
        await rpc("add_peer", hash("big"), peer).catch(err => console.log(`rtorrent: add_peer again: ${err.message}`));
      }
      return t && Number(t["d.completed_bytes"]) > 0 && Number(t["d.complete"]) === 0;
    },
    120_000,
  ).catch(async err => {
    console.log(`rtorrent: big row ${JSON.stringify(await find("big").catch(e => e.message))}`);
    for (const [label, call] of /** @type {[string, () => Promise<unknown>][]} */ ([
      [
        "peers",
        () => rpc("p.multicall", hash("big"), "", "p.address=", "p.port=", "p.is_encrypted=", "p.is_incoming="),
      ],
      ["not connected", () => rpc("d.peers_not_connected", hash("big"))],
      ["listen port", () => rpc("network.listen.port")],
      ["seeder peers", async () => (await seed.req("GET", "/torrents/0/peer_stats")).text.slice(0, 2000)],
    ])) {
      console.log(`rtorrent: ${label} ${JSON.stringify(await call().catch(e => e.message))}`);
    }
    const log = join(ctx.work, "downloads", RT_LOG);
    console.log(
      `---- rtorrent debug log ----\n${existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-150).join("\n") : "(none)"}`,
    );
    throw err;
  });
  await load("queued", true);
  await load("stopped", true);
  w("commands", "d-stop", `POST /RPC2 d.stop(${hash("stopped")})`, await send("d.stop", [hash("stopped")]));
  await load("done", false);
  await load("check", false);
  // checking: the 1 GiB payload is still hashed while the next answer is read
  const seen = new Set();
  await waitFor(
    "check hashing",
    async () => {
      const t = await find("check");
      seen.add(`${t?.["d.hashing"]}/${t?.["d.is_hash_checking"]}`);
      return Number(t?.["d.is_hash_checking"]) === 1;
    },
    30_000,
    20,
  ).catch(err => {
    throw new Error(`${err.message} — hashing/is_hash_checking seen: ${[...seen].join(", ")}`);
  });
  await snapshot("checking");
  await waitFor(
    "mixed states",
    async () => {
      const [s, d, c] = await Promise.all(["stopped", "done", "check"].map(find));
      return Number(s?.["d.state"]) === 0 && Number(d?.["d.complete"]) === 1 && Number(c?.["d.complete"]) === 1;
    },
    180_000,
  );
  await snapshot("running");

  // a magnet nobody seeds: rTorrent lists it as `<hash>.meta` until it has the metadata
  w("commands", "load-start", "POST /RPC2 load.start('', <magnet>)", await send("load.start", ["", DEAD_MAGNET]));
  await new Promise(resolve => setTimeout(resolve, 3000));
  await snapshot("metadata");

  // waiting: the seeder forgets "stopped", then it starts again — open, active, bytes left, no peer. Not every run
  // reaches it (a peer may still be connected); what the list shows is recorded either way.
  await seed.req("POST", `/torrents/${torrentOf(ctx.work, "stopped").hash}/forget`);
  w("commands", "d-start", `POST /RPC2 d.start(${hash("stopped")})`, await send("d.start", [hash("stopped")]));
  await waitFor(
    "stopped without peers",
    async () => {
      const t = await find("stopped");
      return (
        Number(t?.["d.is_active"]) === 1 && Number(t?.["d.complete"]) === 0 && Number(t?.["d.peers_connected"]) === 0
      );
    },
    30_000,
  ).catch(err => console.log(`rtorrent: ${err.message} — recorded as it is`));
  await snapshot("stalled");

  // missing payload: a complete torrent whose file is gone is checked again
  await load("gone", false);
  await waitFor("gone complete", async () => Number((await find("gone"))?.["d.complete"]) === 1, 60_000);
  rmSync(join(ctx.work, "downloads", "gone.bin"));
  w("commands", "d-check-hash", `POST /RPC2 d.check_hash(${hash("gone")})`, await send("d.check_hash", [hash("gone")]));
  await waitFor(
    "gone checked again",
    async () => {
      const t = await find("gone");
      return t && Number(t["d.hashing"]) === 0 && (Number(t["d.complete"]) === 0 || String(t["d.message"]) !== "");
    },
    60_000,
  ).catch(err => console.log(`rtorrent: ${err.message} — recorded as it is`));
  await snapshot("missing");

  // completed: a finished torrent stopped, then paused the ruTorrent way (open, started, inactive), then closed
  await rpc("d.stop", hash("done"));
  await waitFor("done stopped", async () => Number((await find("done"))?.["d.state"]) === 0);
  await snapshot("completed");
  await rpc("d.start", hash("done"));
  w("commands", "d-pause", `POST /RPC2 d.pause(${hash("done")})`, await send("d.pause", [hash("done")]));
  await waitFor("done paused", async () => Number((await find("done"))?.["d.is_active"]) === 0);
  await snapshot("pausing");
  // does d.start (ruTorrent's unpause) resume a d.pause'd download, or does it need d.resume?
  w(
    "commands",
    "d-start-paused",
    `POST /RPC2 d.start(${hash("done")}) (paused)`,
    await send("d.start", [hash("done")]),
  );
  await waitFor(
    "done active after d.start",
    async () => Number((await find("done"))?.["d.is_active"]) === 1,
    10_000,
  ).catch(err =>
    console.log(`rtorrent: ${err.message} — d.start does not resume a paused download, recorded as it is`),
  );
  await snapshot("unpaused");
  // d.resume on the paused download, and on a stopped one: does it start what d.stop stopped?
  w("commands", "d-resume", `POST /RPC2 d.resume(${hash("done")}) (paused)`, await send("d.resume", [hash("done")]));
  await waitFor(
    "done active after d.resume",
    async () => Number((await find("done"))?.["d.is_active"]) === 1,
    10_000,
  ).catch(err => console.log(`rtorrent: ${err.message} — recorded as it is`));
  await snapshot("resumed");
  await rpc("d.stop", hash("done"));
  await waitFor("done stopped again", async () => Number((await find("done"))?.["d.state"]) === 0);
  w(
    "commands",
    "d-resume-stopped",
    `POST /RPC2 d.resume(${hash("done")}) (stopped)`,
    await send("d.resume", [hash("done")]),
  );
  await new Promise(resolve => setTimeout(resolve, 2000));
  await snapshot("resumed-stopped");
  // d.stop alone leaves a download active that d.resume woke while stopped — d.pause first (a no-op when inactive)
  await rpc("d.pause", hash("done"));
  await rpc("d.stop", hash("done"));
  w("commands", "d-close", `POST /RPC2 d.close(${hash("done")})`, await send("d.close", [hash("done")]));
  await waitFor("done closed", async () => Number((await find("done"))?.["d.is_open"]) === 0);
  await snapshot("closed");
  w(
    "commands",
    "d-start-closed",
    `POST /RPC2 d.start(${hash("done")}) (closed)`,
    await send("d.start", [hash("done")]),
  );
  await waitFor("done open again", async () => Number((await find("done"))?.["d.is_active"]) === 1).catch(err =>
    console.log(`rtorrent: ${err.message} — d.start does not open a closed download`),
  );
  await snapshot("reopened");

  // a hash check stopped halfway: what state, active and hashing say during and after — the global pause stops it?
  w(
    "commands",
    "d-check-hash-check",
    `POST /RPC2 d.check_hash(${hash("check")})`,
    await send("d.check_hash", [hash("check")]),
  );
  await waitFor(
    "check hashing again",
    async () => Number((await find("check"))?.["d.is_hash_checking"]) === 1,
    30_000,
    20,
  );
  w(
    "commands",
    "d-stop-checking",
    `POST /RPC2 d.stop(${hash("check")}) (checking)`,
    await send("d.stop", [hash("check")]),
  );
  await snapshot("check-stopped");
  await waitFor("check settled", async () => Number((await find("check"))?.["d.is_hash_checking"]) === 0, 120_000, 500);
  await snapshot("check-settled");
  await rpc("d.start", hash("check"));

  // limits in bytes per second, 0 = unlimited
  w(
    "commands",
    "limit-down-set",
    "POST /RPC2 throttle.global_down.max_rate.set('', 2048000)",
    await send("throttle.global_down.max_rate.set", ["", 2048000]),
  );
  w(
    "commands",
    "limit-up-set",
    "POST /RPC2 throttle.global_up.max_rate.set('', 512000)",
    await send("throttle.global_up.max_rate.set", ["", 512000]),
  );
  await snapshot("limited");

  // transfer: `limited` once `check` uploads to the recording's peer (it finds rTorrent through the seed server's
  // tracker, and is handed to rTorrent once `check` has hashed again after the stop above — 0.9.8 drops a peer it gets
  // while hashing and never tries it again, run 43885023470), `big` still loads from the seeder — slower than in
  // `limited`, so it loads until the upload runs (the peer is unchoked on rTorrent's 30 s cycle); every rate the fixture
  // hook plays tells its unit (≥ TRANSFER_MIN), the limits stay set (the upload limit 512000 B/s holds the peer's
  // 600 KiB/s above the minimum)
  await rpc("throttle.global_down.max_rate.set", "", 250_000);
  const leech = `${(await lookup("peer", { family: 4 })).address}:6881`;
  let samples = 0;
  let handed = -1;
  await waitFor(
    "transfer recorded",
    async () => {
      const res = await send("system.multicall", [POLL]);
      w("transfer", "poll", "POST /RPC2 system.multicall (global rates and limits, d.multicall2 main)", res);
      const v = /** @type {unknown[][]} */ (parseResponse(res.text).value ?? []);
      const [down, up] = [Number(v[0]?.[0]), Number(v[1]?.[0])];
      const rows = /** @type {unknown[][]} */ (v[4]?.[0] ?? []);
      /** @type {(name: string) => Record<string, unknown> | undefined} a torrent's row of this answer, keyed by field */
      const row = name => {
        const r = rows.find(x => String(x[0]) === hash(name));
        return r && Object.fromEntries(FIELDS.map((f, i) => [f.replace(/=.*$/, ""), r[i]]));
      };
      const [b, c] = [row("big"), row("check")];
      if (Number(c?.["d.complete"]) === 1 && Number(c?.["d.hashing"]) === 0 && (handed < 0 || samples - handed >= 15)) {
        handed = samples;
        await rpc("add_peer", hash("check"), leech).catch(err =>
          console.log(`rtorrent: add_peer check: ${err.message}`),
        );
      }
      console.log(
        `rtorrent transfer sample ${++samples}: global ${down}/${up} big ${b?.["d.complete"]}/${b?.["d.down.rate"]} check ${c?.["d.complete"]}/${c?.["d.hashing"]}/${c?.["d.up.rate"]}/${c?.["d.peers_connected"]}`,
      );
      return (
        down >= TRANSFER_MIN &&
        up >= TRANSFER_MIN &&
        Number(b?.["d.complete"]) === 0 &&
        Number(b?.["d.down.rate"]) >= TRANSFER_MIN &&
        Number(c?.["d.complete"]) === 1 &&
        Number(c?.["d.hashing"]) === 0 &&
        Number(c?.["d.up.rate"]) >= TRANSFER_MIN
      );
    },
    180_000,
    1000,
  ).catch(async err => {
    // run 43882146957: 0.16.25 had the peer connected (aria2: "CN:1 SD:1 DL:0B") and never sent it a byte — 0.9.8 did
    const peerFields = ["p.address=", "p.is_incoming=", "p.is_encrypted=", "p.is_snubbed=", "p.is_preferred="];
    for (const [label, call] of /** @type {[string, () => Promise<unknown>][]} */ ([
      ["check peers", () => rpc("p.multicall", hash("check"), "", ...peerFields, "p.up_rate=", "p.completed_percent=")],
      ["check peers (interest)", () => rpc("p.multicall", hash("check"), "", "p.address=", "p.is_unwanted=")],
      ["check uploads max", () => rpc("d.uploads_max", hash("check"))],
      ["check uploads min", () => rpc("d.uploads_min", hash("check"))],
      ["check group", () => rpc("d.group.name", hash("check"))],
      ["check state", () => rpc("d.state", hash("check"))],
      ["check active", () => rpc("d.is_active", hash("check"))],
      ["check chunks", () => rpc("d.completed_chunks", hash("check"))],
      ["max uploads", () => rpc("throttle.max_uploads", "")],
      ["max uploads global", () => rpc("throttle.max_uploads.global", "")],
      ["choke groups", () => rpc("choke_group.list", "")],
      ["group up max", () => rpc("choke_group.up.max", "", "default")],
      ["group up heuristics", () => rpc("choke_group.up.heuristics", "", "default")],
    ])) {
      console.log(`rtorrent: ${label} ${JSON.stringify(await call().catch(e => e.message))}`);
    }
    const log = join(ctx.work, "downloads", RT_LOG);
    const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
    console.log(
      `---- rtorrent debug log (choke queue) ----\n${lines
        .filter(l => /cycle|choke|unchok|queued/i.test(l))
        .slice(-80)
        .join("\n")}`,
    );
    console.log(`---- rtorrent debug log ----\n${lines.slice(-120).join("\n")}`);
    const peerLog = join(ctx.work, "peerlog", "aria2.log");
    const wire = existsSync(peerLog) ? readFileSync(peerLog, "utf8").split("\n") : ["(none)"];
    console.log(
      `---- peer log (messages) ----\n${wire
        .filter(l => /INTERESTED|CHOKE|REQUEST|BITFIELD|HAVE|handshake|EXTENDED|PIECE|Drop|close|error/i.test(l))
        .slice(-120)
        .join("\n")}`,
    );
    throw err;
  });
  await rpc("throttle.global_down.max_rate.set", "", 0);
  await rpc("throttle.global_up.max_rate.set", "", 0);

  // seeding: the big download finishes and stays active
  await waitFor("big finished", async () => Number((await find("big"))?.["d.complete"]) === 1, 240_000, 1000);
  await snapshot("finished");

  // remove one, keep its files; a command on a hash rTorrent does not know
  w("commands", "d-erase", `POST /RPC2 d.erase(${hash("queued")})`, await send("d.erase", [hash("queued")]));

  // the driver's add while the adapter holds the program paused: loaded stopped and marked, then released by the next
  // poll — d.start and the mark taken off in one multicall — and the metadata arrives after the start. The magnet is
  // the erased "queued", which the seeder still seeds.
  const queuedMagnet = `magnet:?xt=urn:btih:${torrentOf(ctx.work, "queued").hash}&dn=queued.bin`;
  w(
    "commands",
    "load-normal-held",
    "POST /RPC2 load.normal('', <magnet>, d.custom.set=dlm_held,1)",
    await send("load.normal", ["", queuedMagnet, "d.custom.set=dlm_held,1"]),
  );
  await waitFor("held magnet listed", async () => Boolean(await find("queued")), 30_000);
  await new Promise(resolve => setTimeout(resolve, 3000));
  await snapshot("held");
  w(
    "commands",
    "release",
    "POST /RPC2 system.multicall (d.start, d.custom.set dlm_held '')",
    await send("system.multicall", [
      [
        { methodName: "d.start", params: [hash("queued")] },
        { methodName: "d.custom.set", params: [hash("queued"), "dlm_held", ""] },
      ],
    ]),
  );
  await rpc("add_peer", hash("queued"), peer).catch(err =>
    console.log(`rtorrent: add_peer on the magnet: ${err.message}`),
  );
  await waitFor(
    "released magnet has its metadata",
    async () => String((await find("queued"))?.["d.name"]) === "queued.bin",
    60_000,
    500,
  ).catch(err => console.log(`rtorrent: ${err.message} — recorded as it is`));
  await new Promise(resolve => setTimeout(resolve, 3000));
  await snapshot("released");
  // rTorrent builds the torrent anew from the metadata with the commands of the first load — stopped, closed and
  // marked (recording `released`): the next poll of the driver releases it once more
  w(
    "commands",
    "release-again",
    "POST /RPC2 system.multicall (d.start, d.custom.set dlm_held '') on the torrent built from the metadata",
    await send("system.multicall", [
      [
        { methodName: "d.start", params: [hash("queued")] },
        { methodName: "d.custom.set", params: [hash("queued"), "dlm_held", ""] },
      ],
    ]),
  );
  await waitFor(
    "released torrent started",
    async () => Number((await find("queued"))?.["d.state"]) === 1,
    10_000,
  ).catch(err => console.log(`rtorrent: ${err.message} — recorded as it is`));
  await snapshot("rereleased");
  w("commands", "d-unknown", "POST /RPC2 d.stop(<unknown hash>)", await send("d.stop", ["0".repeat(40)]));
  w(
    "commands",
    "multicall-fault",
    "POST /RPC2 system.multicall (one unknown method)",
    await send("system.multicall", [
      [
        { methodName: "throttle.global_down.rate", params: [""] },
        { methodName: "no.such.method", params: [""] },
      ],
    ]),
  );
  return rec;
}
