// Shared helpers of the container recorder (live-programs.yml). Runs with plain Node 22, no dependencies.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Root of the recordings inside the workspace; the workflow uploads it as an artifact. */
export const OUT = process.env.FIXTURE_OUT ?? "fixtures-out";

/**
 * Runs a command on the runner and returns its stdout.
 *
 * @param {string} cmd program
 * @param {string[]} args arguments
 * @param {{ quiet?: boolean, inherit?: boolean }} [opts] options; `inherit` streams the output instead of returning it
 * @returns {string} stdout
 */
export function sh(cmd, args, opts = {}) {
  if (!opts.quiet) {
    console.log(`$ ${cmd} ${args.join(" ")}`);
  }
  if (opts.inherit) {
    execFileSync(cmd, args, { stdio: "inherit" });
    return "";
  }
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/**
 * Waits until `probe` returns a truthy value — a loop with a deadline, never a fixed sleep.
 *
 * @template T
 * @param {string} label what is awaited (for the error)
 * @param {() => Promise<T>} probe returns a truthy value when ready
 * @param {number} [timeoutMs] deadline
 * @param {number} [everyMs] pause between probes
 * @returns {Promise<T>} the probe's value
 */
export async function waitFor(label, probe, timeoutMs = 120_000, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      const v = await probe();
      if (v) {
        return v;
      }
    } catch (err) {
      last = String(err?.message ?? err);
    }
    if (Date.now() > end) {
      throw new Error(`timeout waiting for ${label}${last ? ` (last error: ${last})` : ""}`);
    }
    await new Promise(resolve => setTimeout(resolve, everyMs));
  }
}

/**
 * A small fetch wrapper with a cookie jar.
 */
export class Http {
  /** @param {string} base e.g. http://qbt:8080 */
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  /**
   * @param {string} method HTTP method
   * @param {string} path path with query
   * @param {{ form?: Record<string,string>, json?: unknown, body?: BodyInit, headers?: Record<string,string> }} [o] body
   * @returns {Promise<{ status: number, headers: Record<string,string>, text: string, json: () => unknown }>} answer
   */
  async req(method, path, o = {}) {
    const headers = { ...o.headers };
    let body = o.body;
    if (o.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(o.form).toString();
    } else if (o.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(o.json);
    }
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const res = await fetch(this.base + path, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      text,
      json: () => JSON.parse(text),
    };
  }
}

/** Response headers a driver reads; secrets in them are replaced. */
const KEEP_HEADERS = ["content-type", "www-authenticate", "x-transmission-rpc-version", "x-transmission-session-id"];

/**
 * @param {Record<string, string>} headers response headers
 * @returns {Record<string, string>} the headers a driver reads, session ids and cookies masked
 */
function keptHeaders(headers) {
  const out = {};
  for (const k of KEEP_HEADERS) {
    if (headers[k] !== undefined) {
      out[k] = k === "x-transmission-session-id" ? "<session-id>" : headers[k];
    }
  }
  if (headers["set-cookie"] !== undefined) {
    out["set-cookie"] = "<omitted>";
  }
  return out;
}

/**
 * Writes one recorded answer: `<OUT>/<program>/<version>/<state>/<name>.json`.
 */
export class Recorder {
  /**
   * @param {string} program program type
   * @param {string} version version the program reports
   */
  constructor(program, version) {
    this.program = program;
    this.version = version;
    this.written = [];
  }

