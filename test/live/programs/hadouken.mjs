// Hadouken in the container recorder: Hadouken 5.2.0 (the last release, 2015, libtorrent 1.0.5) built from its tag in
// the image mediadepot/hadouken — the JSON-RPC API Sonarr's Hadouken client talks to (HadoukenProxy.cs: POST
// `<urlBase>/api` with basic auth, `core.getSystemInfo`, `webui.list`, `webui.getSettings`, `webui.addTorrent`,
// `webui.perform`). The image has no start command of its own (`CMD sh`); the binary takes the path of its JSON
// configuration (src/main.cpp `--config`, template dist/linux/hadouken.json.template).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEAD_MAGNET, DEAD_MAGNET_HASH, Http, prepareTorrents, Recorder, torrentOf, waitFor } from "../lib.mjs";

const USER = "admin";
const PASS = "testpass1";

/** What each matrix tag starts: the image pinned by its digest (Docker Hub, measured 2026-11-15). */
const IMAGES = {
  // mediadepot/hadouken:latest, built 2018-11-22 from the tag v5.2.0 (Alpine, boost 1.58, libtorrent 1.0.5)
  "5.2.0": "mediadepot/hadouken@sha256:5332a2cb8caeb36d0f68c63b2dd1b95ce83cfc110280c89ef2ae3c83e48a683f",
};

/** Where the image's build left Hadouken (docker-hadouken linux_build.sh: linux/build/bin with js/ and webui.zip). */
const BIN = "/srv/hadouken/app/linux/build/bin";

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag matrix tag (a key of IMAGES)
 * @returns {{ image: string, name: string, entrypoint: string, args: string[], volumes: string[] }} container
 */
