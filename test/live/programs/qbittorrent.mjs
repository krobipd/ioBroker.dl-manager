// qBittorrent in the container recorder: config with a fixed PBKDF2 password, torrents in every reachable state,
// then every read the driver makes, recorded per snapshot. api-torrent.md § 1.
import { pbkdf2Sync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Http, makeTorrent, payload, Recorder, waitFor } from "../lib.mjs";

const USER = "admin";
const PASS = "testpass1";
const PORT = 8080;
const MiB = 1024 * 1024;

/** The torrents of the run: name, size, whether the payload lies in the download folder, web seed. */
const FILES = {
  big: { size: 32 * MiB, present: false, webseed: true },
  queued: { size: 4 * MiB, present: false, webseed: true },
  stopped: { size: 4 * MiB, present: false, webseed: true },
  done: { size: 2 * MiB, present: true, webseed: false },
  gone: { size: 2 * MiB, present: true, webseed: false },
  check: { size: 256 * MiB, present: true, webseed: false },
};

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
  mkdirSync(join(work, "downloads"), { recursive: true, mode: 0o777 });
  mkdirSync(join(work, "seed"), { recursive: true });
  mkdirSync(join(work, "torrents"), { recursive: true });
  let seed = 10;
  for (const [name, f] of Object.entries(FILES)) {
    const data = payload(f.size, seed++);
    const file = `${name}.bin`;
    if (f.webseed) {
      writeFileSync(join(work, "seed", file), data);
    }
    if (f.present) {
      writeFileSync(join(work, "downloads", file), data);
    }
    const t = makeTorrent({
      name: file,
      data,
      webseed: f.webseed ? `http://seed:8080/${file}` : undefined,
      pieceLength: f.size > 64 * MiB ? 4 * MiB : 256 * 1024,
    });
    writeFileSync(join(work, "torrents", `${name}.torrent`), t.torrent);
    writeFileSync(join(work, "torrents", `${name}.hash`), t.infoHash);
  }
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
  rec.write("auth", "login-ok", "POST /api/v2/auth/login", { ...login, headers: { "set-cookie": "<omitted>" } });
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
  const hash = name => readFileSync(join(ctx.work, "torrents", `${name}.hash`), "utf8");
  const stateOf = async name => (await torrents()).find(t => t.hash === hash(name))?.state;

  await snapshot("empty");

  const add = async (name, extra = {}) => {
    const form = new FormData();
    form.append("torrents", new Blob([readFileSync(join(ctx.work, "torrents", `${name}.torrent`))]), `${name}.torrent`);
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
  const magnetHash = "0123456789abcdef0123456789abcdef01234567";
  const magnetForm = new FormData();
  magnetForm.append("urls", `magnet:?xt=urn:btih:${magnetHash}&dn=nobody-seeds-this`);
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

  // checking: recheck the big present payload and catch the check while it runs
  rec.write(
    "commands",
    "recheck",
    "POST /api/v2/torrents/recheck",
    await qb.req("POST", "/api/v2/torrents/recheck", { form: { hashes: hash("check") } }),
  );
  await waitFor("check checking", async () => /^checking/.test((await stateOf("check")) ?? ""), 30_000, 50);
  await snapshot("checking");

  // failed: take the payload away and recheck
  rmSync(join(ctx.work, "downloads", "gone.bin"));
  await qb.req("POST", "/api/v2/torrents/recheck", { form: { hashes: hash("gone") } });
  await waitFor("gone missing", async () => /^(missingFiles|error)$/.test((await stateOf("gone")) ?? ""), 60_000);
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
