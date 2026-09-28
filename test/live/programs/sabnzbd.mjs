// SABnzbd in the container recorder: API key, NServ as news server (missing articles for the failed job), a 404
// URL for the failed fetch, the speed limit to keep a download running. api-usenet-aria2-pyload.md § 1.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Http, nzbOf, prepareUsenet, Recorder, waitFor } from "../lib.mjs";

const API_KEY = "0123456789abcdef0123456789abcdef";
const NZB_KEY = "fedcba9876543210fedcba9876543210";

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag image tag
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  const nserv = prepareUsenet(work);
  mkdirSync(join(work, "sab"), { recursive: true });
  writeFileSync(
    join(work, "sab", "sabnzbd.ini"),
    [
      "__version__ = 19",
      "__encoding__ = utf-8",
      "[misc]",
      `api_key = ${API_KEY}`,
      `nzb_key = ${NZB_KEY}`,
      "host_whitelist = sab,",
      "download_dir = /downloads/incomplete",
      "complete_dir = /downloads/complete",
      "auto_disconnect = 0",
      "api_warnings = 1",
      "[servers]",
      "[[nserv]]",
      "name = nserv",
      "displayname = nserv",
      "host = nserv",
      "port = 6791",
      'username = ""',
      'password = ""',
      "connections = 2",
      "ssl = 0",
      "enable = 1",
      "",
    ].join("\n"),
  );
  return {
    image: `lscr.io/linuxserver/sabnzbd:${tag}`,
    name: "sab",
    env: { PUID: "1000", PGID: "1000", TZ: "Etc/UTC" },
    volumes: [`${join(work, "sab")}:/config`, `${join(work, "downloads")}:/downloads`],
    sidecars: [nserv],
  };
}

/**
 * Recorder side.
 *
 * @param {{ work: string }} ctx paths
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(ctx) {
  const http = new Http("http://sab:8080");
  const api = (query, o) => http.req(o ? "POST" : "GET", `/api?${query}&output=json`, o);
  const keyed = (query, o) => api(`${query}&apikey=${API_KEY}`, o);
  await waitFor("SABnzbd API", async () => (await api("mode=version")).status === 200, 180_000);

  const versionRes = await api("mode=version");
  const rec = new Recorder("sabnzbd", String(versionRes.json().version));
  const w = (state, name, request, res) => rec.write(state, name, request.replace(API_KEY, "<api-key>"), res);
  w("auth", "version", "GET /api?mode=version", versionRes);
  w("auth", "key-missing", "GET /api?mode=queue", await api("mode=queue"));
  w("auth", "key-wrong", "GET /api?mode=queue&apikey=wrong", await api("mode=queue&apikey=wrong"));
  w("auth", "auth-apikey", "GET /api?mode=auth&key=<api-key>", await api(`mode=auth&key=${API_KEY}`));
  w("auth", "auth-badkey", "GET /api?mode=auth&key=wrong", await api("mode=auth&key=wrong"));

  const READS = [
    ["queue", "mode=queue"],
    ["history", "mode=history&limit=50"],
    ["status", "mode=status&skip_dashboard=1"],
  ];
  const snapshot = async state => {
    for (const [name, q] of READS) {
      w(state, name, `GET /api?${q}&apikey=<api-key>`, await keyed(q));
    }
  };
  const add = async (name, extra = "") => {
    const form = new FormData();
    form.append("name", new Blob([nzbOf(ctx.work, name)], { type: "application/x-nzb" }), `${name}.nzb`);
    return keyed(`mode=addfile${extra}`, { body: form });
  };
  const idOf = res => res.json().nzo_ids?.[0];
  const queue = async () => (await keyed("mode=queue")).json().queue.slots;
  const history = async () => (await keyed("mode=history&limit=50")).json().history.slots;

  await snapshot("empty");

  // completed + post-processing (best effort: the stages can be shorter than a poll)
  const smallRes = await add("small");
  w("commands", "addfile", "POST /api?mode=addfile (multipart name)", smallRes);
  const smallId = idOf(smallRes);
  const ppSeen = new Set();
  await waitFor(
    "small completed",
    async () => {
      const h = (await history()).find(x => x.nzo_id === smallId);
      if (h) {
        ppSeen.add(h.status);
        if (
          h.status !== "Completed" &&
          h.status !== "Failed" &&
          !rec.written.some(f => f.includes("/postprocessing/"))
        ) {
          await snapshot("postprocessing");
        }
      }
      return h?.status === "Completed";
    },
    120_000,
    20,
  );
  console.log(`sabnzbd: history states seen for the small job: ${[...ppSeen].join(", ")}`);

  // failed: missing articles, and a URL that answers 404
  const brokenId = idOf(await add("broken"));
  const urlRes = await keyed(`mode=addurl&name=${encodeURIComponent("http://seed:8080/missing.nzb")}`);
  w("commands", "addurl", "GET /api?mode=addurl&name=http://seed:8080/missing.nzb", urlRes);
  const urlId = idOf(urlRes);
  await waitFor(
    "broken + url failed",
    async () => {
      const h = await history();
      return (
        h.some(x => x.nzo_id === brokenId && x.status === "Failed") &&
        h.some(x => x.nzo_id === urlId && x.status === "Failed")
      );
    },
    180_000,
  );
  await snapshot("finished-and-failed");

  // running: the speed limit keeps the big job downloading; one more job and one added paused (priority -2)
  w(
    "commands",
    "speedlimit",
    "GET /api?mode=config&name=speedlimit&value=1M",
    await keyed("mode=config&name=speedlimit&value=1M"),
  );
  const bigId = idOf(await add("big"));
  const queuedId = idOf(await add("queued"));
  const stoppedRes = await add("stopped", "&priority=-2");
  w("commands", "addfile-paused", "POST /api?mode=addfile&priority=-2 (multipart name)", stoppedRes);
  const stoppedId = idOf(stoppedRes);
  await waitFor(
    "big downloading",
    async () => (await queue()).find(x => x.nzo_id === bigId)?.status === "Downloading",
    60_000,
  );
  await snapshot("running");

  // single pause/resume
  w(
    "commands",
    "queue-pause",
    "GET /api?mode=queue&name=pause&value=<id>",
    await keyed(`mode=queue&name=pause&value=${queuedId}`),
  );
  await snapshot("item-paused");
  w(
    "commands",
    "queue-resume",
    "GET /api?mode=queue&name=resume&value=<id>",
    await keyed(`mode=queue&name=resume&value=${queuedId}`),
  );

  // global pause (queue slots then read "Queued")
  w("commands", "pause", "GET /api?mode=pause", await keyed("mode=pause"));
  await snapshot("paused-global");
  w("commands", "resume", "GET /api?mode=resume", await keyed("mode=resume"));

  // finish the big job
  await keyed("mode=config&name=speedlimit&value=0");
  await waitFor(
    "big completed",
    async () => (await history()).some(h => h.nzo_id === bigId && h.status === "Completed"),
    120_000,
  );
  await snapshot("finished");

  // remove: a queue job without files, a history entry
  w(
    "commands",
    "queue-delete",
    "GET /api?mode=queue&name=delete&value=<id>",
    await keyed(`mode=queue&name=delete&value=${stoppedId}`),
  );
  w(
    "commands",
    "history-delete",
    "GET /api?mode=history&name=delete&value=<id>",
    await keyed(`mode=history&name=delete&value=${brokenId}`),
  );
  await snapshot("removed");
  return rec;
}
