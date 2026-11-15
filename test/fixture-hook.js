"use strict";
// Loaded into the ADAPTER process by test/inventory.js (NODE_OPTIONS=--require): replaces fetch so every configured
// program is answered from the recordings in test/fixtures/ — nothing leaves the machine, an address without a
// route is refused. Hadouken, which the adapter reaches through node:http, is answered by a loopback server of this hook
// instead. The adapter knows nothing about it (reference_objekt_inventar_cloud_adapter).
// Switches of the fleet suites (fleet.json `suites`): INVENTORY_RENAME renames a qBittorrent torrent, INVENTORY_REJECT_LOGIN
// lets every program with a login refuse it the way that program does (the local JDownloader API has none),
// INVENTORY_DROP_DEVICE lets aria2 answer nothing while the others go on; the file `reserved` in RESOURCE_PROBE_DIR names a
// torrent `info` (suite "a name that is the adapter's own").
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

const FIXTURES = path.join(__dirname, "fixtures");
const load = (program, version, state, name) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, program, version, state, `${name}.json`), "utf8"));
const body = (program, version, state, name) => load(program, version, state, name).body;

/** Account and device of the My.JDownloader fixture (test/inventory.js configures the same). */
const MYJD = { email: "fixture@example.com", password: "fixture", device: "JD Fixture" };

const RENAMED = process.env.INVENTORY_RENAME === "1";
const REJECTED = process.env.INVENTORY_REJECT_LOGIN === "1";
const DROPPED = process.env.INVENTORY_DROP_DEVICE === "1";
const reserved = () =>
  process.env.RESOURCE_PROBE_DIR !== undefined && fs.existsSync(path.join(process.env.RESOURCE_PROBE_DIR, "reserved"));

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const text = (value, status = 200, headers = {}) => new Response(status === 204 ? null : value, { status, headers });

// ---- JDownloader (local API and, decrypted, the cloud's device calls) ----
const JD_READS = {
  "/jd/version": ["auth", "jd-version"],
  "/toolbar/getStatus": ["running", "toolbar-get-status"],
  "/downloadsV2/queryPackages": ["running", "query-packages"],
  "/downloadsV2/queryLinks": ["running", "query-links"],
};
const jdData = urlPath => {
  const r = JD_READS[urlPath];
  if (r) return body("jdownloader", "48637", r[0], r[1]).data;
  if (urlPath === "/events/subscribe") return { subscriptionid: 1 };
  return true;
};
const waitOrAbort = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });

async function jdLocal(url, init) {
  if (url.pathname === "/events/listen") {
    await waitOrAbort(60000, init.signal);
    return json({ data: [] });
  }
  return json({ data: jdData(url.pathname), rid: 1 });
}

// ---- My.JDownloader: real signatures and AES (api-jdownloader.md § 1.1) ----
const sha256 = buf => crypto.createHash("sha256").update(buf).digest();
const secret = domain => sha256(Buffer.from(`${MYJD.email.toLowerCase()}${MYJD.password}${domain}`));
const encrypt = (token, s) => {
  const c = crypto.createCipheriv("aes-128-cbc", token.subarray(16, 32), token.subarray(0, 16));
  return Buffer.concat([c.update(s, "utf8"), c.final()]).toString("base64");
};
const decrypt = (token, s) => {
  const d = crypto.createDecipheriv("aes-128-cbc", token.subarray(16, 32), token.subarray(0, 16));
  return Buffer.concat([d.update(Buffer.from(s, "base64")), d.final()]).toString("utf8");
};
/** @type {{ login: Buffer, device: Buffer, session: string, server: Buffer | null, deviceToken: Buffer | null, n: number }} */
const cloud = { login: secret("server"), device: secret("device"), session: "", server: null, deviceToken: null, n: 0 };
function newSession(base) {
  cloud.session = crypto.createHash("sha256").update(`fixture-${++cloud.n}`).digest("hex").slice(0, 32);
  cloud.server = sha256(Buffer.concat([base, Buffer.from(cloud.session, "hex")]));
  cloud.deviceToken = sha256(Buffer.concat([cloud.device, Buffer.from(cloud.session, "hex")]));
  return { sessiontoken: cloud.session, regaintoken: `r${cloud.n}` };
}
async function myjd(url, init) {
  if (url.pathname === "/my/connect") {
    if (REJECTED) return json({ src: "MYJD", type: "AUTH_FAILED" }, 403);
    return text(encrypt(cloud.login, JSON.stringify({ ...newSession(cloud.login), rid: 1 })));
  }
  if (url.pathname === "/my/reconnect") {
    const key = cloud.server;
    return text(encrypt(key, JSON.stringify({ ...newSession(key), rid: 1 })));
  }
  if (url.pathname === "/my/listdevices") {
    return text(
      encrypt(cloud.server, JSON.stringify({ list: [{ id: "dev1", name: MYJD.device, type: "jd" }], rid: 1 })),
    );
  }
  const m = /^\/t_[0-9a-f]+_dev1(\/.+)$/.exec(url.pathname);
  if (!m) return json({ src: "MYJD", type: "TOKEN_INVALID" }, 403);
  const req = JSON.parse(decrypt(cloud.deviceToken, String(init.body)));
  return text(encrypt(cloud.deviceToken, JSON.stringify({ data: jdData(req.url), rid: req.rid })));
}

