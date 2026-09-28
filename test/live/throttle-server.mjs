// A throttled static file server for the container recorder: web seed for the torrent programs, HTTP source for
// JDownloader, pyLoad and aria2. Serves the directory given as argv[2] on port 8080 at RATE bytes per second,
// honours Range requests (web seeds ask for pieces) and answers 404 for anything else.
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

createServer((req, res) => {
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
