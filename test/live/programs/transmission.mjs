// Transmission in the container recorder: linuxserver image with user/password, the 409 session round, RPC in the
// style the version speaks (4.1+: JSON-RPC 2.0 + snake_case, ≤ 4.0: legacy + kebab/camel). api-torrent.md § 2.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEAD_MAGNET,
  DEAD_MAGNET_HASH,
  Http,
  peer,
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
const RPC = "/transmission/rpc";

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag image tag
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  prepareTorrents(work);
  mkdirSync(join(work, "tr"), { recursive: true });
  writeFileSync(
    join(work, "tr", "settings.json"),
    JSON.stringify(
      {
        "dht-enabled": false,
        "pex-enabled": false,
        "lpd-enabled": false,
        "port-forwarding-enabled": false,
        "download-dir": "/downloads",
        "incomplete-dir-enabled": false,
        "download-queue-enabled": true,
        "download-queue-size": 1,
        "rpc-whitelist-enabled": false,
        "rpc-host-whitelist-enabled": false,
      },
      null,
      2,
    ),
  );
  return {
    image: `lscr.io/linuxserver/transmission:${tag}`,
    name: "tr",
    env: { PUID: "1000", PGID: "1000", TZ: "Etc/UTC", USER, PASS, WHITELIST: "", HOST_WHITELIST: "" },
    volumes: [`${join(work, "tr")}:/config`, `${join(work, "downloads")}:/downloads`],
    sidecars: [peer(work)],
  };
}

const LEGACY = {
  torrent_get: "torrent-get",
  torrent_add: "torrent-add",
  torrent_start: "torrent-start",
  torrent_start_now: "torrent-start-now",
  torrent_stop: "torrent-stop",
  torrent_remove: "torrent-remove",
  torrent_verify: "torrent-verify",
  session_get: "session-get",
  session_set: "session-set",
  session_stats: "session-stats",
  free_space: "free-space",
};

const FIELDS_NEW = [
  "id",
  "hash_string",
  "name",
  "status",
  "percent_done",
  "size_when_done",
  "total_size",
  "left_until_done",
  "downloaded_ever",
  "uploaded_ever",
  "rate_download",
  "rate_upload",
  "eta",
  "upload_ratio",
  "added_date",
  "done_date",
  "error",
  "error_string",
  "labels",
  "download_dir",
  "is_finished",
  "is_stalled",
  "metadata_percent_complete",
  "recheck_progress",
  "queue_position",
];
/**
 * Legacy (≤ 4.0) torrent field names: camelCase.
 *
 * @param {string} s snake_case name
 * @returns {string} camelCase name
 */
const camel = s => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