// ---- qBittorrent 5.2.3 ----
function qbittorrent(url) {
  const p = url.pathname;
  if (p === "/api/v2/auth/login") {
    return REJECTED ? text("Fails.") : text("", 204, { "set-cookie": "SID=fixture; HttpOnly" });
  }
  if (p === "/api/v2/app/version") return text(body("qbittorrent", "5.2.3", "auth", "app-version"));
  if (p === "/api/v2/sync/maindata") return json(maindata());
  return text("");
}
// the first torrent named `info` while `reserved` exists, the second renamed under INVENTORY_RENAME
function maindata() {
  const data = body("qbittorrent", "5.2.3", "running", "maindata");
  const [first, second] = Object.keys(data.torrents ?? {});
  if (reserved() && first) data.torrents[first].name = "info";
  if (RENAMED && second) data.torrents[second].name = `${data.torrents[second].name} (renamed)`;
  return data;
}

// ---- Transmission 4.1.3 (JSON-RPC, the 409 session round) ----
const TR_READS = {
  torrent_get: "torrent-get",
  session_get: "session-get",
  session_stats: "session-stats",
  free_space: "free-space",
};
function transmission(url, init, headers) {
  if (REJECTED) return text("<h1>401: Unauthorized</h1>", 401);
  if (headers.get("x-transmission-session-id") !== "fixture") {
    return text("<h1>409: Conflict</h1>", 409, {
      "x-transmission-session-id": "fixture",
      "x-transmission-rpc-version": "6.0.1",
    });
  }
  const { method } = JSON.parse(String(init.body));
  const read = TR_READS[method];
  return json(read ? body("transmission", "4.1.3", "running", read) : { jsonrpc: "2.0", result: {}, id: 1 });
}

// ---- Vuze 5.7.6.0 with its Web Remote plugin 0.6.5 (Transmission's legacy RPC, the 409 session round) ----
const VUZE = "5.7.6.0-xmwebui-0.6.5";
const VZ_READS = new Set(["torrent-get", "session-get", "session-stats", "free-space"]);
function vuze(url, init, headers) {
  if (REJECTED) return text("Access Denied\r\n", 401);
  if (headers.get("x-transmission-session-id") !== "fixture") {
    return text("You_didn_t_set_the_X-Transmission-Session-Id", 409, { "x-transmission-session-id": "fixture" });
  }
  const { method } = JSON.parse(String(init.body));
  return json(VZ_READS.has(method) ? body("vuze", VUZE, "running", method) : { arguments: {}, result: "success" });
}

