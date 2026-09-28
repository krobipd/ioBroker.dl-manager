// Deluge in the container recorder: deluge-web JSON-RPC (password only), web.connect to the daemon, the same
// torrents as the other torrent programs, global session pause, Label plugin. api-torrent.md § 3.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEAD_MAGNET, DEAD_MAGNET_HASH, Http, prepareTorrents, Recorder, torrentOf, waitFor } from "../lib.mjs";

const PASS = "deluge";

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag image tag
 * @returns {{ image: string, name: string, env: Record<string,string>, volumes: string[] }} container
 */
export function prepare(work, tag) {
  prepareTorrents(work);
  mkdirSync(join(work, "deluge"), { recursive: true });
  return {
    image: `lscr.io/linuxserver/deluge:${tag}`,
    name: "deluge",
    env: { PUID: "1000", PGID: "1000", TZ: "Etc/UTC" },
    volumes: [`${join(work, "deluge")}:/config`, `${join(work, "downloads")}:/downloads`],
  };
}

const KEYS = [
  "hash",
  "name",
  "state",
  "progress",
  "total_wanted",
  "total_done",
  "total_size",
  "total_remaining",
  "download_payload_rate",
  "upload_payload_rate",
  "eta",
  "ratio",
  "time_added",
  "completed_time",
  "message",
  "is_finished",
  "paused",
  "total_uploaded",
  "all_time_download",
  "download_location",
  "tracker_status",
  "queue",
  "label",
];

