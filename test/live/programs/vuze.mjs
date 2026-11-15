// Vuze in the container recorder: the last Vuze release (5.7.6.0, 2017) without its desktop UI, with its Web Remote
// plugin xmwebui — the Transmission RPC Sonarr's Vuze client talks to (Vuze.cs: `Vuze : TransmissionBase`). No image
// carries both, so the runner fetches the release, the plugin and the two libraries the console start needs
// (Azureus2.jar's manifest: commons-cli.jar, log4j.jar), checks each against its pinned SHA-256 and starts them in a
// Java 8 image. Pairing is switched off and the plugin's own user/password switched on through azureus.config —
// with pairing on (the default) the plugin sets the user `vuze` and the pairing code as the password itself
// (WebPlugin.java `setupAccessCode`).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Http, prepareTorrents, Recorder, sh, torrentOf, waitFor } from "../lib.mjs";

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
 * @returns {{ image: string, name: string, entrypoint: string, args: string[], volumes: string[] }} container
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
    // the console UI reads its commands from stdin — kept open, or the end of input ends Vuze
    entrypoint: "sh",
    args: ["-c", `tail -f /dev/null | ${java}`],
    volumes: [`${join(install, "vuze")}:/opt/vuze`, `${config}:/config`, `${join(work, "downloads")}:/downloads`],
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
  const basic = pass => ({ authorization: `Basic ${Buffer.from(`${USER}:${pass}`).toString("base64")}` });
  const probe = new Http(base);
  await waitFor("Vuze Web Remote", async () => (await probe.req("POST", RPC, { json: {} })).status > 0, 300_000, 2000);

  /**
   * @param {string} label what is asked
   * @param {Record<string,string>} headers request headers
   * @returns {ReturnType<Http["req"]>} the answer, its time in the log
   */
  const timed = async (label, headers) => {
    const t = Date.now();
    const res = await probe.req("POST", RPC, { headers, json: { method: "session-get" }, timeoutMs: 180_000 });
    console.log(`${label}: ${res.status} after ${Date.now() - t} ms`);
    return res;
  };
  // the first session-get asks Vuze's version server and waits for it (XMWebUIPlugin.java 2820, again after 864 s) —
  // in the closed network until every transport failed; measured here before anything else
  const first = await timed("no session id", basic(PASS));
  let sessionId = first.headers["x-transmission-session-id"] ?? "";
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
  const snapshot = async state => {
    w(state, "torrent-get", await torrentGet());
    w(state, "session-get", await rpc("session-get"));
    w(state, "session-stats", await rpc("session-stats"));
    w(state, "free-space", await rpc("free-space", { path: "/downloads" }));
  };
  const list = async () => /** @type {Record<string, unknown>[]} */ (argsOf(await torrentGet()).torrents ?? []);
  const hash = name => torrentOf(ctx.work, name).hash;

  await snapshot("empty");
  // the probe: one web-seeded torrent — does the plugin take it, and does Vuze load from the seed server?
  w(
    "commands",
    "torrent-add-metainfo",
    await rpc("torrent-add", {
      metainfo: torrentOf(ctx.work, "big").torrent.toString("base64"),
      "download-dir": "/downloads",
    }),
  );
  const statuses = new Set();
  await waitFor(
    "big downloading",
    async () => {
      const t = (await list()).find(x => String(x.hashString).toLowerCase() === hash("big"));
      statuses.add(t?.status);
      return t?.status === 4 && Number(t.rateDownload) > 0;
    },
    120_000,
    1000,
  ).catch(err => console.log(`${err.message} — statuses seen: ${[...statuses].join(", ")}`));
  await snapshot("probe");
  return rec;
}
