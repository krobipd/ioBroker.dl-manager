// qBittorrent in the container recorder: config with a fixed PBKDF2 password, torrents in every reachable state,
// then every read the driver makes, recorded per snapshot. api-torrent.md § 1.
import { pbkdf2Sync } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEAD_MAGNET, DEAD_MAGNET_HASH, Http, prepareTorrents, Recorder, torrentOf, waitFor } from "../lib.mjs";

const USER = "admin";
const PASS = "testpass1";
const PORT = 8080;

/**
 * Runner side: config, payloads and the container definition.
 *
 * @param {string} work work directory on the runner
 * @param {string} tag image tag
 * @returns {{ image: string, name: string, env: Record<string,string>, volumes: string[] }} container
 */
export function prepare(work, tag) {
  const salt = Buffer.from("download-manager").subarray(0, 16);
  const hash = pbkdf2Sync(PASS, salt, 100_000, 64, "sha512");
  const conf = [
    "[LegalNotice]",
    "Accepted=true",
    "",
    "[BitTorrent]",
    "Session\\DHTEnabled=false",
    "Session\\LSDEnabled=false",
    "Session\\PeXEnabled=false",
    "Session\\DefaultSavePath=/downloads",
    "Session\\QueueingSystemEnabled=true",
    "Session\\MaxActiveDownloads=1",
    "Session\\MaxActiveTorrents=20",
    "Session\\MaxActiveUploads=20",
    "Session\\IgnoreSlowTorrentsForQueueing=false",
    "",
    "[Network]",
    "PortForwardingEnabled=false",
    "",
    "[Preferences]",
    `WebUI\\Username=${USER}`,
    `WebUI\\Password_PBKDF2="@ByteArray(${salt.toString("base64")}:${hash.toString("base64")})"`,
    "WebUI\\MaxAuthenticationFailCount=0",
    `WebUI\\Port=${PORT}`,
    "WebUI\\HostHeaderValidation=false",
    "",
  ].join("\n");
  const confDir = join(work, "qbt", "qBittorrent", "config");
  mkdirSync(confDir, { recursive: true });
  writeFileSync(join(confDir, "qBittorrent.conf"), conf);
  prepareTorrents(work);
  return {
    image: `qbittorrentofficial/qbittorrent-nox:${tag}`,
    name: "qbt",
    env: { QBT_LEGAL_NOTICE: "confirm", QBT_WEBUI_PORT: String(PORT) },
    volumes: [`${join(work, "qbt")}:/config`, `${join(work, "downloads")}:/downloads`],
  };
}

const READS = [
  ["torrents-info", "/api/v2/torrents/info"],
  ["transfer-info", "/api/v2/transfer/info"],
  ["maindata", "/api/v2/sync/maindata?rid=0"],
  ["download-limit", "/api/v2/transfer/downloadLimit"],
  ["upload-limit", "/api/v2/transfer/uploadLimit"],
  ["speed-limits-mode", "/api/v2/transfer/speedLimitsMode"],
  ["categories", "/api/v2/torrents/categories"],
];

/**
 * Recorder side (inside the recorder container on the internal network).
 *
 * @param {{ work: string }} ctx paths
 * @returns {Promise<Recorder>} the recorder with its files
 */
