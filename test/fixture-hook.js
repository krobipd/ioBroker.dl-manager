"use strict";
// Loaded into the ADAPTER process by test/inventory.js (NODE_OPTIONS=--require): replaces fetch so every configured
// program is answered from the recordings in test/fixtures/ — nothing leaves the machine, an address without a
// route is refused. The adapter knows nothing about it (reference_objekt_inventar_cloud_adapter).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FIXTURES = path.join(__dirname, "fixtures");
const load = (program, version, state, name) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, program, version, state, `${name}.json`), "utf8"));
const body = (program, version, state, name) => load(program, version, state, name).body;

/** Account and device of the My.JDownloader fixture (test/inventory.js configures the same). */
const MYJD = { email: "fixture@example.com", password: "fixture", device: "JD Fixture" };

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const text = (value, status = 200, headers = {}) =>
  new Response(status === 204 ? null : value, { status, headers });

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
const cloud = { login: secret("server"), device: secret("device"), session: "", server: null, deviceToken: null, n: 0 };
function newSession(base) {
  cloud.session = crypto.createHash("sha256").update(`fixture-${++cloud.n}`).digest("hex").slice(0, 32);
  cloud.server = sha256(Buffer.concat([base, Buffer.from(cloud.session, "hex")]));
  cloud.deviceToken = sha256(Buffer.concat([cloud.device, Buffer.from(cloud.session, "hex")]));
  return { sessiontoken: cloud.session, regaintoken: `r${cloud.n}` };
}
async function myjd(url, init) {
  if (url.pathname === "/my/connect") {
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
  if (p === "/api/v2/auth/login") return text("", 204, { "set-cookie": "SID=fixture; HttpOnly" });
  if (p === "/api/v2/app/version") return text(body("qbittorrent", "5.2.3", "auth", "app-version"));
  if (p === "/api/v2/sync/maindata") return json(body("qbittorrent", "5.2.3", "running", "maindata"));
  return text("");
}

// ---- Transmission 4.1.3 (JSON-RPC, the 409 session round) ----
const TR_READS = {
  torrent_get: "torrent-get",
  session_get: "session-get",
  session_stats: "session-stats",
  free_space: "free-space",
};
function transmission(url, init, headers) {
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
  if (method === "auth.login")
    return json({ result: true, error: null, id: 1 }, 200, { "set-cookie": "_session_id=fixture" });
  if (method === "web.connected") return json({ result: true, error: null, id: 1 });
  const r = DL_READS[method];
  return json(r ? body("deluge", "2.2.0", r[0], r[1]) : { result: null, error: null, id: 1 });
}

// ---- SABnzbd 5.1.3 ----
function sabnzbd(url) {
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
  const { method, params, id } = JSON.parse(String(init.body));
  if (method === "system.multicall") {
    const result = params[0].map(s => [body("aria2", "1.37.0", "running", ARIA_READS[s.methodName]).result]);
    return json({ jsonrpc: "2.0", id, result });
  }
  if (method === "aria2.getVersion")
    return json({ jsonrpc: "2.0", id, result: body("aria2", "1.37.0", "auth", "version").result });
  return json({ jsonrpc: "2.0", id, result: "OK" });
}

// ---- pyLoad 0.5.0b3.dev101 ----
function pyload(url) {
  const fn = url.pathname.replace(/^\/api\//, "");
  if (fn === "get_server_version") return json(body("pyload", "0.5.0", "auth", "version"));
  if (fn === "get_config_value") return json(url.searchParams.get("option") === "limit_speed" ? false : -1);
  const file = path.join(FIXTURES, "pyload", "0.5.0", "running", `${fn.replace(/_/g, "-")}.json`);
  return json(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).body : null);
}

const ROUTES = {
  "jdownloader.fixture": jdLocal,
  "api.jdownloader.org": myjd,
  "qbittorrent.fixture": qbittorrent,
  "transmission.fixture": transmission,
  "deluge.fixture": deluge,
  "sabnzbd.fixture": sabnzbd,
  "nzbget.fixture": nzbget,
  "aria2.fixture": aria2,
  "pyload.fixture": pyload,
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const route = ROUTES[url.hostname];
  if (!route) {
    throw new TypeError(`fixture hook: no route for ${url.origin}`);
  }
  return route(url, init, new Headers(init.headers));
};

// aria2's push channel: no socket in the fixture run, polling carries everything
globalThis.WebSocket = class {
  addEventListener() {}
  close() {}
};
