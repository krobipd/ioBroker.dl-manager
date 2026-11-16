// Vuze in the container recorder: the last Vuze release (5.7.6.0, 2017) without its desktop UI, with its Web Remote
// plugin xmwebui — the Transmission RPC Sonarr's Vuze client talks to (Vuze.cs: `Vuze : TransmissionBase`). No image
// carries both, so the runner fetches the release, the plugin and the two libraries the console start needs
// (Azureus2.jar's manifest: commons-cli.jar, log4j.jar), checks each against its pinned SHA-256 and starts them in a
// Java 8 image. Pairing is switched off and the plugin's own user/password switched on through azureus.config —
// with pairing on (the default) the plugin sets the user `vuze` and the pairing code as the password itself
// (WebPlugin.java `setupAccessCode`).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEAD_MAGNET,
  DEAD_MAGNET_HASH,
  Http,
  peer,
  prepareTorrents,
  Recorder,
  sh,
  TRANSFER_LIMIT_DOWN,
  TRANSFER_MIN,
  torrentOf,
  waitFor,
} from "../lib.mjs";

const USER = "admin";
const PASS = "testpass1";
const RPC = "/transmission/rpc";

/** What each matrix tag starts — every file pinned by its SHA-256 (measured 2026-11-15). */
const RELEASES = {
  "5.7.6.0-xmwebui-0.6.5": {
    vuze: {
      url: "https://downloads.sourceforge.net/project/azureus/vuze/Vuze_5760/Vuze_5760_linux.tar.bz2",
      sha256: "1c5995ed8a25bac4bf1cea012b583af92af04c15579ab686689bca13e6cad36c",
    },
    plugin: {
      url: "https://plugins.vuze.com/plugins/xmwebui_0.6.5.zip",
      sha256: "a7aed9d88682a26bc8f5461c38555f8f402de71b539fad353737e6e35d058f54",
    },
    "commons-cli.jar": {
      url: "https://repo1.maven.org/maven2/commons-cli/commons-cli/1.2/commons-cli-1.2.jar",
      sha256: "e7cd8951956d349b568b7ccfd4f5b2529a8c113e67c32b028f52ffda371259d9",
    },
    "log4j.jar": {
      url: "https://repo1.maven.org/maven2/log4j/log4j/1.2.17/log4j-1.2.17.jar",
      sha256: "1d31696445697720527091754369082a6651bd49781b6005deb94e56753406f9",
    },
  },
};

/**
 * Bencode, as Vuze keeps azureus.config (strings and byte arrays as byte strings, booleans as 0/1, keys sorted).
 *
 * @param {unknown} v value
 * @returns {Buffer} the encoding
 */
