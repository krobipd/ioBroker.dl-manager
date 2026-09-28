// pyLoad-ng in the container recorder: web login with the CSRF token, an API key made through the web UI, then
// the REST API with `X-API-Key`. The API allows 100 requests a minute per client — the waits here poll slowly.
// api-usenet-aria2-pyload.md § 4.
import { join } from "node:path";
import { Http, prepareHttpFiles, Recorder, waitFor } from "../lib.mjs";

const USER = "pyload";
const PASS = "pyload";

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag image tag
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  prepareHttpFiles(work);
  return {
    image: `lscr.io/linuxserver/pyload-ng:${tag}`,
    name: "pyload",
    env: { PUID: "1000", PGID: "1000", TZ: "Etc/UTC" },
    volumes: [`${join(work, "pyload")}:/config`, `${join(work, "downloads")}:/downloads`],
  };
}

/**
 * @param {string} html a page of the web UI
 * @returns {string | undefined} its CSRF token (hidden input or meta tag)
 */
function csrfOf(html) {
  return (/name="csrf_token" value="([^"]+)"/.exec(html) ?? /name="csrf-token" content="([^"]+)"/.exec(html))?.[1];
}

/**
 * Recorder side.
 *
 * @param {object} _ctx paths (unused)
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(_ctx) {
  const base = "http://pyload:8000";
  const web = new Http(base);
  await waitFor("pyLoad web UI", async () => (await web.req("GET", "/login")).status === 200, 300_000, 2000);

  // API key through the web UI: login form (CSRF), then generate_apikey (CSRF header)
  const loginPage = await web.req("GET", "/login");
  const token = csrfOf(loginPage.text);
  if (!token) {
    throw new Error(`no CSRF token on the login page: ${loginPage.text.slice(0, 400)}`);
  }
  await web.req("POST", "/login", { form: { username: USER, password: PASS, csrf_token: token } });
  const dash = await web.req("GET", "/dashboard");
  const token2 = csrfOf(dash.text) ?? token;
  const gen = await web.req("POST", "/json/generate_apikey", {
    headers: { "x-csrftoken": token2 },
    json: { user: USER, password: PASS, name: "download-manager-ci", expires: 0 },
  });
  const generated = gen.json();
  const key = typeof generated === "string" ? generated : (generated?.data?.key ?? generated?.key);
  if (typeof key !== "string") {
    throw new Error(`generate_apikey answered ${gen.status}: ${gen.text.slice(0, 300)}`);
  }

  const http = new Http(base);
  const get = (fn, k = key) => http.req("GET", `/api/${fn}`, { headers: { "x-api-key": k } });
  const post = (fn, body, k = key) => http.req("POST", `/api/${fn}`, { headers: { "x-api-key": k }, json: body });
  const versionRes = await get("get_server_version");
  const rec = new Recorder("pyload", String(versionRes.json()));
  const w = (state, name, request, res) => rec.write(state, name, request, res);
  w("auth", "version", "GET /api/get_server_version", versionRes);
  w("auth", "key-wrong", "GET /api/status_server (X-API-Key wrong)", await get("status_server", "pl_1wrong"));
  w("auth", "key-missing", "GET /api/status_server (no key)", await http.req("GET", "/api/status_server"));

  const READS = ["status_server", "status_downloads", "get_queue_data", "get_collector_data", "free_space"];
  const snapshot = async state => {
    for (const fn of READS) {
      w(state, fn.replace(/_/g, "-"), `GET /api/${fn}`, await get(fn));
    }
  };
  const packages = async () => (await get("get_queue_data")).json();
  const pkg = async pid => (await packages()).find(p => p.pid === pid);
  const add = (name, links) => post("add_package", { name, links, dest: 1 });

  await snapshot("empty");

  // finished and failed (404)
  const smallRes = await add("small", ["http://seed:8080/small.bin"]);
  w("commands", "add-package", "POST /api/add_package", smallRes);
  const small = smallRes.json();
  const failed = (await add("missing", ["http://seed:8080/missing.bin"])).json();
  await waitFor(
    "small finished + missing failed",
    async () => {
      const s = await pkg(small);
      const f = await pkg(failed);
      return s?.links?.every(l => l.status === 0) && f?.links?.every(l => [1, 6, 8].includes(l.status));
    },
    120_000,
    2000,
  );
  await snapshot("finished-and-failed");

  // running: pyLoad loads one file at a time only if configured — record what the default does
  const big = (await add("big", ["http://seed:8080/big.bin"])).json();
  await add("queued", ["http://seed:8080/queued.bin"]);
  await waitFor("big downloading", async () => (await pkg(big))?.links?.some(l => l.status === 12), 120_000, 2000);
  await snapshot("running");

  // abort one file (pyLoad has no per-item pause), global pause
  const bigFid = (await pkg(big)).links[0].fid;
  w("commands", "stop-downloads", "POST /api/stop_downloads", await post("stop_downloads", { file_ids: [bigFid] }));
  await waitFor("big aborted", async () => (await pkg(big))?.links?.[0]?.status === 9, 60_000, 2000);
  await snapshot("aborted");
  w("commands", "pause-server", "POST /api/pause_server", await post("pause_server", {}));
  await snapshot("paused-global");
  w("commands", "unpause-server", "POST /api/unpause_server", await post("unpause_server", {}));
  w("commands", "restart-file", "POST /api/restart_file", await post("restart_file", { file_id: bigFid }));

  // limits
  w(
    "commands",
    "set-config-limit",
    "POST /api/set_config_value",
    await post("set_config_value", { category: "download", option: "limit_speed", value: true }),
  );
  await post("set_config_value", { category: "download", option: "max_speed", value: 2000 });
  await snapshot("limited");
  await post("set_config_value", { category: "download", option: "limit_speed", value: false });

  await waitFor("big finished", async () => (await pkg(big))?.links?.every(l => l.status === 0), 180_000, 3000);
  await snapshot("finished");
  w(
    "commands",
    "delete-packages",
    "POST /api/delete_packages",
    await post("delete_packages", { package_ids: [failed] }),
  );
  return rec;
}
