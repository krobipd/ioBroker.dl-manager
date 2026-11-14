"use strict";
// Loaded into the adapter process by test/inventory.js (`adapterEnv()`, first `--require`). It observes (and keeps one
// thing out: a datagram from the network around the test, round 173 — see `fromThisMachine` below): when the
// process exits, it records every timer, server and socket the adapter or one of its own dependencies left open after
// onUnload. js-controller (with everything it loads) and a test hook are not the adapter's and are left out.
// A start marker is written at load: a process that never reaches its exit (killed, crashed) has no report.
// Round 125 (fleet suites D10, D4 — every start loads this file, an adapter without a counterpart too): it notes every state
// id a write handed to the adapter's stateChange (<pid>.delivered, once per id) and every write of the adapter after it
// called its unload callback (<pid>.unload) — js-controller closes the databases after the callback, such a write is
// lost; js-controller's own last writes go through its internal client and are not counted.
// Round 174 (the standard for secrets): it notes every log line of the adapter that carries the clear text of a secret
// (<pid>.secrets) — see `watchLog` below.
// Fleet master (.consistency-master/test/resource-probe.js) — never edit the copy in an adapter.
const fs = require("node:fs");
const net = require("node:net");
const dgram = require("node:dgram");
const path = require("node:path");
const asyncHooks = require("node:async_hooks");
const { EventEmitter } = require("node:events");

