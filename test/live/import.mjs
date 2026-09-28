// Takes the recordings of a live-programs run into test/fixtures/.
//
//   gh run download <run-id> -D <dir>            (every artifact fixtures-<program>-<tag>)
//   node test/live/import.mjs <dir>
//
// Every file is scrubbed before it lands in the repository: the test secrets of the recorder become `<secret>`,
// IPv4 addresses of the container network become documentation addresses (RFC 5737), the runner's host name
// disappears. The run fails when anything that looks like a secret or a foreign address is left.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SECRETS = ["testpass1", "testsecret1", "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"];
const KEEP_IPS = new Set(["0.0.0.0", "127.0.0.1", "255.255.255.255"]);

const src = process.argv[2];
if (!src) {
  console.error("usage: import.mjs <downloaded artifacts dir>");
  process.exit(2);
}
const dest = "test/fixtures";

/**
 * @param {string} dir directory
 * @returns {string[]} every file below it
 */
function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const ipMap = new Map();
/**
 * @param {string} ip an IPv4 address from a recording
 * @returns {string} the address that goes into the repository
 */
function docIp(ip) {
  if (KEEP_IPS.has(ip)) {
    return ip;
  }
  if (!ipMap.has(ip)) {
    ipMap.set(ip, `192.0.2.${ipMap.size + 10}`);
  }
  return ipMap.get(ip);
}

const staging = join(dest, ".import");
rmSync(staging, { recursive: true, force: true });
let files = 0;
const problems = [];
for (const artifact of readdirSync(src)) {
  const root = join(src, artifact);
  if (!statSync(root).isDirectory()) {
    continue;
  }
  for (const file of walk(root).filter(f => f.endsWith(".json"))) {
    let text = readFileSync(file, "utf8");
    for (const s of SECRETS) {
      text = text.split(s).join("<secret>");
    }
    text = text.replace(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g, (m, ip) =>
      ip.split(".").every(n => Number(n) <= 255) ? docIp(ip) : m,
    );
    text = text.replace(/\bfv-az[\w-]+/g, "runner");
    // pyLoad API keys the recorder created (pl_<id><43 characters>)
    text = text.replace(/\bpl_\d[\w-]{40,}/g, "<secret>");
    JSON.parse(text);
    if (/(api[_-]?key|password|passwd|secret|token)"\s*:\s*"(?!<secret>|")[^"]{6,}"/i.test(text)) {
      problems.push(`${file}: a value next to a secret-looking key is left`);
    }
    const target = join(staging, relative(root, file));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    files++;
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error("nothing imported — check the recorder's masking");
  rmSync(staging, { recursive: true, force: true });
  process.exit(1);
}
for (const program of readdirSync(staging)) {
  for (const version of readdirSync(join(staging, program))) {
    rmSync(join(dest, program, version), { recursive: true, force: true });
    cpSync(join(staging, program, version), join(dest, program, version), { recursive: true });
  }
}
rmSync(staging, { recursive: true, force: true });
console.log(
  `imported ${files} recordings; addresses replaced: ${[...ipMap].map(([a, b]) => `${a}→${b}`).join(", ") || "none"}`,
);