// ---- µTorrent Server 3.3 build 30470 (Web UI API: token.html with basic auth, then the token and its GUID cookie) ----
const UT = "3.3.0.30470";
function utorrent(url) {
  if (REJECTED) return text("", 401, { "www-authenticate": 'Basic realm="uTorrent"' });
  if (url.pathname === "/gui/token.html") {
    const page = String(body("utorrent", UT, "auth", "token")).replace("<token>", "fixture");
    return text(page, 200, { "content-type": "text/html", "set-cookie": "GUID=fixture" });
  }
  if (url.searchParams.get("list") === "1") return json(body("utorrent", UT, "running", "list"));
  const action = url.searchParams.get("action");
  if (action === "getsettings") return json(body("utorrent", UT, "running", "getsettings"));
  if (action === "getversion") return json(body("utorrent", UT, "probe", "getversion"));
  return json(body("utorrent", UT, "commands", "stop"));
}

// ---- Deluge 2.2.0 ----
const DL_READS = {
  "web.get_hosts": ["auth", "get-hosts"],
  "web.get_host_status": ["auth", "get-host-status"],
  "web.update_ui": ["running", "update-ui"],
  "core.get_config_values": ["running", "config-values"],
  "core.is_session_paused": ["running", "is-session-paused"],
};
function deluge(url, init) {
  const { method } = JSON.parse(String(init.body));
  if (method === "auth.login") {
    return REJECTED
      ? json({ result: false, error: null, id: 1 })
      : json({ result: true, error: null, id: 1 }, 200, { "set-cookie": "_session_id=fixture" });
  }
  if (method === "web.connected") return json({ result: true, error: null, id: 1 });
  const r = DL_READS[method];
  return json(r ? body("deluge", "2.2.0", r[0], r[1]) : { result: null, error: null, id: 1 });
}

// ---- SABnzbd 5.1.3 ----
function sabnzbd(url) {
  if (REJECTED) return text("API Key Incorrect", 403);
  const q = url.searchParams;
  if (q.get("mode") === "queue" && !q.get("name")) return json(body("sabnzbd", "5.1.3", "running", "queue"));
  if (q.get("mode") === "history" && !q.get("name")) return json(body("sabnzbd", "5.1.3", "running", "history"));
  if (q.get("mode") === "version") return json(body("sabnzbd", "5.1.3", "auth", "version"));
  return json({ status: true });
}

// ---- NZBGet 26.3 ----
const NZB_READS = {
  version: ["auth", "version"],
  status: ["running", "status"],
  listgroups: ["running", "listgroups"],
  history: ["running", "history"],
};
function nzbget(url, init) {
  if (REJECTED) return text("", 401);
  const { method } = JSON.parse(String(init.body));
  const r = NZB_READS[method];
  return json(r ? body("nzbget", "26.3", r[0], r[1]) : { version: "1.1", id: 1, result: true });
}

// ---- aria2 1.37.0 (multicall assembled from the single recordings) ----
const ARIA_READS = {
  "aria2.tellActive": "tell-active",
  "aria2.tellWaiting": "tell-waiting",
  "aria2.tellStopped": "tell-stopped",
  "aria2.getGlobalStat": "global-stat",
  "aria2.getGlobalOption": "global-option",
};
function aria2(url, init) {
  // the dropped device of the fleet suite — test/inventory.js waits for every other one (DROPPED_DEVICE)
  if (DROPPED) {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error(`connect EHOSTUNREACH ${url.host}`), { code: "EHOSTUNREACH" }),
    });
  }
  const { method, params, id } = JSON.parse(String(init.body));
  if (REJECTED) return json({ jsonrpc: "2.0", id, error: { code: 1, message: "Unauthorized" } });
  if (method === "system.multicall") {
    const result = params[0].map(s =>
      s.methodName === "aria2.getVersion"
        ? [body("aria2", "1.37.0", "auth", "version").result]
        : [body("aria2", "1.37.0", "running", ARIA_READS[s.methodName]).result],
    );
    return json({ jsonrpc: "2.0", id, result });
  }
  if (method === "aria2.getVersion")
    return json({ jsonrpc: "2.0", id, result: body("aria2", "1.37.0", "auth", "version").result });
  return json({ jsonrpc: "2.0", id, result: "OK" });
}

