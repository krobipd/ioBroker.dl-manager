// Container recorder for live-programs.yml.
//
//   node test/live/record.mjs <program> <tag>            on the runner: network, seed server, program, recorder
//   node test/live/record.mjs <program> <tag> --inside   inside the recorder container: states + recordings
//
// Everything talks over the internal Docker network `dm` — no container reaches the internet, and the programs
// only ever see the seed server and each other.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OUT, pull, sh } from "./lib.mjs";

const [program, tag, mode] = process.argv.slice(2);
if (!program || !tag) {
  console.error("usage: record.mjs <program> <tag> [--inside]");
  process.exit(2);
}
const mod = await import(`./programs/${program}.mjs`);
const NODE_IMAGE = "node:22-alpine";

if (mode === "--inside") {
  const rec = await mod.record({ work: "/work", tag });
  console.log(`recorded ${rec.written.length} answers of ${rec.program} ${rec.version}`);
  for (const f of rec.written) {
    console.log(`  ${f}`);
  }
} else {
  const repo = resolve(".");
  const work = resolve(process.env.RUNNER_TEMP ?? "/tmp", `live-${program}`);
  mkdirSync(work, { recursive: true });
  const out = resolve(process.env.RUNNER_TEMP ?? "/tmp", OUT);
  mkdirSync(out, { recursive: true });
  const c = mod.prepare(work, tag);
  pull(NODE_IMAGE);
  pull(c.image);
  // `subnet`: a program that refuses private addresses (pyLoad) gets a public-looking range — still `--internal`
  sh("docker", ["network", "create", "--internal", ...(c.subnet ? ["--subnet", c.subnet] : []), "dm"]);
  sh("docker", [
    "run",
    "-d",
    "--name",
    "seed",
    "--network",
    "dm",
    "-v",
    `${join(work, "seed")}:/seed:ro`,
    "-v",
    `${join(repo, "test/live")}:/live:ro`,
    NODE_IMAGE,
    "node",
    "/live/throttle-server.mjs",
    "/seed",
  ]);
  for (const side of c.sidecars ?? []) {
    pull(side.image);
    // `internet`: a sidecar that installs a package on its start begins in the default network and joins `dm` after
    sh("docker", [
      "run",
      "-d",
      "--name",
      side.name,
      ...(side.internet ? [] : ["--network", "dm"]),
      ...(side.entrypoint ? ["--entrypoint", side.entrypoint] : []),
      ...Object.entries(side.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      ...(side.volumes ?? []).flatMap(v => ["-v", v]),
      side.image,
      ...(side.args ?? []),
    ]);
    if (side.internet) {
      sh("docker", ["network", "connect", "dm", side.name]);
    }
  }
  const envArgs = Object.entries(c.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const volArgs = (c.volumes ?? []).flatMap(v => ["-v", v]);
  // A program that loads parts of itself on its first start begins in the default network and joins `dm` after.
  const net = c.internet ? [] : ["--network", "dm"];
  // `entrypoint`: a program that has to be started in two steps gets a script of its own (Tribler)
  const entry = c.entrypoint ? ["--entrypoint", c.entrypoint] : [];
  // `user`: a program that has to share a socket with a sidecar runs under the sidecar's ids (Flood with rTorrent)
  const user = c.user ? ["--user", c.user] : [];
  sh("docker", [
    "run",
    "-d",
    "--name",
    c.name,
    ...net,
    ...envArgs,
    ...volArgs,
    ...entry,
    ...user,
    c.image,
    ...(c.args ?? []),
  ]);
  if (c.internet) {
    sh("docker", ["network", "connect", "dm", c.name]);
  }
  let failed = false;
  try {
    sh(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "dm",
        "-v",
        `${repo}:/w`,
        "-w",
        "/w",
        "-v",
        `${work}:/work`,
        "-v",
        `${out}:/out`,
        "-e",
        "FIXTURE_OUT=/out",
        NODE_IMAGE,
        "node",
        "test/live/record.mjs",
        program,
        tag,
        "--inside",
      ],
      { inherit: true },
    );
  } catch {
    failed = true;
  }
  for (const side of [{ name: "seed" }, ...(c.sidecars ?? [])]) {
    console.log(`---- ${side.name} log ----`);
    try {
      console.log(sh("docker", ["logs", "--tail", "50", side.name], { quiet: true }));
    } catch {
      // the log is a diagnosis aid only
    }
  }
  console.log(`---- ${c.name} log ----`);
  try {
    console.log(sh("docker", ["logs", "--tail", "200", c.name], { quiet: true }));
  } catch {
    // the log is a diagnosis aid only
  }
  if (failed) {
    process.exit(1);
  }
}