const dir = process.env.RESOURCE_PROBE_DIR;
if (dir) {
  fs.writeFileSync(path.join(dir, `${process.pid}.start`), "");
  const delivered = path.join(dir, `${process.pid}.delivered`);
  const deliveredIds = new Set();
  const unloadLog = path.join(dir, `${process.pid}.unload`);
  const ADAPTER_WRITES = [
    "setState",
    "setStateAsync",
    "setForeignState",
    "setForeignStateAsync",
    "setStateChanged",
    "setStateChangedAsync",
    "setForeignStateChanged",
    "setForeignStateChangedAsync",
    "setObject",
    "setObjectAsync",
    "setObjectNotExists",
    "setObjectNotExistsAsync",
    "setForeignObject",
    "setForeignObjectAsync",
    "extendObject",
    "extendObjectAsync",
    "extendForeignObject",
    "extendForeignObjectAsync",
    "delObject",
    "delObjectAsync",
    "delForeignObject",
    "delForeignObjectAsync",
    "delState",
    "delStateAsync",
  ];
  const watchUnload = (adapter, callback) => {
    let done = 0;
    for (const name of ADAPTER_WRITES) {
      const original = adapter[name];
      if (typeof original !== "function") {
        continue;
      }
      adapter[name] = function afterUnload(...args) {
        if (done) {
          fs.appendFileSync(
            unloadLog,
            `${JSON.stringify({ t: Date.now(), kind: "write", via: name, id: typeof args[0] === "string" ? args[0] : "" })}\n`,
          );
        }
        return original.apply(this, args);
      };
    }
    return /** @this {unknown} */ function unloadCallback(...rest) {
      if (!done) {
        done = Date.now();
        fs.appendFileSync(unloadLog, `${JSON.stringify({ t: done, kind: "callback" })}\n`);
      }
      return callback.apply(this, rest);
    };
  };
  // Round 174 (the standard for secrets, rule sentence S8; ioBroker.docs bestpractices.md: no credentials in the log, at
  // no level): the clear texts this process knows as secrets — the settings the manifest names in `encryptedNative`
  // (decrypted in `config` when the adapter emits `ready`) and every text that goes into `encrypt` or comes out of
  // `decrypt` (the secret fields of the data file, master src/lib/data-file.ts, which encrypts a text as JSON) — and
  // every log call of the adapter, whatever the instance's log level lets through. A line that carries one is noted
  // with its level and where the secret is from, never with the text (<pid>.secrets, once per level and source); the
  // suite "the whole run" of test/fleet-suites.js judges the notes. A text shorter than SECRET_MIN is no evidence: it is
  // part of too many words. What the watch could follow is noted once per source — that it learned a text from it
  // ("learn") or that the source carried one too short to follow ("short"), never the text or its length — so a run in
  // which no log line was held to anything does not read like one in which every line was.
  const SECRET_MIN = 8;
  const LOG_LEVELS = ["silly", "debug", "info", "warn", "error"];
  const LOG_WATCHED = Symbol("resourceProbeLogWatched");
  const secretLog = path.join(dir, `${process.pid}.secrets`);
  const secrets = new Map();
  const noted = new Set();
  const noteSource = (kind, what) => {
    if (!noted.has(`${kind} ${what}`)) {
      noted.add(`${kind} ${what}`);
      fs.appendFileSync(secretLog, `${JSON.stringify({ t: Date.now(), kind, what })}\n`);
    }
  };
  const knowSecret = (text, from) => {
    let inner;
    try {
      inner = JSON.parse(text);
    } catch {
      inner = undefined;
    }
    // the secret itself is the text inside the JSON the data file master encrypts, else the text as it stands
    const core = typeof inner === "string" ? inner : text;
    if (typeof core === "string" && core !== "") {
      noteSource(core.length < SECRET_MIN ? "short" : "learn", from);
    }
    for (const clear of [text, inner]) {
      if (typeof clear === "string" && clear.length >= SECRET_MIN && !secrets.has(clear)) {
        secrets.set(clear, from);
      }
    }
  };
  const watchLog = adapter => {
    const log = adapter.log;
    if (!log || typeof log !== "object" || log[LOG_WATCHED] || typeof adapter.encrypt !== "function") {
      return;
    }
    log[LOG_WATCHED] = true;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "io-package.json"), "utf8"));
      for (const field of manifest.encryptedNative) {
        knowSecret(adapter.config?.[field], `the setting ${field}`);
      }
    } catch {
      // no manifest, or one that names no encrypted setting: no setting is a secret
    }
    fs.appendFileSync(secretLog, `${JSON.stringify({ t: Date.now(), kind: "watch" })}\n`);
    for (const level of LOG_LEVELS) {
      const original = log[level];
      if (typeof original !== "function") {
        continue;
      }
      log[level] = function watchedLog(...args) {
        const line = String(args[0]);
        for (const [clear, what] of secrets) {
          if (line.includes(clear) && !noted.has(`${level} ${what}`)) {
            noted.add(`${level} ${what}`);
            fs.appendFileSync(secretLog, `${JSON.stringify({ t: Date.now(), kind: "log", level, what })}\n`);
          }
        }
        return original.apply(this, args);
      };
    }
  };
  const probeEmit = EventEmitter.prototype.emit;
  EventEmitter.prototype.emit = function handOverEmit(event, ...args) {
    if (event === "stateChange" && typeof args[0] === "string" && args[1] && args[1].ack === false) {
      if (!deliveredIds.has(args[0])) {
        deliveredIds.add(args[0]);
        fs.appendFileSync(delivered, `${JSON.stringify({ t: Date.now(), id: args[0] })}\n`);
      }
    } else if (event === "unload" && typeof args[0] === "function") {
      args[0] = watchUnload(this, args[0]);
    } else if (event === "ready") {
      watchLog(this);
    }
    return probeEmit.call(this, event, ...args);
  };
  const root = process.cwd();
  let own = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    own = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
  } catch {
    // no package.json: no dependency is the adapter's
  }
  const packageOf = file => {
    const m = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g);
    return m ? m[m.length - 1].slice("node_modules/".length, -1) : undefined;
  };
  const owner = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    const stack = new Error().stack || "";
    Error.stackTraceLimit = limit;
    const files = [];
    for (const line of stack.split("\n").slice(2)) {
      const m = line.match(/\(?((?:file:\/\/)?\/[^():]+):\d+/);
      if (m && !line.includes("node:") && !line.includes(__filename)) {
        files.push(m[1].replace("file://", ""));
      }
    }
    // the first frame outside any node_modules is the code that asked for the resource — the managed timers
    // (this.setTimeout) are created inside js-controller, their owner is the adapter line that called them. The
    // adapter itself runs from a node_modules folder of the test installation: its own files are those below `root`.
    const where = f => {
      const rel = path.relative(root, f);
      if (!rel.startsWith("..") && !rel.startsWith("node_modules")) {
        return /(^|\/)test\//.test(rel) ? "test" : `adapter ${rel}`;
      }
      if (!f.includes("/node_modules/")) {
        return /\/test\//.test(f) ? "test" : "foreign";
      }
      return undefined;
    };
    const first = files.map(where).find(Boolean);
    if (first) {
      return first;
    }
    // only library frames: the adapter's when one of them is a package the adapter depends on itself
    const pkg = files.map(packageOf).find(p => p && own.includes(p));
    return pkg ? `library ${pkg}` : "foreign";
  };
  const timers = new Map();
  asyncHooks
    .createHook({
      init(id, type, _trigger, resource) {
        if (type === "Timeout" || type === "Immediate") {
          timers.set(id, { type, owner: owner(), ref: new WeakRef(resource) });
        }
      },
      destroy(id) {
        timers.delete(id);
      },
    })
    .enable();
  // Round 113: where every outgoing TCP connection really goes. The probe loads first, so its connect is the innermost
  // one — it sees the address a fixture hook rerouted to, not the one the adapter asked for. A connection that leaves
  // this machine reached the real world: a forgotten route to a cloud, a device on the LAN (yamaha lab run 2026-10-14:
  // the router at 10.47.4.1 answered a discovery while the fixtures were missing).
  const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.|localhost$)/;
  const leftMachine = args => {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const o =
      first && typeof first === "object"
        ? first
        : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
    if (typeof o.path === "string" || o.port === undefined || o.port === null) {
      return;
    }
    const host = String(o.host ?? "localhost");
    if (!LOOPBACK.test(host)) {
      land("tcp", host, Number(o.port));
    }
  };
  const land = (kind, host, port) =>
    fs.appendFileSync(
      path.join(dir, `${process.pid}.lands`),
      `${JSON.stringify({ t: Date.now(), kind, host, port })}\n`,
    );
  // a unicast datagram leaves this machine as well (a LAN protocol on UDP alone, govee's); a multicast or broadcast
  // search does on purpose and is not judged
  const broadcasts = new Set(["255.255.255.255"]);
  for (const list of Object.values(require("node:os").networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && a.netmask) {
        const n = s => s.split(".").reduce((v, b) => v * 256 + Number(b), 0);
        const b = (n(a.address) | (~n(a.netmask) >>> 0)) >>> 0;
        broadcasts.add([24, 16, 8, 0].map(s => (b >>> s) & 255).join("."));
      }
    }
  }
  const sendDatagram = /** @type {(this: unknown, ...args: any[]) => any} */ (dgram.Socket.prototype.send);
  dgram.Socket.prototype.send = function (...args) {
    // send(msg, port, address) or send(msg, offset, length, port, address); an unbound socket binds and sends again
    const portAt = typeof args[1] === "number" && typeof args[2] === "number" ? 3 : 1;
    const host =
      typeof args[portAt] === "number" && typeof args[portAt + 1] === "string" ? args[portAt + 1] : undefined;
    let bound = true;
    try {
      this.address();
    } catch {
      bound = false;
    }
    if (
      bound &&
      host !== undefined &&
      !LOOPBACK.test(host) &&
      !/^(?:22[4-9]|23\d)\.|^ff/i.test(host) &&
      !broadcasts.has(host)
    ) {
      land("udp", host, args[portAt]);
    }
    return sendDatagram.apply(this, args);
  };
  // Round 173 (a responder measured on a Mac in a LAN with searching devices: 47 datagrams of real devices on its port,
  // two of them answered — connections that left the machine, .lands): a datagram whose source is no address of this
  // machine comes from the real network around the test and never arrives — the run answers no real device and reads the
  // same on every machine. The rule stands here because every start loads this file (R173-44: in the network hook alone it
  // missed every start without that hook). A link-local IPv6 address is this machine's only with its zone, as node names
  // it by interface name or number (R173-45: `fe80::1%en0` is the router, `fe80::1%lo0` the loopback of a Mac); the
  // addresses are read when a source is unknown — one that came up after the load —, at most once a second (R173-47).
  const MACHINE_READ_MS = 1000;
  let machine = new Set();
  let machineRead = 0;
  const fromThisMachine = address => {
    const plain = address.replace(/^::ffff:/i, "");
    if (plain.startsWith("127.") || machine.has(plain)) {
      return true;
    }
    if (Date.now() - machineRead < MACHINE_READ_MS) {
      return false;
    }
    machineRead = Date.now();
    machine = new Set(
      Object.entries(require("node:os").networkInterfaces()).flatMap(([name, list]) =>
        (list ?? []).flatMap(i =>
          i.family === "IPv6" && i.scopeid ? [`${i.address}%${name}`, `${i.address}%${i.scopeid}`] : [i.address],
        ),
      ),
    );
    return machine.has(plain);
  };
  module.exports.fromThisMachine = fromThisMachine;
  const emitDatagram = /** @type {(this: unknown, ...args: any[]) => any} */ (dgram.Socket.prototype.emit);
  dgram.Socket.prototype.emit = function (event, ...args) {
    if (event === "message" && args[1] && typeof args[1].address === "string" && !fromThisMachine(args[1].address)) {
      return false;
    }
    return emitDatagram.call(this, event, ...args);
  };
  // a server or socket gets its handle in an internal nextTick — its owner is whoever calls listen/connect/bind
  const OWNER = Symbol("resourceProbeOwner");
  for (const [proto, method] of /** @type {Array<[any, string]>} */ ([
    [net.Server.prototype, "listen"],
    [net.Socket.prototype, "connect"],
    [dgram.Socket.prototype, "bind"],
  ])) {
    const original = proto[method];
    proto[method] = function (...args) {
      if (!this[OWNER]) {
        this[OWNER] = owner();
      }
      if (method === "connect") {
        leftMachine(args);
      }
      return original.apply(this, args);
    };
  }
  // every state the adapter reads back from its own namespace, with the time: the test then asks which reads fell into
  // its quiet window (window.json) — one pipelined chunk carries many RESP commands, each one is counted
  const stateKey = `io.${String(process.env.RESOURCE_PROBE_NS || "")}`;
  const reads = new Map();
  const write = net.Socket.prototype.write;
  net.Socket.prototype.write = function (chunk, ...args) {
    if (this.remotePort && stateKey.length > 3) {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("latin1") : "";
      const command = /\*(\d+)\r\n\$\d+\r\n(GET|MGET|get|mget)\r\n/g;
      let m;
      while ((m = command.exec(text))) {
        const keys = /\$\d+\r\n([^\r]*)\r\n/y;
        keys.lastIndex = command.lastIndex;
        for (let i = 1; i < Number(m[1]); i++) {
          const k = keys.exec(text);
          if (!k) {
            break;
          }
          if (k[1].startsWith(stateKey)) {
            const id = k[1].slice(3);
            let times = reads.get(id);
            if (!times) {
              reads.set(id, (times = []));
            }
            times.push(Date.now());
          }
        }
      }
    }
    return write.call(this, chunk, ...args);
  };
  // Round 77: the single reads the ADAPTER asks for — getState/getForeignState, and setStateChanged/
  // setForeignStateChanged, which read the state before they write (js-controller 7.2.2 _setStateChangedHelper), also
  // through their …Async forms (promisify in js-controller-common-db, 7.2.2). A read js-controller makes for itself —
  // extendObject or setObjectNotExists read a state to set its `def` — runs through js-controller-adapter frames and does
  // not count. A bulk read
  // (getStatesAsync) is no single read.
  const singleReads = new Map();
  // `_load` is node's internal loader, not in its types
  const Module = /** @type {any} */ (require("node:module"));
  const load = Module._load;
  const WRAPPED = Symbol("resourceProbeWrapped");
  const askedByAdapter = () => {
    const stack = new Error().stack || "";
    for (const line of stack.split("\n").slice(3)) {
      const m = line.match(/\(?((?:file:\/\/)?\/[^():]+):\d+/);
      if (!m || line.includes("node:") || /\/@iobroker\/js-controller-common(-db)?\//.test(m[1])) {
        continue;
      }
      return !m[1].includes("/@iobroker/js-controller-adapter/");
    }
    return false;
  };
  Module._load = function (...args) {
    const exported = load.apply(this, args);
    const cls = exported && typeof exported === "object" ? exported.AdapterClass : undefined;
    if (typeof cls === "function" && !cls.prototype[WRAPPED]) {
      cls.prototype[WRAPPED] = true;
      for (const [method, foreign] of /** @type {Array<[string, boolean]>} */ ([
        ["getState", false],
        ["getForeignState", true],
        ["setStateChanged", false],
        ["setForeignStateChanged", true],
      ])) {
        const original = cls.prototype[method];
        if (typeof original !== "function") {
          continue;
        }
        cls.prototype[method] = function (id, ...rest) {
          if (typeof id === "string" && askedByAdapter()) {
            const full = foreign || id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
            singleReads.set(full, (singleReads.get(full) || 0) + 1);
          }
          return original.call(this, id, ...rest);
        };
      }
      // round 174: encrypt(value) or encrypt(secret, value), decrypt alike — the clear text goes in or comes out
      for (const method of ["encrypt", "decrypt"]) {
        const original = cls.prototype[method];
        if (typeof original !== "function") {
          continue;
        }
        cls.prototype[method] = function (...args) {
          const out = original.apply(this, args);
          if (method === "encrypt") {
            knowSecret(args[1] === undefined ? args[0] : args[1], "a text the adapter encrypted");
          } else {
            knowSecret(out, "a text the adapter decrypted");
          }
          return out;
        };
      }
    }
    return exported;
  };
  const mine = o => o.startsWith("adapter ") || o.startsWith("library ");
  process.on("exit", () => {
    let quiet = {};
    try {
      const w = JSON.parse(fs.readFileSync(path.join(dir, "window.json"), "utf8"));
      for (const [id, times] of reads) {
        const n = times.filter(t => t >= w.start && t <= w.end).length;
        if (n) {
          quiet[id] = n;
        }
      }
    } catch {
      quiet = {};
    }
    const left = [];
    for (const t of timers.values()) {
      const r = t.ref.deref();
      if (r && !r._destroyed && typeof r.hasRef === "function" && r.hasRef() && mine(t.owner)) {
        left.push(`${t.type} from ${t.owner}`);
      }
    }
    for (const h of /** @type {any} */ (process)._getActiveHandles()) {
      if (h && h[OWNER] && !h.destroyed && mine(h[OWNER])) {
        left.push(`${h.constructor.name} from ${h[OWNER]}`);
      }
    }
    fs.writeFileSync(
      path.join(dir, `${process.pid}.json`),
      JSON.stringify({ left, quiet, single: Object.fromEntries(singleReads) }),
    );
  });
}