// ---- pyLoad 0.5.0b3.dev101 ----
function pyload(url) {
  if (REJECTED) return json({ error: "Unauthorized" }, 401);
  const fn = url.pathname.replace(/^\/api\//, "");
  if (fn === "get_server_version") return json(body("pyload", "0.5.0", "auth", "version"));
  if (fn === "get_config_value") return json(url.searchParams.get("option") === "limit_speed" ? false : -1);
  const file = path.join(FIXTURES, "pyload", "0.5.0", "running", `${fn.replace(/_/g, "-")}.json`);
  return json(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).body : null);
}

// ---- rqbit 9.1.0 (basic auth on every request) ----
const RQ_READS = {
  "/": ["auth", "root"],
  "/torrents": ["running", "torrents"],
  "/stats": ["running", "stats"],
  "/torrents/limits": ["running", "limits"],
};
function rqbit(url, init) {
  if (REJECTED) return json(body("rqbit", "9.1.0", "auth", "root-wrong"), 401);
  const r = (init.method ?? "GET") === "GET" ? RQ_READS[url.pathname] : undefined;
  if (r) return json(body("rqbit", "9.1.0", r[0], r[1]));
  if (url.pathname === "/torrents") return json(body("rqbit", "9.1.0", "commands", "torrents-post-file"));
  return json({});
}

// ---- rTorrent 0.16.25 (XML-RPC behind the web server's basic auth, every call by its method name) ----
function rtorrent(url, init) {
  const xml = (state, name, status = 200) =>
    text(body("rtorrent", "0.16.25", state, name), status, {
      "content-type": status === 200 ? "text/xml" : "text/html",
    });
  if (REJECTED) return xml("auth", "wrong", 401);
  const call = String(init.body ?? "");
  const method = /<methodName>([^<]*)<\/methodName>/.exec(call)?.[1];
  if (method === "system.client_version") return xml("auth", "version");
  // the poll; no recorded torrent carries the adapter's mark, so no other multicall is asked
  if (method === "system.multicall") return call.includes("d.multicall2") ? xml("running", "poll") : text("", 404);
  // every single command rTorrent answers with 0 (d.stop, d.start, d.erase, load.*, throttle.*.set — recorded alike)
  return xml("commands", "d-stop");
}

// ---- Tribler 8.4.2 (REST, the API key in X-Api-Key on every request) ----
// `error` is the state with the most statuses at once: downloading, stopped, seeding, metadata, exit nodes, failed
const TBL_READS = {
  "GET /api/versioning/versions/current": ["auth", "version"],
  "GET /api/downloads": ["error", "downloads"],
  "GET /api/settings": ["error", "settings"],
};
function tribler(url, init) {
  if (REJECTED) return json(body("tribler", "8.4.2", "auth", "downloads-wrong-key"), 401);
  const method = init.method ?? "GET";
  const r = TBL_READS[`${method} ${url.pathname}`];
  if (r) return json(body("tribler", "8.4.2", r[0], r[1]));
  if (method === "PUT") return json(body("tribler", "8.4.2", "commands", "put-uri"));
  if (method === "DELETE") return json(body("tribler", "8.4.2", "commands", "delete"));
  if (method === "POST") return json(body("tribler", "8.4.2", "commands", "settings-limits"));
  return json(body("tribler", "8.4.2", "commands", "patch-resume"));
}

// ---- Flood 4.16.4 in front of qBittorrent (REST, the session in the cookie jwt) ----
// `missing` is the state with the most statuses at once: downloading, waiting, seeding, stopped, failed
const FL_READS = {
  "GET /api/openapi.json": ["auth", "openapi"],
  "GET /api/torrents": ["missing", "torrents"],
  "GET /api/client/settings": ["missing", "settings"],
};
function flood(url, init) {
  const method = init.method ?? "GET";
  if (url.pathname === "/api/auth/authenticate") {
    return REJECTED
      ? json(body("flood", "4.16.4-qbittorrent", "auth", "authenticate-wrong"), 401)
      : json(body("flood", "4.16.4-qbittorrent", "auth", "authenticate-ok"), 200, {
          "set-cookie": "jwt=fixture; HttpOnly",
        });
  }
  const r = FL_READS[`${method} ${url.pathname}`];
  if (r) return json(body("flood", "4.16.4-qbittorrent", r[0], r[1]));
  // an add names no hash for a magnet (recorded 202 []); stop, start, delete and the settings write answer nothing
  if (url.pathname === "/api/torrents/add-urls")
    return json(body("flood", "4.16.4-qbittorrent", "commands", "add-urls-magnet"), 202);
  return text("");
}