export async function record(ctx) {
  const base = `http://qbt:${PORT}`;
  const anon = new Http(base);
  await waitFor("qBittorrent web UI", async () => (await anon.req("GET", "/api/v2/app/version")).status > 0, 180_000);

  const wrong = new Http(base);
  const wrongRes = await wrong.req("POST", "/api/v2/auth/login", { form: { username: USER, password: "wrong" } });
  const qb = new Http(base);
  const login = await qb.req("POST", "/api/v2/auth/login", { form: { username: USER, password: PASS } });
  if (!(login.status < 300 && (login.text === "Ok." || qb.cookies.size))) {
    throw new Error(`login failed: ${login.status} ${login.text}`);
  }
  const versionRes = await qb.req("GET", "/api/v2/app/version");
  const version = versionRes.text.replace(/^v/, "").trim();
  const rec = new Recorder("qbittorrent", version);
  const v5 = Number(version.split(".")[0]) >= 5;
  rec.write("auth", "login-wrong", "POST /api/v2/auth/login", wrongRes);
  rec.write("auth", "login-ok", "POST /api/v2/auth/login", login);
  rec.write("auth", "session-missing", "GET /api/v2/torrents/info", await anon.req("GET", "/api/v2/torrents/info"));
  rec.write("auth", "app-version", "GET /api/v2/app/version", versionRes);
  rec.write(
    "auth",
    "webapi-version",
    "GET /api/v2/app/webapiVersion",
    await qb.req("GET", "/api/v2/app/webapiVersion"),
  );

  const snapshot = async state => {
    for (const [name, path] of READS) {
      rec.write(state, name, `GET ${path}`, await qb.req("GET", path));
    }
  };
  const torrents = async () => (await qb.req("GET", "/api/v2/torrents/info")).json();
  const hash = name => torrentOf(ctx.work, name).hash;
  const stateOf = async name => (await torrents()).find(t => t.hash === hash(name))?.state;

  // qBittorrent refreshes torrent states every 1.5 s by default — a recheck of 1 GiB ends between two refreshes
  await qb.req("POST", "/api/v2/app/setPreferences", { form: { json: JSON.stringify({ refresh_interval: 50 }) } });
  await snapshot("empty");

  const add = async (name, extra = {}) => {
    const form = new FormData();
    form.append("torrents", new Blob([torrentOf(ctx.work, name).torrent]), `${name}.torrent`);
    for (const [k, v] of Object.entries(extra)) {
      form.append(k, v);
    }
    return qb.req("POST", "/api/v2/torrents/add", { body: form });
  };
  rec.write("commands", "add-file", "POST /api/v2/torrents/add (multipart torrents)", await add("big"));
  await waitFor("big downloading", async () => (await stateOf("big")) === "downloading", 120_000);
  await add("queued");
  await add("stopped", v5 ? { stopped: "true" } : { paused: "true" });
  await add("done");
  await add("gone");
  await add("check");
  const magnetForm = new FormData();
  magnetForm.append("urls", DEAD_MAGNET);
  rec.write(
    "commands",
    "add-url",
    "POST /api/v2/torrents/add (multipart urls)",
    await qb.req("POST", "/api/v2/torrents/add", { body: magnetForm }),
  );

  await waitFor("mixed states", async () => {
    const s = await Promise.all(["queued", "stopped", "done", "check"].map(stateOf));
    return (
      s[0] === "queuedDL" && /^(stopped|paused)DL$/.test(s[1] ?? "") && /UP$/.test(s[2] ?? "") && /UP$/.test(s[3] ?? "")
    );
  });
  await snapshot("running");

  // loading metadata: the queue (1 active download) holds the magnet back — force-start it
  rec.write(
    "commands",
    "set-force-start",
    "POST /api/v2/torrents/setForceStart",
    await qb.req("POST", "/api/v2/torrents/setForceStart", { form: { hashes: DEAD_MAGNET_HASH, value: "true" } }),
  );
  await waitFor("magnet loading metadata", async () => {
    const t = (await torrents()).find(x => x.hash === DEAD_MAGNET_HASH);
    return /MetaDL$/.test(t?.state ?? "");
  });
  await snapshot("metadata");
  await qb.req("POST", "/api/v2/torrents/setForceStart", { form: { hashes: DEAD_MAGNET_HASH, value: "false" } });

  // checking: recheck the big present payload and catch the check while it runs
  rec.write(
    "commands",
    "recheck",
    "POST /api/v2/torrents/recheck",
    await qb.req("POST", "/api/v2/torrents/recheck", { form: { hashes: hash("check") } }),
  );
  const seen = new Set();
  await waitFor(
    "check checking",
    async () => {
      const st = (await stateOf("check")) ?? "";
      seen.add(st);
      return /^checking/.test(st);
    },
    30_000,
    20,
  ).catch(err => {
    throw new Error(`${err.message} — states seen: ${[...seen].join(", ")}`);
  });
  await snapshot("checking");

  // failed: a deleted payload only drops to 0 % on a recheck — an unreadable one is a file error
  chmodSync(join(ctx.work, "downloads", "gone.bin"), 0o000);
  await qb.req("POST", "/api/v2/torrents/recheck", { form: { hashes: hash("gone") } });
  const goneSeen = new Set();
  await waitFor(
    "gone failing",
    async () => {
      const st = (await stateOf("gone")) ?? "";
      goneSeen.add(st);
      return /^(missingFiles|error)$/.test(st);
    },
    60_000,
    100,
  ).catch(err => {
    throw new Error(`${err.message} — states seen: ${[...goneSeen].join(", ")}`);
  });
  await snapshot("missing");

  // completed: stop the finished one
  const stop = v5 ? "stop" : "pause";
  const start = v5 ? "start" : "resume";
  rec.write(
    "commands",
    stop,
    `POST /api/v2/torrents/${stop}`,
    await qb.req("POST", `/api/v2/torrents/${stop}`, { form: { hashes: hash("done") } }),
  );
  await waitFor("done stopped", async () => /^(stopped|paused)UP$/.test((await stateOf("done")) ?? ""));
  await snapshot("completed");
  rec.write(
    "commands",
    start,
    `POST /api/v2/torrents/${start}`,
    await qb.req("POST", `/api/v2/torrents/${start}`, { form: { hashes: hash("done") } }),
  );

  // limits and alternative speed
  rec.write(
    "commands",
    "set-download-limit",
    "POST /api/v2/transfer/setDownloadLimit",
    await qb.req("POST", "/api/v2/transfer/setDownloadLimit", { form: { limit: "2000000" } }),
  );
  rec.write(
    "commands",
    "set-upload-limit",
    "POST /api/v2/transfer/setUploadLimit",
    await qb.req("POST", "/api/v2/transfer/setUploadLimit", { form: { limit: "500000" } }),
  );
  rec.write(
    "commands",
    "set-speed-limits-mode",
    "POST /api/v2/transfer/setSpeedLimitsMode",
    await qb.req("POST", "/api/v2/transfer/setSpeedLimitsMode", { form: { mode: "1" } }),
  );
  await snapshot("limited");
  await qb.req("POST", "/api/v2/transfer/setSpeedLimitsMode", { form: { mode: "0" } });
  await qb.req("POST", "/api/v2/transfer/setDownloadLimit", { form: { limit: "0" } });

  // seeding: the web-seeded download finishes
  await waitFor("big seeding", async () => /UP$/.test((await stateOf("big")) ?? ""), 240_000, 1000);
  await snapshot("finished");

  // global stop (≤ 5.2: all hashes) and remove without files
  rec.write(
    "commands",
    `${stop}-all`,
    `POST /api/v2/torrents/${stop} hashes=all`,
    await qb.req("POST", `/api/v2/torrents/${stop}`, { form: { hashes: "all" } }),
  );
  await snapshot("all-stopped");
  rec.write(
    "commands",
    "delete",
    "POST /api/v2/torrents/delete",
    await qb.req("POST", "/api/v2/torrents/delete", { form: { hashes: hash("queued"), deleteFiles: "false" } }),
  );
  return rec;
}