export function prepare(work, tag) {
  const image = IMAGES[tag];
  if (!image) {
    throw new Error(`hadouken: no image pinned for ${tag}`);
  }
  prepareTorrents(work);
  const config = join(work, "hadouken-config");
  mkdirSync(join(config, "state"), { recursive: true, mode: 0o777 });
  // the template's keys (dist/linux/hadouken.json.template); no DHT, UPnP or LSD inside the internal network
  const cfg = {
    bittorrent: {
      defaultSavePath: "/data",
      statePath: "/srv/hadouken/config/state",
      dht: { enabled: false },
      lsd: { enabled: false },
      natpmp: { enabled: false },
      upnp: { enabled: false },
    },
    http: {
      address: "0.0.0.0",
      port: 7070,
      auth: { basic: { userName: USER, password: PASS } },
      root: "/",
      webui: { path: `${BIN}/webui.zip` },
    },
    scripting: { path: `${BIN}/js` },
  };
  writeFileSync(join(config, "hadouken.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  return {
    image,
    name: "hadouken",
    entrypoint: `${BIN}/hadouken`,
    args: ["--config", "/srv/hadouken/config/hadouken.json"],
    volumes: [`${config}:/srv/hadouken/config`, `${join(work, "downloads")}:/data`],
  };
}

/** Row fields (js/rpc/webui_list.js), by position — the layout of µTorrent's list. */
const ROW = { hash: 0, status: 1, name: 2, size: 3, progress: 4, downSpeed: 9, eta: 10, error: 21 };

/** A second magnet nobody seeds — added paused while the first one is in the list already. */
const PAUSED_MAGNET_HASH = "fedcba9876543210fedcba9876543210fedcba98";
const PAUSED_MAGNET = `magnet:?xt=urn:btih:${PAUSED_MAGNET_HASH}&dn=added-paused`;

/**
 * Recorder side.
 *
 * @param {{ work: string }} ctx paths
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(ctx) {
  const http = new Http("http://hadouken:7070");
  const basic = pass => ({ Authorization: `Basic ${Buffer.from(`${USER}:${pass}`).toString("base64")}` });
  let id = 0;
  /**
   * One JSON-RPC call.
   *
   * @param {string} method RPC method
   * @param {unknown[]} [params] positional parameters
   * @param {Record<string,string>} [headers] request headers (basic auth with the password by default)
   * @returns {Promise<Awaited<ReturnType<Http["req"]>> & { sent: string }>} the answer and the request as recorded
   */
  const rpc = async (method, params = [], headers = basic(PASS)) => {
    id++;
    const res = await http.req("POST", "/api", { json: { jsonrpc: "2.0", id, method, params }, headers });
    return { ...res, sent: `POST /api ${method} ${JSON.stringify(params)}` };
  };
  await waitFor("Hadouken API", async () => (await http.req("POST", "/api", { json: {} })).status > 0, 120_000);
  await waitFor("Hadouken scripts", async () => (await rpc("core.getSystemInfo")).status === 200, 60_000);

  const info = await rpc("core.getSystemInfo");
  console.log(`getSystemInfo: ${info.status} ${info.text}`);
  const versions = /** @type {{ result?: { versions?: { hadouken?: string } } }} */ (info.json()).result?.versions;
  const rec = new Recorder("hadouken", String(versions?.hadouken ?? "unknown"));
  const w = (state, name, res) => rec.write(state, name, res.sent, res);

  // basic auth only: src/http/http_server.cpp looks for the header named exactly "Authorization"
  w("auth", "none", await rpc("core.getSystemInfo", [], {}));
  w("auth", "wrong", await rpc("core.getSystemInfo", [], basic("wrong")));
  w("auth", "lowercase-header", await rpc("core.getSystemInfo", [], { authorization: basic(PASS).Authorization }));
  w("probe", "get-system-info", info);
  w("probe", "introspect", await rpc("core.introspect"));
  w("probe", "unknown-method", await rpc("webui.nonsense"));

  const list = async () =>
    /** @type {unknown[][]} */ (
      /** @type {{ result?: { torrents?: unknown[][] } }} */ ((await rpc("webui.list")).json()).result?.torrents ?? []
    );
  const snapshot = async state => {
    w(state, "list", await rpc("webui.list"));
    w(state, "get-settings", await rpc("webui.getSettings"));
  };
  const hash = name => torrentOf(ctx.work, name).hash.toLowerCase();
  const find = async h => (await list()).find(t => String(t[ROW.hash]).toLowerCase() === h);
  const seen = new Map();
  /**
   * @param {string} h info hash
   * @returns {Promise<number | undefined>} its status bits now (and remembers each one seen)
   */
  const statusOf = async h => {
    const t = await find(h);
    const st = typeof t?.[ROW.status] === "number" ? /** @type {number} */ (t[ROW.status]) : undefined;
    const name = String(t?.[ROW.name] ?? h);
    seen.set(name, [...new Set([...(seen.get(name) ?? []), `${String(st)} ${String(t?.[ROW.error] ?? "")}`])]);
    return st;
  };
  /**
   * Waits for a state and goes on without it — one run records every state Hadouken reaches, the log names the rest.
   *
   * @param {string} what the state
   * @param {() => Promise<boolean>} probe reached?
   * @param {number} timeoutMs how long
   * @returns {Promise<boolean>} reached
   */
  const reach = async (what, probe, timeoutMs) => {
    try {
      await waitFor(what, probe, timeoutMs, 1000);
      return true;
    } catch (err) {
      const t = await list();
      const why = err instanceof Error ? err.message : String(err);
      console.log(
        `NOT REACHED ${what}: ${why} — ${t.map(x => `${String(x[ROW.name])}:${String(x[ROW.status])}:${String(x[ROW.progress])}:${String(x[ROW.error])}`).join(" ")}`,
      );
      return false;
    }
  };
  /**
   * @param {string[]} hashes info hashes
   * @returns {Promise<Record<string, unknown>>} auto_managed of each (webui_getProperties.js)
   */
  const managed = async hashes => {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const h of hashes) {
      const body = /** @type {{ result?: { props?: { auto_managed?: unknown }[] } }} */ (
        (await rpc("webui.getProperties", [h])).json()
      );
      out[h] = body.result?.props?.[0]?.auto_managed;
    }
    return out;
  };
  const addFile = (name, params = {}) =>
    rpc("webui.addTorrent", ["file", torrentOf(ctx.work, name).torrent.toString("base64"), params]);

  await snapshot("empty");
  w("commands", "add-file", await addFile("big", { label: "" }));
  await reach(
    "big loading",
    async () => {
      const t = await find(hash("big"));
      return t !== undefined && (Number(t[ROW.status]) & 1) === 1 && Number(t[ROW.downSpeed]) > 0;
    },
    120_000,
  );
  await addFile("queued");
  // added paused (webui_addTorrent.js: `paused` clears flag_auto_managed and sets flag_paused)
  w("commands", "add-file-paused", await addFile("stopped", { paused: true }));
  await reach("stopped paused", async () => (((await statusOf(hash("stopped"))) ?? 0) & 32) === 32, 15_000);
  await snapshot("downloading");

  for (const name of ["done", "gone", "check"]) {
    await addFile(name);
  }
  w("commands", "add-url-magnet", await rpc("webui.addTorrent", ["url", DEAD_MAGNET, {}]));
  w("commands", "add-url-magnet-paused", await rpc("webui.addTorrent", ["url", PAUSED_MAGNET, { paused: true }]));
  w("commands", "add-url-duplicate", await rpc("webui.addTorrent", ["url", DEAD_MAGNET, {}]));
  await reach(
    "present payloads seeding",
    async () => {
      const t = await Promise.all(["done", "gone", "check"].map(n => find(hash(n))));
      for (const n of ["done", "gone", "check"]) {
        await statusOf(hash(n));
      }
      return t.every(x => x !== undefined && Number(x[ROW.progress]) === 1000);
    },
    300_000,
  );
  await snapshot("running");

  w("commands", "set-properties-label", await rpc("webui.setProperties", [[hash("done")], { label: "tv" }]));
  // the magnet without metadata, forced (webui_perform.js `forcestart`: auto-managed off, resume)
  w("commands", "forcestart", await rpc("webui.perform", ["forcestart", [DEAD_MAGNET_HASH]]));
  await new Promise(r => setTimeout(r, 3000));
  await snapshot("metadata");

  // the actions µTorrent's Web UI sends and Hadouken 5.2.0 does not know (webui_perform.js `default`), and an unknown hash
  w("probe", "perform-unpause", await rpc("webui.perform", ["unpause", [hash("big")]]));
  w("probe", "perform-stop", await rpc("webui.perform", ["stop", [hash("big")]]));
  w("probe", "perform-unknown-hash", await rpc("webui.perform", ["pause", ["f".repeat(40)]]));

  // pause on an auto-managed torrent: libtorrent's queue may resume it — seen right after and five seconds later
  const big = hash("big");
  console.log("big before pause:", JSON.stringify(await managed([big])));
  w("commands", "pause", await rpc("webui.perform", ["pause", [big]]));
  await new Promise(r => setTimeout(r, 1000));
  await statusOf(big);
  await snapshot("pause-managed");
  await new Promise(r => setTimeout(r, 5000));
  await statusOf(big);
  await snapshot("pause-managed-later");
  // auto-managed off, then pause: status bit 32 (webui_list.js: paused = paused and not auto-managed)
  w("commands", "set-properties-unmanaged", await rpc("webui.setProperties", [[big], { auto_managed: false }]));
  await rpc("webui.perform", ["pause", [big]]);
  await reach("big paused", async () => (((await statusOf(big)) ?? 0) & 32) === 32, 15_000);
  await new Promise(r => setTimeout(r, 3000));
  await snapshot("paused");
  w("probe", "get-properties-paused", await rpc("webui.getProperties", [big]));
  w("commands", "start", await rpc("webui.perform", ["start", [big]]));
  await reach("big started", async () => (((await statusOf(big)) ?? 0) & 1) === 1, 15_000);
  w("probe", "get-properties-started", await rpc("webui.getProperties", [big]));
  w("commands", "set-properties-managed", await rpc("webui.setProperties", [[big], { auto_managed: true }]));
  w("probe", "get-properties-managed", await rpc("webui.getProperties", [big]));

  // checking (webui_perform.js `recheck`: libtorrent's force_recheck)
  const check = hash("check");
  w("commands", "recheck", await rpc("webui.perform", ["recheck", [check]]));
  await reach("check checking", async () => (((await statusOf(check)) ?? 0) & 2) === 2, 30_000);
  await snapshot("checking");
  await reach("check checked", async () => (((await statusOf(check)) ?? 2) & 2) === 0, 180_000);

  // error: the paused one's file is a folder when it starts — libtorrent cannot write and stops it with its error
  const stopped = hash("stopped");
  mkdirSync(join(ctx.work, "downloads", "stopped.bin"), { recursive: true });
  await rpc("webui.perform", ["start", [stopped]]);
  await reach("stopped failing", async () => (((await statusOf(stopped)) ?? 0) & 16) === 16, 90_000);
  await snapshot("error");

  // completed: a finished one paused (the seed goal pauses so, core.js: auto-managed off, pause)
  const done = hash("done");
  await rpc("webui.setProperties", [[done], { auto_managed: false }]);
  await rpc("webui.perform", ["pause", [done]]);
  await reach("done paused", async () => (((await statusOf(done)) ?? 0) & 32) === 32, 15_000);
  await snapshot("completed");
  await rpc("webui.perform", ["start", [done]]);
  await rpc("webui.setProperties", [[done], { auto_managed: true }]);

  // limits: webui_getSettings.js / webui_setSettings.js hand libtorrent's session settings through unchanged
  w("commands", "set-settings-limits", await rpc("webui.setSettings", [{ max_dl_rate: 2048000, max_ul_rate: 512000 }]));
  await snapshot("limited");
  w("commands", "set-settings-unlimited", await rpc("webui.setSettings", [{ max_dl_rate: 0, max_ul_rate: 0 }]));
  await snapshot("unlimited");

  // seeding: the web-seeded download finishes
  await reach(
    "big seeding",
    async () => {
      const t = await find(big);
      await statusOf(big);
      return t !== undefined && Number(t[ROW.progress]) === 1000 && (Number(t[ROW.status]) & 1) === 1;
    },
    900_000,
  );
  await snapshot("finished");

  // the emulated pause: every started or queued one not paused — auto-managed off, pause; then start and auto-managed
  // back on for those that were
  const before = new Map((await list()).map(t => [String(t[ROW.hash]), Number(t[ROW.status])]));
  console.log("before pause-list:", JSON.stringify(Object.fromEntries(before)));
  const pausable = [...before].filter(([, st]) => (st & 32) === 0 && (st & (1 | 64)) !== 0).map(([h]) => h);
  const was = await managed(pausable);
  console.log("auto-managed before pause-list:", JSON.stringify(was));
  w("commands", "set-properties-unmanaged-list", await rpc("webui.setProperties", [pausable, { auto_managed: false }]));
  w("commands", "pause-list", await rpc("webui.perform", ["pause", pausable]));
  await reach(
    "listed paused",
    async () =>
      (await list())
        .filter(t => pausable.includes(String(t[ROW.hash])))
        .every(t => (Number(t[ROW.status]) & 32) === 32),
    30_000,
  );
  await new Promise(r => setTimeout(r, 5000));
  await snapshot("all-paused");
  w("commands", "start-list", await rpc("webui.perform", ["start", pausable]));
  const back = pausable.filter(h => was[h] === true);
  w("commands", "set-properties-managed-list", await rpc("webui.setProperties", [back, { auto_managed: true }]));
  await reach(
    "listed started",
    async () =>
      (await list()).every(t => (Number(t[ROW.status]) & 32) === 0 || !pausable.includes(String(t[ROW.hash]))),
    30_000,
  );
  await new Promise(r => setTimeout(r, 3000));
  await snapshot("resumed");
  console.log("auto-managed after start-list:", JSON.stringify(await managed(pausable)));
  console.log(
    "after start-list:",
    JSON.stringify(Object.fromEntries((await list()).map(t => [String(t[ROW.hash]), t[ROW.status]]))),
  );

  // remove one without its data (webui_perform.js `remove`), then an unknown hash
  w("commands", "remove", await rpc("webui.perform", ["remove", [hash("queued")]]));
  w("commands", "remove-unknown", await rpc("webui.perform", ["remove", ["f".repeat(40)]]));
  await new Promise(r => setTimeout(r, 2000));
  await snapshot("removed");
  console.log("statuses seen:", JSON.stringify(Object.fromEntries(seen)));
  return rec;
}