function bencode(v) {
  if (Buffer.isBuffer(v)) {
    return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  }
  if (typeof v === "string") {
    return bencode(Buffer.from(v, "utf8"));
  }
  if (typeof v === "boolean") {
    return bencode(v ? 1 : 0);
  }
  if (typeof v === "number") {
    return Buffer.from(`i${Math.trunc(v)}e`);
  }
  const keys = Object.keys(/** @type {object} */ (v)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Buffer.concat([
    Buffer.from("d"),
    ...keys.flatMap(k => [bencode(k), bencode(/** @type {Record<string, unknown>} */ (v)[k])]),
    Buffer.from("e"),
  ]);
}

/**
 * @param {string} file downloaded file
 * @param {string} sha256 the pinned sum
 */
function checkSum(file, sha256) {
  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (got !== sha256) {
    throw new Error(`${file}: SHA-256 ${got}, pinned ${sha256}`);
  }
}

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag matrix tag (a key of RELEASES)
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  const release = RELEASES[tag];
  if (!release) {
    throw new Error(`vuze: no release pinned for ${tag}`);
  }
  prepareTorrents(work);
  const dl = join(work, "dl");
  mkdirSync(dl, { recursive: true });
  const fetched = {};
  for (const [key, f] of Object.entries(release)) {
    const file = join(dl, f.url.split("/").pop());
    if (!existsSync(file)) {
      sh("curl", ["-fsSL", "--retry", "3", "-o", file, f.url]);
    }
    checkSum(file, f.sha256);
    fetched[key] = file;
  }
  const install = join(work, "vuze-install");
  mkdirSync(install, { recursive: true });
  sh("tar", ["xjf", fetched.vuze, "-C", install]);
  for (const jar of ["commons-cli.jar", "log4j.jar"]) {
    copyFileSync(fetched[jar], join(install, "vuze", jar));
  }
  const config = join(work, "vuze-config");
  mkdirSync(join(config, "plugins", "xmwebui"), { recursive: true });
  sh("unzip", ["-q", "-o", fetched.plugin, "-d", join(config, "plugins", "xmwebui")]);
  writeFileSync(
    join(config, "azureus.config"),
    bencode({
      // the plugin's own login (WebPlugin.java: CONFIG_PASSWORD_ENABLE, CONFIG_USER, CONFIG_PASSWORD as SHA-1)
      "Plugin.xmwebui.Password Enable": true,
      "Plugin.xmwebui.User": USER,
      "Plugin.xmwebui.Password": createHash("sha1").update(PASS).digest(),
      "Plugin.xmwebui.Pairing Enable": false,
      "Default save path": "/downloads",
      "Use default data dir": true,
      // one download at a time, so the others queue (StartStopRules: 0 active = unlimited)
      "max downloads": 1,
      "max active torrents": 0,
    }),
  );
  // run 43680925710: the file's download folder took, its login did not (wrong password and none answered 200) — the
  // console shows the plugin's keys, sets the login itself (Set.java: `password` stores the SHA-1) and shows them again
  writeFileSync(
    join(config, "console-setup.txt"),
    [
      "set Plugin.xmwebui.*",
      'set "Plugin.xmwebui.Pairing Enable" false boolean',
      `set "Plugin.xmwebui.User" ${USER} string`,
      `set "Plugin.xmwebui.Password" ${PASS} password`,
      'set "Plugin.xmwebui.Password Enable" true boolean',
      "set Plugin.xmwebui.*",
      "",
    ].join("\n"),
  );
  const java = [
    "java",
    "-Xmx512m",
    "-Djava.awt.headless=true",
    "-Dazureus.config.path=/config",
    "-Dazureus.install.path=/opt/vuze",
    "-cp",
    "/opt/vuze/Azureus2.jar:/opt/vuze/commons-cli.jar:/opt/vuze/log4j.jar",
    "org.gudy.azureus2.ui.common.Main",
    "--ui=console",
  ].join(" ");
  return {
    image: "eclipse-temurin:8-jre",
    name: "vuze",
    // the console UI reads its commands from stdin — the setup first, then kept open, or the end of input ends Vuze
    entrypoint: "sh",
    args: ["-c", `(cat /config/console-setup.txt; tail -f /dev/null) | ${java}`],
    volumes: [`${join(install, "vuze")}:/opt/vuze`, `${config}:/config`, `${join(work, "downloads")}:/downloads`],
    sidecars: [peer(work)],
  };
}

/** The torrent fields Transmission's recorder asks, in the legacy names (the plugin speaks RPC 15 only). */
const FIELDS = [
  "id",
  "hashString",
  "name",
  "status",
  "percentDone",
  "sizeWhenDone",
  "totalSize",
  "leftUntilDone",
  "downloadedEver",
  "uploadedEver",
  "rateDownload",
  "rateUpload",
  "eta",
  "uploadRatio",
  "addedDate",
  "doneDate",
  "error",
  "errorString",
  "labels",
  "downloadDir",
  "isFinished",
  "isStalled",
  "metadataPercentComplete",
  "recheckProgress",
  "queuePosition",
];

