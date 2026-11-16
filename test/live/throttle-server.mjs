// A throttled static file server for the container recorder: web seed for the torrent programs, HTTP source for
// JDownloader, pyLoad and aria2. Serves the directory given as argv[2] on port 8080 at RATE bytes per second,
// honours Range requests (web seeds ask for pieces) and answers 404 for anything else. `/announce` is a tracker (BEP 3,
// compact peers BEP 23) for the torrents that name it: the recording's peer finds the program there and leeches from it.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, normalize } from "node:path";
import { Transform } from "node:stream";

const root = process.argv[2] ?? "/seed";
const RATE = Number(process.env.RATE ?? 1024 * 1024);

/**
 * @returns {Transform} a stream that lets RATE bytes per second through
 */
function throttle() {
  let sent = 0;
  const start = Date.now();
  return new Transform({
    transform(chunk, _enc, done) {
      sent += chunk.length;
      const due = start + (sent / RATE) * 1000;
      setTimeout(() => done(null, chunk), Math.max(0, due - Date.now()));
    },
  });
}

/** @type {Map<string, Map<string, { ip: string, port: number }>>} the peers of every swarm: info hash → peer id → address */
const swarms = new Map();

/**
 * Percent-decoding to bytes: an info hash is binary and never valid UTF-8.
 *
 * @param {string} s query value as sent
 * @returns {Buffer} its bytes
 */
function bytesOf(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%") {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i));
    }
  }
  return Buffer.from(out);
}

/**
 * One announce: remember the caller (its address as seen on the network, the port it names) and answer every other
 * peer of the swarm, every 5 s.
 *
 * @param {import("node:http").IncomingMessage} req request
 * @param {import("node:http").ServerResponse} res response
 */
function announce(req, res) {
  const q = new Map(
    ((req.url ?? "").split("?")[1] ?? "")
      .split("&")
      .map(kv => /** @type {[string, string]} */ ([...kv.split("="), ""].slice(0, 2))),
  );
  const hash = bytesOf(q.get("info_hash") ?? "").toString("hex");
  const id = bytesOf(q.get("peer_id") ?? "").toString("hex");
  const port = Number(q.get("port"));
  const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const swarm = swarms.get(hash) ?? new Map();
  swarms.set(hash, swarm);
  if (q.get("event") === "stopped") {
    swarm.delete(id);
  } else if (port > 0 && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    swarm.set(id, { ip, port });
  }
  const others = [...swarm].filter(([peer]) => peer !== id).map(([, p]) => p);
  console.log(`tracker: ${ip}:${port} ${q.get("event") ?? "-"} ${hash.slice(0, 8)} → ${others.length} peer(s)`);
  const compact = Buffer.concat(
    others.map(p => {
      const b = Buffer.alloc(6);
      p.ip.split(".").forEach((n, i) => b.writeUInt8(Number(n), i));
      b.writeUInt16BE(p.port, 4);
      return b;
    }),
  );
  const peers =
    q.get("compact") === "0"
      ? Buffer.from(`l${others.map(p => `d2:ip${p.ip.length}:${p.ip}4:porti${p.port}ee`).join("")}e`)
      : Buffer.concat([Buffer.from(`${compact.length}:`), compact]);
  res.setHeader("content-type", "text/plain");
  res.end(Buffer.concat([Buffer.from("d8:intervali5e12:min intervali5e5:peers"), peers, Buffer.from("e")]));
}

createServer((req, res) => {
  if ((req.url ?? "").startsWith("/announce?")) {
    announce(req, res);
    return;
  }
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, path);
  let size;
  try {
    const st = statSync(file);
    if (!st.isFile()) {
      throw new Error("not a file");
    }
    size = st.size;
  } catch {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    start = range[1] ? Number(range[1]) : size - Number(range[2]);
    end = range[1] && range[2] ? Number(range[2]) : size - 1;
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
  }
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-length", String(end - start + 1));
  res.setHeader("content-type", "application/octet-stream");
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file, { start, end }).pipe(throttle()).pipe(res);
}).listen(8080, () => console.log(`seed: serving ${root} on 8080 at ${RATE} B/s`));
