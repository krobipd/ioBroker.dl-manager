// µTorrent in the container recorder: µTorrent Server for Linux (utserver alpha 3.3, the last Linux build BitTorrent
// published) in the image ekho/utorrent, with its built-in Web UI — the API Sonarr's UTorrent client talks to
// (UTorrentProxy.cs: `/gui/token.html` with basic auth, then `/gui/?token=…&list=1` and `action=…` with the GUID
// cookie of the token request). The image's entrypoint writes utserver.conf from its environment
// (confd/templates/utserver.conf.tmpl: `admin_name`, `admin_password`, `dir_active` /data).
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEAD_MAGNET,
  DEAD_MAGNET_HASH,
  Http,
  prepareTorrents,
  Recorder,
  pull,
  sh,
  torrentOf,
  waitFor,
} from "../lib.mjs";

const USER = "admin";
const PASS = "testpass1";

/** What each matrix tag starts: the image pinned by its digest (Docker Hub, measured 2026-11-15). */
const IMAGES = {
  // ekho/utorrent:latest, built 2021-04-22 from Ubuntu trusty with utserver for linux-x64-ubuntu-13-04
  "2021-04-22": "ekho/utorrent@sha256:38d8890638c4f3677444f1d0656ca14b5885a4228b3783c55e5d7f18da6b28e8",
};

/**
 * Prints what the image's own Web UI makes of the status bits — the program's reading of its flags, for the status
 * table of the driver.
 *
 * @param {string} work work directory
 * @param {string} image image reference
 */