/**
 * Recorder side.
 *
 * @param {{ work: string }} ctx paths
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(ctx) {
  const base = "http://tr:9091";
  const basic = pass => ({ authorization: `Basic ${Buffer.from(`${USER}:${pass}`).toString("base64")}` });
  const probe = new Http(base);
  await waitFor("Transmission RPC", async () => (await probe.req("POST", RPC, { json: {} })).status > 0, 180_000);

  const wrong = await probe.req("POST", RPC, { headers: basic("wrong"), json: { method: "session-get" } });
  const first = await probe.req("POST", RPC, { headers: basic(PASS), json: { method: "session-get" } });
  if (first.status !== 409) {
    throw new Error(`expected the 409 session round, got ${first.status} ${first.text.slice(0, 200)}`);
  }
  const semver = first.headers["x-transmission-rpc-version"];
  const modern = semver !== undefined && Number(semver.split(".")[0]) >= 6;
  let sessionId = first.headers["x-transmission-session-id"];
  const http = new Http(base);
  let seq = 0;

  /**
   * One RPC call in the version's own style; renews the session id once on 409.
   *
   * @param {string} method snake_case method name
   * @param {Record<string, unknown>} params snake_case params (converted for legacy)
   * @returns {Promise<{ status: number, text: string, headers: Record<string,string>, json: () => unknown, sent: string }>} answer
   */
  const rpc = async (method, params = {}) => {
    const legacyParams = Object.fromEntries(
      Object.entries(params).map(([k, v]) => [
        k === "fields" ? k : k.replace(/_/g, "-"),
        k === "fields" ? /** @type {string[]} */ (v).map(camel) : v,
      ]),
    );
    const body = modern
      ? { jsonrpc: "2.0", method, params, id: ++seq }
      : { method: LEGACY[method], arguments: legacyParams, tag: ++seq };
    let res = await http.req("POST", RPC, {
      headers: { ...basic(PASS), "x-transmission-session-id": sessionId },
      json: body,
    });
    if (res.status === 409) {
      sessionId = res.headers["x-transmission-session-id"];
      res = await http.req("POST", RPC, {
        headers: { ...basic(PASS), "x-transmission-session-id": sessionId },
        json: body,
      });
    }
    return { ...res, sent: JSON.stringify(body) };
  };
  const resultOf = res => {
    const j = res.json();
    return modern ? j.result : j.arguments;
  };

  const session = resultOf(await rpc("session_get"));
  const version = String(session.version).split(" ")[0];
  const rec = new Recorder("transmission", version);
  rec.write("auth", "login-wrong", `POST ${RPC} (basic auth, wrong password)`, wrong);
  rec.write("auth", "session-409", `POST ${RPC} (no session id)`, first);
  const w = (state, name, res) => rec.write(state, name, `POST ${RPC} ${res.sent}`, res);

  const torrentGet = () => rpc("torrent_get", { fields: FIELDS_NEW });
  const snapshot = async state => {
    const torrents = await torrentGet();
    w(state, "torrent-get", torrents);
    w(state, "session-get", await rpc("session_get"));
    const stats = await rpc("session_stats");
    w(state, "session-stats", stats);
    w(state, "free-space", await rpc("free_space", { path: "/downloads" }));
    return { torrents: resultOf(torrents).torrents ?? [], stats: resultOf(stats) };
  };
  const list = async () => resultOf(await torrentGet()).torrents;
  const hashKey = modern ? "hash_string" : "hashString";
  const find = async h => (await list()).find(t => t[hashKey] === h);
  const hash = name => torrentOf(ctx.work, name).hash;
  const add = (name, extra = {}) =>
    rpc("torrent_add", {
      metainfo: torrentOf(ctx.work, name).torrent.toString("base64"),
      download_dir: "/downloads",
      ...extra,
    });

  await snapshot("empty");
  // the limits of `transfer`, set before `big` starts (TRANSFER_LIMIT_DOWN; Transmission counts in its speed units)
  const units = resultOf(await rpc("session_get")).units ?? {};
  const kilo = Number(units.speed_bytes ?? units["speed-bytes"] ?? 1000);
  await rpc("session_set", {
    speed_limit_down: Math.round(TRANSFER_LIMIT_DOWN / kilo),
    speed_limit_down_enabled: true,
    speed_limit_up: Math.round(TRANSFER_LIMIT_UP / kilo),
    speed_limit_up_enabled: true,
  });
  w("commands", "torrent-add-metainfo", await add("big"));
  await waitFor("big downloading", async () => (await find(hash("big")))?.status === 4, 120_000);
  await add("queued");
  await add("stopped", { paused: true });
  for (const name of ["done", "gone", "check"]) {
    await add(name);
  }
  w("commands", "torrent-add-magnet", await rpc("torrent_add", { filename: DEAD_MAGNET, download_dir: "/downloads" }));
  await rpc("torrent_verify", { ids: [hash("done"), hash("gone"), hash("check")] });
  await waitFor(
    "mixed states",
    async () => {
      const [q, s, d, c] = await Promise.all(["queued", "stopped", "done", "check"].map(n => find(hash(n))));
      return q?.status === 3 && s?.status === 0 && d?.status === 6 && c?.status === 6;
    },
    180_000,
  );
  await snapshot("running");

  // transfer: the running state while the peer leeches `check` and `big` still loads — every speed the fixture hook
  // plays tells its unit (≥ TRANSFER_MIN), `big` has a time left; the state is recorded until the recorded answer
  // itself satisfies that (the rates move between two reads)
  const rateKey = modern ? ["rate_download", "rate_upload"] : ["rateDownload", "rateUpload"];
  const statsKey = modern ? ["download_speed", "upload_speed"] : ["downloadSpeed", "uploadSpeed"];
  let samples = 0;
  await waitFor(
    "transfer recorded",
    async () => {
      const shot = await snapshot("transfer");
      const big = shot.torrents.find(t => t[hashKey] === hash("big"));
      const check = shot.torrents.find(t => t[hashKey] === hash("check"));
      const st = shot.stats ?? {};
      console.log(
        `transmission transfer sample ${++samples}: big ${big?.status}/${big?.[rateKey[0]]}/${big?.eta} check ${check?.status}/${check?.[rateKey[1]]} session ${st[statsKey[0]]}/${st[statsKey[1]]}`,
      );
      return (
        big?.status === 4 &&
        big[rateKey[0]] >= TRANSFER_MIN &&
        big.eta > 0 &&
        check?.status === 6 &&
        check[rateKey[1]] >= TRANSFER_MIN &&
        st[statsKey[0]] >= TRANSFER_MIN &&
        st[statsKey[1]] >= TRANSFER_MIN
      );
    },
    180_000,
    1000,
  );
  await rpc("session_set", { speed_limit_down_enabled: false, speed_limit_up_enabled: false });

  // seeding: the web-seeded download finishes — before the recheck of `check`: while 1 GiB is verified, Transmission
  // 4.0.6 loaded the web seed at under 134 kB/s and `big` did not finish in 240 s. Even before it, 4.0.6 loads the web
  // seed at 147–247 kB/s while the peer leeches `check` at ~530 KiB/s (run 44758258105), so 32 MiB take up to ~230 s —
  // 240 s timed out in three of six runs (10360e0, cb18114, a8ee6e3)
  await waitFor("big seeding", async () => (await find(hash("big")))?.status === 6, 600_000, 1000);
  await snapshot("finished");

  // loading metadata: start the magnet past the queue
  w("commands", "torrent-start-now", await rpc("torrent_start_now", { ids: [DEAD_MAGNET_HASH] }));
  await waitFor("magnet downloading metadata", async () => (await find(DEAD_MAGNET_HASH))?.status === 4);
  await snapshot("metadata");
  await rpc("torrent_stop", { ids: [DEAD_MAGNET_HASH] });

  // checking
  w("commands", "torrent-verify", await rpc("torrent_verify", { ids: [hash("check")] }));
  const seen = new Set();
  await waitFor(
    "check checking",
    async () => {
      const st = (await find(hash("check")))?.status;
      seen.add(st);
      return st === 1 || st === 2;
    },
    30_000,
    20,
  ).catch(err => {
    throw new Error(`${err.message} — statuses seen: ${[...seen].join(", ")}`);
  });
  await snapshot("checking");

  // failed: payload gone, verify
  rmSync(join(ctx.work, "downloads", "gone.bin"));
  await rpc("torrent_verify", { ids: [hash("gone")] });
  await rpc("torrent_start", { ids: [hash("gone")] });
  await waitFor(
    "gone failing",
    async () => {
      const t = await find(hash("gone"));
      return t && (t.error !== 0 || (t.percentDone ?? t.percent_done) < 1);
    },
    60_000,
  );
  await snapshot("missing");

  // completed: stop the finished one
  w("commands", "torrent-stop", await rpc("torrent_stop", { ids: [hash("done")] }));
  await waitFor("done stopped", async () => (await find(hash("done")))?.status === 0);
  await snapshot("completed");
  w("commands", "torrent-start", await rpc("torrent_start", { ids: [hash("done")] }));

  // limits and alternative speed (kB/s, base in session units)
  w(
    "commands",
    "session-set-limits",
    await rpc("session_set", {
      speed_limit_down: 2000,
      speed_limit_down_enabled: true,
      speed_limit_up: 500,
      speed_limit_up_enabled: true,
    }),
  );
  w("commands", "session-set-alt-speed", await rpc("session_set", { alt_speed_enabled: true }));
  await snapshot("limited");
  await rpc("session_set", {
    alt_speed_enabled: false,
    speed_limit_down_enabled: false,
    speed_limit_up_enabled: false,
  });

  // stop everything (no ids = all), remove one without data
  w("commands", "torrent-stop-all", await rpc("torrent_stop"));
  await snapshot("all-stopped");
  w("commands", "torrent-remove", await rpc("torrent_remove", { ids: [hash("queued")], delete_local_data: false }));
  return rec;
}