// ---- Hadouken 5.2.0 (JSON-RPC behind basic auth) ----
// The adapter sends through node:http (Hadouken reads a body only behind the header named exactly "Content-Length"), so
// the answers come from a real server on loopback: the network hook's hang and outage act on the socket, a request
// without a socket would escape both. It listens while this file loads, before the adapter runs — a listener opened
// later would count as the adapter's own. `error` is the state with the most statuses at once: downloading, seeding,
// paused, failed.
const HK = "5.2.0";
const HK_READS = {
  "core.getSystemInfo": ["probe", "get-system-info"],
  "webui.list": ["error", "list"],
  "webui.getSettings": ["error", "get-settings"],
  "webui.getProperties": ["probe", "get-properties-managed"],
};
const hkServer = http.createServer((req, res) => {
  // what Hadouken does with a request it cannot read (connection_handler.cpp; recorder: ECONNRESET, no answer)
  if (!req.rawHeaders.includes("Content-Length")) {
    req.socket.destroy();
    return;
  }
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    if (REJECTED || !req.rawHeaders.includes("Authorization")) {
      res.writeHead(401, { "WWW-Authenticate": `Basic realm="Hadouken v${HK}"` });
      res.end();
      return;
    }
    const { method, id } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // every command answers without a result (recordings commands/*)
    const [state, name] = HK_READS[method] ?? ["commands", "start"];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...body("hadouken", HK, state, name), id }));
  });
});
hkServer.listen(0, "127.0.0.1");
hkServer.unref();
for (const name of ["request", "get"]) {
  const original = http[name];
  http[name] = function hadoukenRoute(...args) {
    const url = typeof args[0] === "string" || args[0] instanceof URL ? new URL(String(args[0])) : null;
    if (url?.hostname !== "hadouken.local") {
      return original.apply(this, args);
    }
    const at = hkServer.address();
    if (!at || typeof at !== "object") {
      throw new Error("fixture hook: the Hadouken fixture does not listen yet");
    }
    // rerouted in the same step: the network hook counted the call and decided a hang for hadouken.local already
    const opts = args[1] !== null && typeof args[1] === "object" ? args[1] : {};
    const rest = args.slice(opts === args[1] ? 2 : 1);
    return original.call(
      this,
      { ...opts, protocol: "http:", hostname: "127.0.0.1", port: at.port, path: `${url.pathname}${url.search}` },
      ...rest,
    );
  };
}

const ROUTES = {
  "jdownloader.local": jdLocal,
  "api.jdownloader.org": myjd,
  "qbittorrent.local": qbittorrent,
  "transmission.local": transmission,
  "deluge.local": deluge,
  "sabnzbd.local": sabnzbd,
  "nzbget.local": nzbget,
  "aria2.local": aria2,
  "pyload.local": pyload,
  "rqbit.local": rqbit,
  "rtorrent.local": rtorrent,
  "tribler.local": tribler,
  "flood.local": flood,
  "vuze.local": vuze,
  "utorrent.local": utorrent,
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const route = ROUTES[url.hostname];
  if (!route) {
    throw new TypeError(`fixture hook: no route for ${url.origin}`);
  }
  return route(url, init, new Headers(init.headers));
};

// aria2's push channel: no socket in the fixture run, polling carries everything — assigned through a cast, so the type
// check of the test files keeps node's WebSocket (a plain assignment in a JS file declares the global anew)
/** @type {any} */ (globalThis).WebSocket = class {
  addEventListener() {}
  close() {}
};