/**
 * Recorder side.
 *
 * @param {{ work: string }} ctx paths
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(ctx) {
  const base = "http://deluge:8112";
  let seq = 0;
  /**
   * @param {Http} h client
   * @param {string} method RPC method
   * @param {unknown[]} params positional params
   * @returns {Promise<{ status: number, text: string, headers: Record<string,string>, json: () => Record<string, unknown>, sent: string }>} answer
   */
  const call = async (h, method, params = []) => {
    const body = { method, params, id: ++seq };
    const res = await h.req("POST", "/json", { json: body });
    return { ...res, sent: JSON.stringify(body) };
  };
  const probe = new Http(base);
  await waitFor("deluge-web", async () => (await call(probe, "auth.check_session")).status === 200, 180_000);

  const wrong = await call(new Http(base), "auth.login", ["wrong"]);
  const missing = await call(new Http(base), "web.update_ui", [KEYS, {}]);
  const d = new Http(base);
  const login = await call(d, "auth.login", [PASS]);
  if (login.json().result !== true) {
    throw new Error(`login failed: ${login.text}`);
  }
  const rpc = (method, params) => call(d, method, params);
  const result = async (method, params) => (await rpc(method, params)).json().result;

  const hosts = await rpc("web.get_hosts");
  const hostId = hosts.json().result[0][0];
  const status = await waitFor("daemon online", async () => {
    const r = await rpc("web.get_host_status", [hostId]);
    return /Online|Connected/.test(JSON.stringify(r.json().result)) ? r : null;
  });
  const connect = await rpc("web.connect", [hostId]);
  await waitFor("web connected", async () => (await result("web.connected")) === true);
  const version = String(status.json().result[2] ?? "unknown");
  const rec = new Recorder("deluge", version);
  const w = (state, name, res) => rec.write(state, name, `POST /json ${res.sent}`, res);
  w("auth", "login-wrong", wrong);
  w("auth", "login-ok", login);
  w("auth", "session-missing", missing);
  w("auth", "get-hosts", hosts);
  w("auth", "get-host-status", status);
  w("auth", "connect", connect);

  await rpc("core.set_config", [
    {
      dht: false,
      lsd: false,
      utpex: false,
      upnp: false,
      natpmp: false,
      download_location: "/downloads",
      max_active_downloading: 1,
      max_active_limit: 20,
      max_active_seeding: 20,
      dont_count_slow_torrents: false,
    },
  ]);
  const labelPlugin = await rpc("core.enable_plugin", ["Label"]);
  w("commands", "enable-plugin-label", labelPlugin);

  const snapshot = async state => {
    w(state, "update-ui", await rpc("web.update_ui", [KEYS, {}]));
    w(
      state,
      "config-values",
      await rpc("core.get_config_values", [["max_download_speed", "max_upload_speed", "download_location"]]),
    );
    w(state, "is-session-paused", await rpc("core.is_session_paused"));
  };
  const torrents = async () => (await result("web.update_ui", [KEYS, {}]))?.torrents ?? {};
  const hash = name => torrentOf(ctx.work, name).hash;
  const stateOf = async h => (await torrents())[h]?.state;
  const add = (name, options = {}) =>
    rpc("core.add_torrent_file", [
      `${name}.torrent`,
      torrentOf(ctx.work, name).torrent.toString("base64"),
      { download_location: "/downloads", ...options },
    ]);

  await snapshot("empty");
  w("commands", "add-torrent-file", await add("big"));
  await waitFor("big downloading", async () => (await stateOf(hash("big"))) === "Downloading", 120_000);
  await add("queued");
  await add("stopped", { add_paused: true });
  for (const name of ["done", "gone", "check"]) {
    await add(name);
  }
  w(
    "commands",
    "add-torrent-magnet",
    await rpc("core.add_torrent_magnet", [DEAD_MAGNET, { download_location: "/downloads" }]),
  );
  await waitFor(
    "mixed states",
    async () => {
      const t = await torrents();
      return (
        t[hash("queued")]?.state === "Queued" &&
        t[hash("stopped")]?.state === "Paused" &&
        t[hash("done")]?.state === "Seeding" &&
        t[hash("check")]?.state === "Seeding"
      );
    },
    180_000,
  );
  try {
    w("commands", "label-add", await rpc("label.add", ["linux"]));
    w("commands", "label-set-torrent", await rpc("label.set_torrent", [hash("done"), "linux"]));
  } catch (err) {
    console.log(`label plugin not usable: ${err.message}`);
  }
  await snapshot("running");

  // loading metadata: take the magnet out of the queue and start it
  await rpc("core.set_torrent_options", [[DEAD_MAGNET_HASH], { auto_managed: false }]);
  w("commands", "resume-torrent", await rpc("core.resume_torrent", [[DEAD_MAGNET_HASH]]));
  await waitFor("magnet downloading", async () => (await stateOf(DEAD_MAGNET_HASH)) === "Downloading");
  await snapshot("metadata");
  w("commands", "pause-torrent", await rpc("core.pause_torrent", [[DEAD_MAGNET_HASH]]));

  // checking
  w("commands", "force-recheck", await rpc("core.force_recheck", [[hash("check")]]));
  const seen = new Set();
  await waitFor(
    "check checking",
    async () => {
      const st = await stateOf(hash("check"));
      seen.add(st);
      return st === "Checking";
    },
    30_000,
    20,
  ).catch(err => {
    throw new Error(`${err.message} — states seen: ${[...seen].join(", ")}`);
  });
  await snapshot("checking");

  // failed: payload gone, recheck
  rmSync(join(ctx.work, "downloads", "gone.bin"));
  await rpc("core.force_recheck", [[hash("gone")]]);
  await waitFor(
    "gone failing",
    async () => {
      const t = (await torrents())[hash("gone")];
      return t && (t.state === "Error" || (t.state !== "Checking" && t.progress < 100));
    },
    60_000,
  );
  await snapshot("missing");

  // completed: pause the finished one
  await rpc("core.pause_torrent", [[hash("done")]]);
  await waitFor("done paused", async () => (await stateOf(hash("done"))) === "Paused");
  await snapshot("completed");
  await rpc("core.resume_torrent", [[hash("done")]]);

  // global session pause
  w("commands", "pause-session", await rpc("core.pause_session"));
  await snapshot("session-paused");
  w("commands", "resume-session", await rpc("core.resume_session"));

  // limits (KiB/s, -1 = unlimited); Deluge has no alternative speed in its core
  w(
    "commands",
    "set-config-limits",
    await rpc("core.set_config", [{ max_download_speed: 2000.0, max_upload_speed: 500.0 }]),
  );
  await snapshot("limited");
  await rpc("core.set_config", [{ max_download_speed: -1.0, max_upload_speed: -1.0 }]);

  // seeding
  await waitFor("big seeding", async () => (await stateOf(hash("big"))) === "Seeding", 240_000, 1000);
  await snapshot("finished");

  w("commands", "remove-torrent", await rpc("core.remove_torrent", [hash("queued"), false]));
  return rec;
}