  /**
   * @param {string} state the state the program was put in
   * @param {string} name file name (the request)
   * @param {string} request method + path as sent
   * @param {{ status: number, text: string, headers?: Record<string,string> }} res the answer
   */
  write(state, name, request, res) {
    let body;
    try {
      body = JSON.parse(res.text);
    } catch {
      body = res.text;
    }
    const file = join(OUT, this.program, this.version, state, `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    const doc = {
      _source: { program: this.program, version: this.version, request, recordedAt: new Date().toISOString() },
      status: res.status,
      ...(res.headers ? { headers: keptHeaders(res.headers) } : {}),
      body,
    };
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    this.written.push(file);
  }
}

// ---- deterministic payload and a v1 .torrent without dependencies ----

/**
 * Deterministic bytes (xorshift), so the same payload and info hash come out on every run.
 *
 * @param {number} size bytes
 * @param {number} seed seed
 * @returns {Buffer} payload
 */
export function payload(size, seed = 1) {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf.writeUInt32LE(x, i);
  }
  return buf;
}

/**
 * @param {unknown} v value
 * @returns {Buffer} bencoded
 */
function bencode(v) {
  if (Buffer.isBuffer(v)) {
    return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  }
  if (typeof v === "string") {
    return bencode(Buffer.from(v));
  }
  if (typeof v === "number") {
    return Buffer.from(`i${Math.trunc(v)}e`);
  }
  if (Array.isArray(v)) {
    return Buffer.concat([Buffer.from("l"), ...v.map(bencode), Buffer.from("e")]);
  }
  const keys = Object.keys(v).sort();
  return Buffer.concat([Buffer.from("d"), ...keys.flatMap(k => [bencode(k), bencode(v[k])]), Buffer.from("e")]);
}

/**
 * A single-file v1 torrent without tracker; optional web seed (BEP 19).
 *
 * @param {{ name: string, data: Buffer, webseed?: string, pieceLength?: number }} o torrent content
 * @returns {{ torrent: Buffer, infoHash: string }} the .torrent file and its v1 info hash
 */
export function makeTorrent({ name, data, webseed, pieceLength = 256 * 1024 }) {
  const pieces = [];
  for (let i = 0; i < data.length; i += pieceLength) {
    pieces.push(
      createHash("sha1")
        .update(data.subarray(i, i + pieceLength))
        .digest(),
    );
  }
  const info = { length: data.length, name, "piece length": pieceLength, pieces: Buffer.concat(pieces) };
  const meta = { info, ...(webseed ? { "url-list": webseed } : {}) };
  return { torrent: bencode(meta), infoHash: createHash("sha1").update(bencode(info)).digest("hex") };
}

const MiB = 1024 * 1024;

/** The torrents every torrent program gets: size, payload already in the download folder, web seed. */
export const TORRENT_FILES = {
  big: { size: 32 * MiB, present: false, webseed: true },
  queued: { size: 4 * MiB, present: false, webseed: true },
  stopped: { size: 4 * MiB, present: false, webseed: true },
  done: { size: 2 * MiB, present: true, webseed: false },
  gone: { size: 2 * MiB, present: true, webseed: false },
  // 1 GiB of zeros: big enough that a recheck is still running when the next poll asks (256 MiB was too fast)
  check: { size: 1024 * MiB, present: true, webseed: false, zeros: true },
};

/** Info hash of DEAD_MAGNET. */
export const DEAD_MAGNET_HASH = "0123456789abcdef0123456789abcdef01234567";

/** A magnet nobody seeds — stays in "loading metadata". */
export const DEAD_MAGNET = `magnet:?xt=urn:btih:${DEAD_MAGNET_HASH}&dn=nobody-seeds-this`;

/**
 * Runner side: payloads (web seed folder, download folder) and a .torrent + info hash per file.
 *
 * @param {string} work work directory
 */
export function prepareTorrents(work) {
  mkdirSync(join(work, "downloads"), { recursive: true, mode: 0o777 });
  mkdirSync(join(work, "seed"), { recursive: true });
  mkdirSync(join(work, "torrents"), { recursive: true });
  let seed = 10;
  for (const [name, f] of Object.entries(TORRENT_FILES)) {
    const data = f.zeros ? Buffer.alloc(f.size) : payload(f.size, seed);
    seed++;
    const file = `${name}.bin`;
    if (f.webseed) {
      writeFileSync(join(work, "seed", file), data);
    }
    if (f.present) {
      writeFileSync(join(work, "downloads", file), data);
    }
    const t = makeTorrent({
      name: file,
      data,
      webseed: f.webseed ? `http://seed:8080/${file}` : undefined,
      pieceLength: f.size > 64 * MiB ? 4 * MiB : 256 * 1024,
    });
    writeFileSync(join(work, "torrents", `${name}.torrent`), t.torrent);
    writeFileSync(join(work, "torrents", `${name}.hash`), t.infoHash);
  }
}

/**
 * Recorder side: the prepared torrent.
 *
 * @param {string} work work directory
 * @param {string} name key of TORRENT_FILES
 * @returns {{ torrent: Buffer, hash: string }} file and v1 info hash
 */
export function torrentOf(work, name) {
  return {
    torrent: readFileSync(join(work, "torrents", `${name}.torrent`)),
    hash: readFileSync(join(work, "torrents", `${name}.hash`), "utf8"),
  };
}