function showWebUiStatus(work, image) {
  const dir = join(work, "webui-src");
  mkdirSync(dir, { recursive: true });
  try {
    pull(image);
    sh("docker", ["create", "--name", "ut-src", image]);
    sh("docker", ["cp", "ut-src:/utorrent/webui/builtin/webui.zip", join(work, "webui.zip")]);
    sh("docker", ["rm", "ut-src"]);
    sh("unzip", ["-q", "-o", join(work, "webui.zip"), "-d", dir]);
  } catch (err) {
    console.log(`webui source not readable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const files = [];
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (p.endsWith(".js")) {
        files.push(p);
      }
    }
  };
  walk(dir);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const needle of ["STATE_STARTED", "getStatusInfo", "OV_FL_FINISHED", "OV_FL_STOPPED"]) {
      let at = text.indexOf(needle);
      let shown = 0;
      while (at >= 0 && shown < 3) {
        console.log(`---- ${f.slice(dir.length)} @${at} (${needle}) ----`);
        console.log(text.slice(Math.max(0, at - 300), at + 1500));
        at = text.indexOf(needle, at + 1500);
        shown++;
      }
    }
  }
}

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag matrix tag (a key of IMAGES)
 * @returns {{ image: string, name: string, env: Record<string,string>, volumes: string[] }} container
 */
export function prepare(work, tag) {
  const image = IMAGES[tag];
  if (!image) {
    throw new Error(`utorrent: no image pinned for ${tag}`);
  }
  prepareTorrents(work);
  showWebUiStatus(work, image);
  return {
    image,
    name: "utorrent",
    env: { admin_name: USER, admin_password: PASS },
    // dir_active and dir_completed are /data (the template's default) — the payloads of done, gone and check lie there
    volumes: [`${join(work, "downloads")}:/data`],
  };
}

/** Row fields Sonarr reads (UTorrentTorrent.cs `UTorrentTorrentJsonConverter`), by position. */
const ROW = { hash: 0, status: 1, name: 2, progress: 4, downSpeed: 9, label: 11, statusMessage: 21 };

/**
 * Recorder side.
 *
 * @param {{ work: string }} ctx paths
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(ctx) {
  const base = "http://utorrent:8080";
  const basic = pass => ({ Authorization: `Basic ${Buffer.from(`${USER}:${pass}`).toString("base64")}` });
  await waitFor(
    "µTorrent Web UI",
    async () => (await new Http(base).req("GET", "/gui/token.html")).status > 0,
    120_000,
  );

  /**
   * A token request in a cookie jar of its own.
   *
   * @param {Record<string,string>} headers request headers
   * @returns {Promise<{ http: Http, res: Awaited<ReturnType<Http["req"]>>, token: string | undefined }>} jar, answer, token
   */
  const login = async headers => {
    const http = new Http(base);
    const res = await http.req("GET", "/gui/token.html", { headers });
    const m = /<div[^>]*id=['"]token['"][^>]*>([^<]*)<\/div>/.exec(res.text);
    console.log(`token.html: ${res.status} ${res.text.slice(0, 200).replace(m?.[1] ?? "\0", "<token>")}`);
    return { http, res, token: m?.[1] };
  };
  const wrong = await login(basic("wrong"));
  const none = await login({});
  const good = await login(basic(PASS));
  if (!good.token) {
    throw new Error(`no token in token.html (status ${good.res.status})`);
  }
  const http = good.http;
  const token = good.token;
  console.log(`cookies of the token request: ${[...http.cookies.keys()].join(", ")}`);

  /**
   * One Web UI call with the token and the jar of the token request.
   *
   * @param {string} query query after the token
   * @param {{ method?: string, body?: FormData, jar?: Http, tok?: string | null, headers?: Record<string,string> }} [o] options
   * @returns {Promise<Awaited<ReturnType<Http["req"]>> & { sent: string }>} the answer and the request as recorded
   */
  const gui = async (query, o = {}) => {
    const method = o.method ?? "GET";
    const tok = o.tok === undefined ? token : o.tok;
    const head = tok === null ? "/gui/?" : `/gui/?token=${encodeURIComponent(tok)}&`;
    const res = await (o.jar ?? http).req(method, `${head}${query}`, {
      headers: o.headers ?? basic(PASS),
      body: o.body,
    });
    const shown = tok === null ? "/gui/?" : tok === token ? "/gui/?token=<token>&" : `/gui/?token=${tok}&`;
    return { ...res, sent: `${method} ${shown}${query}` };
  };

  // what a call without the token, with a foreign token and without the token's cookie gets — the driver's "log in again"
  const noToken = await gui("list=1", { tok: null });
  const badToken = await gui("list=1", { tok: "x".repeat(64) });
  const noCookie = await gui("list=1", { jar: new Http(base) });
  const noAuth = await gui("list=1", { headers: {} });

  const settingsOf = res => {
    const body = /** @type {{ build?: number, settings?: unknown[][] }} */ (res.json());
    return { build: body.build, settings: new Map((body.settings ?? []).map(s => [String(s[0]), s[2]])) };
  };
  const first = await gui("action=getsettings");
  const { build, settings } = settingsOf(first);
  console.log(`build ${String(build)}`);
  for (const [k, v] of settings) {
    if (/active|rate|limit|version|dir_|start|queue/.test(k)) {
      console.log(`  setting ${k} = ${JSON.stringify(v)}`);
    }
  }
  const version = await gui("action=getversion");
  console.log(`getversion: ${version.status} ${version.text.slice(0, 400)}`);
  // run 43684224740: utserver 30470 answers getversion with major/minor/tiny_version beside the build
  let label = `build-${String(build)}`;
  try {
    const v = /** @type {{ version?: Record<string, unknown> }} */ (version.json()).version;
    if (v && typeof v.major_version === "number") {
      label = `${String(v.major_version)}.${String(v.minor_version)}.${String(v.tiny_version)}.${String(build)}`;
    }
  } catch {
    // a build without getversion — the build number names the recording
  }
  // what a build without getversion would answer: an action utserver does not know
  const unknownAction = await gui("action=nonsense");
  const rec = new Recorder("utorrent", label);
  const w = (state, name, res) => rec.write(state, name, res.sent, res);
  rec.write("auth", "token-wrong", "GET /gui/token.html (basic auth, wrong password)", wrong.res);
  rec.write("auth", "token-none", "GET /gui/token.html (no basic auth)", none.res);
  rec.write("auth", "token", "GET /gui/token.html (basic auth)", {
    ...good.res,
    text: good.res.text.replace(token, "<token>"),
  });
  w("auth", "no-token", noToken);
  w("auth", "bad-token", badToken);
  w("auth", "no-cookie", noCookie);
  w("auth", "no-auth", noAuth);
  w("probe", "getversion", version);
  w("probe", "unknown-action", unknownAction);

  const list = async () =>
    /** @type {unknown[][]} */ (
      /** @type {{ torrents?: unknown[][] }} */ ((await gui("list=1")).json()).torrents ?? []
    );
  const snapshot = async state => {
    w(state, "list", await gui("list=1"));
    w(state, "getsettings", await gui("action=getsettings"));
  };
  const hash = name => torrentOf(ctx.work, name).hash.toUpperCase();
  const find = async h => (await list()).find(t => String(t[ROW.hash]).toUpperCase() === h);
  const seen = new Map();
  /**
   * @param {string} name torrent
   * @returns {Promise<number | undefined>} its status bits now (and remembers each one seen)
   */
  const statusOf = async name => {
    const t = await find(hash(name));
    const st = typeof t?.[ROW.status] === "number" ? /** @type {number} */ (t[ROW.status]) : undefined;
    seen.set(name, [...new Set([...(seen.get(name) ?? []), `${String(st)} ${String(t?.[ROW.statusMessage] ?? "")}`])]);
    return st;
  };
  /**
   * Waits for a state and goes on without it — one run records every state µTorrent reaches, the log names the rest.
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
        `NOT REACHED ${what}: ${why} — ${t.map(x => `${String(x[ROW.name])}:${String(x[ROW.status])}:${String(x[ROW.statusMessage])}`).join(" ")}`,
      );
      return false;
    }
  };
  const add = name => {
    const fd = new FormData();
    fd.append(
      "torrent_file",
      new Blob([torrentOf(ctx.work, name).torrent], { type: "application/x-bittorrent" }),
      `${name}.torrent`,
    );
    return gui("action=add-file&path=", { method: "POST", body: fd });
  };
  const hashes = names => names.map(n => `hash=${hash(n)}`).join("&");

  await snapshot("empty");
  // one download at a time, so the next one queues (µTorrent's settings max_active_downloads / max_active_torrent)
  w(
    "commands",
    "setsetting-queue",
    await gui("action=setsetting&s=max_active_downloads&v=1&s=max_active_torrent&v=10"),
  );
  w("commands", "add-file", await add("big"));
  await reach(
    "big loading",
    async () => {
      const t = await find(hash("big"));
      return t !== undefined && (Number(t[ROW.status]) & 1) === 1 && Number(t[ROW.downSpeed]) > 0;
    },
    120_000,
  );
  await add("queued");
  await add("stopped");
  w("commands", "stop", await gui(`action=stop&${hashes(["stopped"])}`));
  await reach(
    "queued waiting",
    async () => {
      const st = await statusOf("queued");
      return st !== undefined && (st & 64) === 64 && (st & 1) === 0;
    },
    30_000,
  );
  await reach("stopped stopped", async () => ((await statusOf("stopped")) ?? 1) % 2 === 0, 15_000);
  await snapshot("downloading");

  for (const name of ["done", "gone", "check"]) {
    await add(name);
  }
  w("commands", "add-url-magnet", await gui(`action=add-url&s=${encodeURIComponent(DEAD_MAGNET)}`));
  await reach(
    "present payloads seeding",
    async () => {
      const t = await Promise.all(["done", "gone", "check"].map(n => find(hash(n))));
      for (const n of ["done", "gone", "check"]) {
        await statusOf(n);
      }
      return t.every(x => x !== undefined && Number(x[ROW.progress]) === 1000);
    },
    180_000,
  );
  await snapshot("running");

  // a label on done (the row's label field)
  w("commands", "setprops-label", await gui(`action=setprops&${hashes(["done"])}&s=label&v=tv`));
  // the magnet without metadata, forced past the queue
  w("commands", "forcestart", await gui(`action=forcestart&hash=${DEAD_MAGNET_HASH.toUpperCase()}`));
  await new Promise(r => setTimeout(r, 5000));
  await snapshot("metadata");

  // paused (µTorrent's own pause, status bit 32) and back
  w("commands", "pause", await gui(`action=pause&${hashes(["big"])}`));
  await reach("big paused", async () => (((await statusOf("big")) ?? 0) & 32) === 32, 15_000);
  await snapshot("paused");
  w("commands", "unpause", await gui(`action=unpause&${hashes(["big"])}`));

  // checking: run 43684224740 sent recheck to the seeding torrent and it went on seeding — stopped first
  await gui(`action=stop&${hashes(["check"])}`);
  await reach("check stopped", async () => (((await statusOf("check")) ?? 1) & 1) === 0, 30_000);
  w("commands", "recheck", await gui(`action=recheck&${hashes(["check"])}`));
  await reach("check checking", async () => (((await statusOf("check")) ?? 0) & 2) === 2, 30_000);
  await snapshot("checking");
  await reach("check checked", async () => (((await statusOf("check")) ?? 2) & 2) === 0, 120_000);
  await gui(`action=start&${hashes(["check"])}`);

  // error: run 43684224740 got "Error: Files missing from job. Please recheck." (status 152) when the torrent started
  // again after its payload became a folder of the same name — the seeding one held the file open, so stopped first
  await gui(`action=stop&${hashes(["gone"])}`);
  await reach("gone stopped", async () => (((await statusOf("gone")) ?? 1) & 1) === 0, 30_000);
  rmSync(join(ctx.work, "downloads", "gone.bin"));
  mkdirSync(join(ctx.work, "downloads", "gone.bin"));
  await gui(`action=start&${hashes(["gone"])}`);
  await reach("gone failing", async () => (((await statusOf("gone")) ?? 0) & 16) === 16, 60_000);
  await snapshot("error");

  // completed: the finished one stopped
  await gui(`action=stop&${hashes(["done"])}`);
  await reach("done stopped", async () => (((await statusOf("done")) ?? 1) & 1) === 0, 30_000);
  await snapshot("completed");
  w("commands", "start", await gui(`action=start&${hashes(["done"])}`));

  // limits in KiB/s (µTorrent's max_dl_rate / max_ul_rate)
  w("commands", "setsetting-limits", await gui("action=setsetting&s=max_dl_rate&v=2000&s=max_ul_rate&v=500"));
  await snapshot("limited");
  w("commands", "setsetting-unlimited", await gui("action=setsetting&s=max_dl_rate&v=0&s=max_ul_rate&v=0"));
  await snapshot("unlimited");

  // seeding: the web-seeded download finishes
  await reach(
    "big seeding",
    async () => {
      const t = await find(hash("big"));
      await statusOf("big");
      return t !== undefined && Number(t[ROW.progress]) === 1000 && (Number(t[ROW.status]) & 1) === 1;
    },
    900_000,
  );
  await snapshot("finished");

  // the emulated pause: stop by a hash list, start exactly those — started, checking and queued ones, as the Web UI's
  // stop takes them (webui.js `getHashes`: stop skips a torrent without bits 1, 2, 16 and 64); run 43684224740 left the
  // queued seed done.bin (200) out
  const ACTIVE = 1 | 2 | 64;
  const running = (await list())
    .filter(t => (Number(t[ROW.status]) & ACTIVE) !== 0 && (Number(t[ROW.status]) & 32) === 0)
    .map(t => String(t[ROW.hash]));
  w("commands", "stop-list", await gui(`action=stop&${running.map(h => `hash=${h}`).join("&")}`));
  await reach("listed stopped", async () => (await list()).every(t => (Number(t[ROW.status]) & ACTIVE) === 0), 30_000);
  await snapshot("all-stopped");
  w("commands", "start-list", await gui(`action=start&${running.map(h => `hash=${h}`).join("&")}`));
  await reach("listed started", async () => (await list()).some(t => (Number(t[ROW.status]) & 1) === 1), 30_000);
  await snapshot("resumed");

  // the same with µTorrent's own pause (the Web UI's "pause all": pause on every torrent that is started or queued and
  // not paused, webui.js `perform`/`getHashes`) — run 43684732968: start after stop made the forced magnet (137) a
  // queued one (200); unpause is to give each one back as it was, the forced one forced
  await gui(`action=forcestart&hash=${DEAD_MAGNET_HASH.toUpperCase()}`);
  await reach("magnet forced", async () => (await find(DEAD_MAGNET_HASH.toUpperCase()))?.[ROW.status] === 137, 15_000);
  // run 43684983680 had no torrent waiting in the queue at this point: two active ones at most, so the others wait (200)
  await gui("action=setsetting&s=max_active_torrent&v=2");
  await reach("some waiting", async () => (await list()).some(t => (Number(t[ROW.status]) & (1 | 64)) === 64), 30_000);
  const before = new Map((await list()).map(t => [String(t[ROW.hash]), Number(t[ROW.status])]));
  console.log("before pause-list:", JSON.stringify(Object.fromEntries(before)));
  const pausable = [...before].filter(([, st]) => (st & 32) === 0 && (st & (1 | 64)) !== 0).map(([h]) => h);
  w("commands", "pause-list", await gui(`action=pause&${pausable.map(h => `hash=${h}`).join("&")}`));
  await reach(
    "listed paused",
    async () =>
      (await list())
        .filter(t => pausable.includes(String(t[ROW.hash])))
        .every(t => (Number(t[ROW.status]) & 32) === 32),
    30_000,
  );
  // whether a paused one that waited starts when its turn comes
  await new Promise(r => setTimeout(r, 5000));
  await snapshot("all-paused");
  w("commands", "unpause-list", await gui(`action=unpause&${pausable.map(h => `hash=${h}`).join("&")}`));
  await reach("listed unpaused", async () => (await list()).every(t => (Number(t[ROW.status]) & 32) === 0), 30_000);
  await snapshot("unpaused");
  console.log(
    "after unpause-list:",
    JSON.stringify(Object.fromEntries((await list()).map(t => [String(t[ROW.hash]), t[ROW.status]]))),
  );
  await gui("action=setsetting&s=max_active_torrent&v=10");

  // remove one without its data, then an unknown hash
  w("commands", "remove", await gui(`action=remove&${hashes(["queued"])}`));
  w("commands", "remove-unknown", await gui(`action=remove&hash=${"F".repeat(40)}`));
  await snapshot("removed");
  console.log("statuses seen:", JSON.stringify(Object.fromEntries(seen)));
  return rec;
}