/**
 * Recorder side.
 *
 * @param {{ work: string }} ctx paths
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(ctx) {
  const base = "http://vuze:9091";
  // the exact spelling: Vuze's web server looks for the text "Authorization:" (TRTrackerServerProcessorTCP.java 873) —
  // run 43681939522 sent "authorization" and got 401 for five minutes with the right password
  const basic = pass => ({ Authorization: `Basic ${Buffer.from(`${USER}:${pass}`).toString("base64")}` });
  // every probe without the cookie jar of the others: the plugin also takes the session id from its cookie
  // (XMWebUIPlugin.java `isSessionValid`) — a shared jar made the 409 look like a 200 in run 43680925710
  await waitFor(
    "Vuze Web Remote",
    async () => (await new Http(base).req("POST", RPC, { json: {} })).status > 0,
    300_000,
    2000,
  );

  /**
   * @param {string} label what is asked
   * @param {Record<string,string>} headers request headers
   * @returns {ReturnType<Http["req"]>} the answer, its time in the log
   */
  const timed = async (label, headers) => {
    const t = Date.now();
    const res = await new Http(base).req("POST", RPC, {
      headers,
      json: { method: "session-get" },
      timeoutMs: 180_000,
    });
    console.log(`${label}: ${res.status} after ${Date.now() - t} ms`);
    return res;
  };
  // run 43681661285: the web server answered 2.6 s after the start, while the console was still setting the login — every
  // request, the right password too, got 401; the final settings (console listing) were right. Wait until they hold.
  const since = Date.now();
  let lastStatus = 0;
  await waitFor(
    "the plugin's login",
    async () => {
      const res = await new Http(base).req("POST", RPC, { headers: basic(PASS), json: {}, timeoutMs: 180_000 });
      if (res.status !== lastStatus) {
        console.log(`right password: ${res.status} after ${Date.now() - since} ms`);
        lastStatus = res.status;
      }
      return res.status === 409 || res.status === 200;
    },
    300_000,
    2000,
  );
  const first = await timed("no session id", basic(PASS));
  let sessionId = first.headers["x-transmission-session-id"] ?? "";
  // the first session-get asks Vuze's version server and waits for it (XMWebUIPlugin.java 2820, again after 864 s):
  // 89.9 s in the closed network (run 43680925710)
  await timed("first session-get", { ...basic(PASS), "x-transmission-session-id": sessionId });
  await timed("second session-get", { ...basic(PASS), "x-transmission-session-id": sessionId });
  const wrong = await timed("wrong password", { ...basic("wrong"), "x-transmission-session-id": sessionId });
  const none = await timed("no login", { "x-transmission-session-id": sessionId });
  const http = new Http(base);
  let seq = 0;

  /**
   * One RPC call; renews the session id once on 409.
   *
   * @param {string} method legacy method name
   * @param {Record<string, unknown>} args legacy arguments
   * @returns {Promise<{ status: number, text: string, headers: Record<string,string>, json: () => unknown, sent: string }>} answer
   */
  const rpc = async (method, args = {}) => {
    const body = { method, arguments: args, tag: ++seq };
    const send = () =>
      http.req("POST", RPC, { headers: { ...basic(PASS), "x-transmission-session-id": sessionId }, json: body });
    let res = await send();
    if (res.status === 409) {
      sessionId = res.headers["x-transmission-session-id"];
      res = await send();
    }
    return { ...res, sent: JSON.stringify(body) };
  };
  const argsOf = res => /** @type {{ arguments: Record<string, unknown> }} */ (res.json()).arguments;

  const session = argsOf(await rpc("session-get"));
  const rec = new Recorder("vuze", `${String(session["az-version"])}-xmwebui-${String(session.version)}`);
  rec.write("auth", "login-wrong", `POST ${RPC} (basic auth, wrong password)`, wrong);
  rec.write("auth", "login-none", `POST ${RPC} (no basic auth)`, none);
  rec.write("auth", "session-409", `POST ${RPC} (no session id)`, first);
  const w = (state, name, res) => rec.write(state, name, `POST ${RPC} ${res.sent}`, res);

  const torrentGet = () => rpc("torrent-get", { fields: FIELDS });
  /** @typedef {{ hashString?: string, status?: number, rateDownload?: number, rateUpload?: number, eta?: number }} VzTorrent a torrent of torrent-get */
  /** @type {(state: string) => Promise<{ torrents: VzTorrent[], stats: { downloadSpeed?: number, uploadSpeed?: number } }>} records one state, returns what it recorded */
  const snapshot = async state => {
    const torrents = await torrentGet();
    w(state, "torrent-get", torrents);
    w(state, "session-get", await rpc("session-get"));
    const stats = await rpc("session-stats");
    w(state, "session-stats", stats);
    w(state, "free-space", await rpc("free-space", { path: "/downloads" }));
    return {
      torrents: /** @type {{ torrents?: VzTorrent[] }} */ (argsOf(torrents)).torrents ?? [],
      stats: /** @type {{ downloadSpeed?: number, uploadSpeed?: number }} */ (argsOf(stats)),
    };
  };
  const list = async () => /** @type {Record<string, unknown>[]} */ (argsOf(await torrentGet()).torrents ?? []);

  // Vuze lists the hash in upper case (probe of run 43680925710) and matches ids against it (`getDownloadListFromIDs`)
  const hash = name => torrentOf(ctx.work, name).hash.toUpperCase();
  const find = async h => (await list()).find(t => t.hashString === h);
  const seen = new Map();
  /**
   * Waits for a state, logs the statuses seen on the way and goes on without it — one run records every state Vuze
   * reaches, the log names the ones it did not.
   *
   * @param {string} label the state
   * @param {() => Promise<boolean>} probe reached?
   * @param {number} timeoutMs how long
   * @returns {Promise<boolean>} reached
   */
  const reach = async (label, probe, timeoutMs) => {
    try {
      await waitFor(label, probe, timeoutMs, 1000);
      return true;
    } catch (err) {
      const t = await list();
      const why = err instanceof Error ? err.message : String(err);
      console.log(`NOT REACHED ${label}: ${why} — ${t.map(x => `${String(x.name)}:${String(x.status)}`).join(" ")}`);
      return false;
    }
  };
  /**
   * @param {string} name torrent
   * @returns {Promise<number | undefined>} its status now
   */
  const statusOf = async name => {
    const raw = (await find(hash(name)))?.status;
    const st = typeof raw === "number" ? raw : undefined;
    seen.set(name, [...new Set([...(seen.get(name) ?? []), st])]);
    return st;
  };
  const add = (name, extra = {}) =>
    rpc("torrent-add", {
      metainfo: torrentOf(ctx.work, name).torrent.toString("base64"),
      "download-dir": "/downloads",
      ...extra,
    });

  await snapshot("empty");
  // the download limit of `transfer` (KB/s, see `limited`), set before `big` starts: it still loads when `transfer` is
  // recorded after `running`
  await rpc("session-set", {
    "speed-limit-down": Math.floor(TRANSFER_LIMIT_DOWN / 1024),
    "speed-limit-down-enabled": true,
  });
  w("commands", "torrent-add-metainfo", await add("big"));
  // run 43682528277: big loaded 32 MiB in 37 s (the seed server's 1 MiB/s) — the snapshot comes while it loads
  await reach(
    "big loading",
    async () => {
      const t = await find(hash("big"));
      return t?.status === 4 && Number(t.rateDownload) > 0;
    },
    120_000,
  );
  await add("queued");
  w("commands", "torrent-add-paused", await add("stopped", { paused: true }));
  // one download at a time ("max downloads" 1): queued waits as 3
  await reach("queued waiting", async () => (await statusOf("queued")) === 3, 15_000);
  await snapshot("downloading");
  // no verify after adding: Vuze leaves a verified torrent stopped (run 43682528277: done, gone, check stayed 0)
  for (const name of ["done", "gone", "check"]) {
    await add(name);
  }
  w(
    "commands",
    "torrent-add-magnet",
    await rpc("torrent-add", { filename: DEAD_MAGNET, "download-dir": "/downloads" }),
  );
  await reach(
    "present payloads seeding",
    async () => {
      const st = await Promise.all(["done", "gone", "check"].map(statusOf));
      return st.every(x => x === 5 || x === 6);
    },
    120_000,
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
      const big = shot.torrents.find(t => t.hashString === hash("big"));
      const check = shot.torrents.find(t => t.hashString === hash("check"));
      console.log(
        `vuze transfer sample ${++samples}: big ${big?.status}/${big?.rateDownload}/${big?.eta} check ${check?.status}/${check?.rateUpload} session ${shot.stats.downloadSpeed}/${shot.stats.uploadSpeed}`,
      );
      return (
        big?.status === 4 &&
        (big.rateDownload ?? 0) >= TRANSFER_MIN &&
        (big.eta ?? 0) > 0 &&
        (check?.rateUpload ?? 0) >= TRANSFER_MIN &&
        (shot.stats.downloadSpeed ?? 0) >= TRANSFER_MIN &&
        (shot.stats.uploadSpeed ?? 0) >= TRANSFER_MIN
      );
    },
    180_000,
    1000,
  );
  await rpc("session-set", { "speed-limit-down-enabled": false });

  // a magnet without metadata: started past the queue
  w("commands", "torrent-start-now", await rpc("torrent-start-now", { ids: [DEAD_MAGNET_HASH.toUpperCase()] }));
  await new Promise(r => setTimeout(r, 5000));
  await snapshot("metadata");
  await rpc("torrent-stop", { ids: [DEAD_MAGNET_HASH.toUpperCase()] });

  // checking
  w("commands", "torrent-verify", await rpc("torrent-verify", { ids: [hash("check")] }));
  await reach("check checking", async () => [1, 2].includes(Number(await statusOf("check"))), 30_000);
  await snapshot("checking");

  // failed: payload gone, verify, start
  rmSync(join(ctx.work, "downloads", "gone.bin"));
  await rpc("torrent-verify", { ids: [hash("gone")] });
  await rpc("torrent-start", { ids: [hash("gone")] });
  await reach(
    "gone failing",
    async () => {
      const t = await find(hash("gone"));
      return t !== undefined && (t.error !== 0 || Number(t.percentDone) < 1);
    },
    60_000,
  );
  await snapshot("missing");

  // completed: stop the finished one
  w("commands", "torrent-stop", await rpc("torrent-stop", { ids: [hash("done")] }));
  await reach("done stopped", async () => (await statusOf("done")) === 0, 30_000);
  await snapshot("completed");
  w("commands", "torrent-start", await rpc("torrent-start", { ids: [hash("done")] }));

  // limits (KB/s — XMWebUIPlugin.java `speed-limit-down`: CORE_PARAM_INT_MAX_DOWNLOAD_SPEED_KBYTES_PER_SEC) and the
  // alternative speed, which session-get only fakes (fixed 50/50, always off)
  w(
    "commands",
    "session-set-limits",
    await rpc("session-set", {
      "speed-limit-down": 2000,
      "speed-limit-down-enabled": true,
      "speed-limit-up": 500,
      "speed-limit-up-enabled": true,
    }),
  );
  w("commands", "session-set-alt-speed", await rpc("session-set", { "alt-speed-enabled": true }));
  await snapshot("limited");
  w(
    "commands",
    "session-set-unlimited",
    await rpc("session-set", { "speed-limit-down-enabled": false, "speed-limit-up-enabled": false }),
  );
  await snapshot("unlimited");

  // seeding: the web-seeded download finishes (Vuze took 32 KiB/s from the seed server in the probe)
  await reach("big seeding", async () => (await statusOf("big")) === 6, 900_000);
  await snapshot("finished");

  // the emulated pause: stop by hash list, start exactly those — a metadata download (metadataPercentComplete 0) is
  // in no id list of torrent-stop/-start (XMWebUIPlugin.java `getDownloads(ids, false)`): run 43682528277 kept it at 4
  const running = (await list()).filter(t => t.status !== 0).map(t => t.hashString);
  w("commands", "torrent-stop-list", await rpc("torrent-stop", { ids: running }));
  await reach(
    "listed stopped",
    async () => (await list()).every(t => t.status === 0 || t.metadataPercentComplete === 0),
    30_000,
  );
  await snapshot("all-stopped");
  w("commands", "torrent-start-list", await rpc("torrent-start", { ids: running }));
  await reach("listed started", async () => (await list()).filter(t => t.status !== 0).length > 0, 30_000);
  await snapshot("resumed");

  // remove one without its data, then an unknown hash
  w("commands", "torrent-remove", await rpc("torrent-remove", { ids: [hash("queued")], "delete-local-data": false }));
  w("commands", "torrent-remove-unknown", await rpc("torrent-remove", { ids: ["F".repeat(40)] }));
  await snapshot("removed");
  console.log("statuses seen:", JSON.stringify(Object.fromEntries(seen)));
  return rec;
}
