// NZBGet in the container recorder: JSON-RPC with basic auth, NServ as news server (missing articles for the failed
// job), a 404 URL for the failed fetch, the rate limit to keep a download running. api-usenet-aria2-pyload.md § 2.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Http, nzbOf, prepareUsenet, Recorder, sh, waitFor } from "../lib.mjs";

const USER = "admin";
const PASS = "testpass1";

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag image tag
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  const nserv = prepareUsenet(work);
  mkdirSync(join(work, "nzbget"), { recursive: true });
  // The image copies its default configuration only when /config/nzbget.conf is missing — so the default is read
  // from the image, its first news server pointed at NServ, and the file laid in before the start.
  const image = `nzbgetcom/nzbget:${tag}`;
  const defaults = sh("docker", ["run", "--rm", "--entrypoint", "cat", image, "/app/nzbget/share/nzbget/nzbget.conf"]);
  const server = {
    Active: "yes",
    Host: "nserv",
    Port: "6791",
    Encryption: "no",
    Connections: "2",
    Level: "0",
    Username: "",
    Password: "",
  };
  const conf = defaults.replace(/^Server1\.(\w+)=.*$/gm, (line, key) =>
    key in server ? `Server1.${key}=${server[key]}` : line,
  );
  const missingKeys = Object.keys(server).filter(k => !new RegExp(`^Server1\\.${k}=`, "m").test(conf));
  writeFileSync(
    join(work, "nzbget", "nzbget.conf"),
    conf + missingKeys.map(k => `Server1.${k}=${server[k]}\n`).join(""),
  );
  return {
    image,
    name: "nzbget",
    env: { NZBGET_USER: USER, NZBGET_PASS: PASS, PUID: "1000", PGID: "1000", TZ: "Etc/UTC" },
    volumes: [`${join(work, "nzbget")}:/config`, `${join(work, "downloads")}:/downloads`],
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
  const base = "http://nzbget:6789";
  const auth = pass => ({ authorization: `Basic ${Buffer.from(`${USER}:${pass}`).toString("base64")}` });
  const http = new Http(base);
  let seq = 0;
  /**
   * @param {string} method RPC method
   * @param {unknown[]} params positional params
   * @param {string} [pass] password
   * @returns {Promise<{ status: number, text: string, headers: Record<string,string>, json: () => Record<string, unknown>, sent: string }>} answer
   */
  const rpc = async (method, params = [], pass = PASS) => {
    const body = { method, params, id: ++seq };
    const res = await http.req("POST", "/jsonrpc", { headers: auth(pass), json: body });
    return { ...res, sent: JSON.stringify(body) };
  };
  const result = async (method, params) => (await rpc(method, params)).json().result;
  await waitFor("NZBGet RPC", async () => (await rpc("version")).status === 200, 180_000);

  const wrong = await rpc("version", [], "wrong");
  const versionRes = await rpc("version");
  const rec = new Recorder("nzbget", String(versionRes.json().result));
  const w = (state, name, res) => rec.write(state, name, `POST /jsonrpc ${res.sent}`, res);
  w("auth", "login-wrong", wrong);
  w("auth", "version", versionRes);

  const snapshot = async state => {
    w(state, "listgroups", await rpc("listgroups", [0]));
    w(state, "history", await rpc("history", [false]));
    w(state, "status", await rpc("status"));
  };
  const add = (name, paused = false) =>
    rpc("append", [
      `${name}.nzb`,
      Buffer.from(nzbOf(ctx.work, name)).toString("base64"),
      "",
      0,
      false,
      paused,
      "",
      0,
      "SCORE",
      false,
      [],
    ]);
  const groups = async () => result("listgroups", [0]);
  const history = async () => result("history", [false]);
  const idOf = res => res.json().result;

  await snapshot("empty");

  // completed + post-processing (best effort: the stages can be shorter than a poll)
  const smallRes = await add("small");
  w("commands", "append-file", smallRes);
  const smallId = idOf(smallRes);
  const ppSeen = new Set();
  await waitFor(
    "small completed",
    async () => {
      const g = (await groups()).find(x => x.NZBID === smallId);
      if (g) {
        ppSeen.add(g.Status);
        if (
          !/^(QUEUED|DOWNLOADING|PAUSED|FETCHING)$/.test(g.Status) &&
          !rec.written.some(f => f.includes("/postprocessing/"))
        ) {
          await snapshot("postprocessing");
        }
      }
      return (await history()).some(h => h.NZBID === smallId && /^SUCCESS/.test(h.Status));
    },
    120_000,
    20,
  );
  console.log(`nzbget: queue states seen for the small job: ${[...ppSeen].join(", ")}`);

  // failed: missing articles, and a URL that answers 404
  const brokenId = idOf(await add("broken"));
  const urlRes = await rpc("append", [
    "missing.nzb",
    "http://seed:8080/missing.nzb",
    "",
    0,
    false,
    false,
    "",
    0,
    "SCORE",
    false,
    [],
  ]);
  w("commands", "append-url", urlRes);
  const urlId = idOf(urlRes);
  await waitFor(
    "broken + url failed",
    async () => {
      const h = await history();
      return (
        h.some(x => x.NZBID === brokenId && /^(FAILURE|WARNING|DELETED)/.test(x.Status)) &&
        h.some(x => x.NZBID === urlId)
      );
    },
    180_000,
  );
  await snapshot("finished-and-failed");

  // running: rate limit keeps the big job downloading; the next waits; one added paused
  w("commands", "rate", await rpc("rate", [1024]));
  const bigId = idOf(await add("big"));
  const queuedId = idOf(await add("queued"));
  const stoppedId = idOf(await add("stopped", true));
  await waitFor(
    "big downloading",
    async () => (await groups()).find(x => x.NZBID === bigId)?.Status === "DOWNLOADING",
    60_000,
  );
  await snapshot("running");

  // single pause/resume
  w("commands", "editqueue-pause", await rpc("editqueue", ["GroupPause", "", [queuedId]]));
  await snapshot("item-paused");
  w("commands", "editqueue-resume", await rpc("editqueue", ["GroupResume", "", [queuedId]]));

  // global pause
  w("commands", "pausedownload", await rpc("pausedownload"));
  await snapshot("paused-global");
  w("commands", "resumedownload", await rpc("resumedownload"));

  // finish the big job
  await rpc("rate", [0]);
  await waitFor("big completed", async () => (await history()).some(h => h.NZBID === bigId), 120_000);
  await snapshot("finished");

  // remove: queue job (files stay parked) and a history entry
  w("commands", "editqueue-park-delete", await rpc("editqueue", ["GroupParkDelete", "", [stoppedId]]));
  w("commands", "editqueue-history-delete", await rpc("editqueue", ["HistoryDelete", "", [brokenId]]));
  await snapshot("removed");
  return rec;
}
