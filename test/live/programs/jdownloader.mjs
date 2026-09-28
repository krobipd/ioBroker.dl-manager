// JDownloader 2 in the container recorder: jlesage image with a pre-seeded cfg/ (local "Deprecated API" on port 3128,
// no My.JDownloader account), packages from the throttled seed server. The first start loads JD's core from the
// internet, so the container starts in the default network and joins the internal one after. A download is a JD
// package (design decision 3); links are read for the status. api-jdownloader.md § 1.2, § 2, § 5.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Http, payload, prepareHttpFiles, pull, Recorder, sh, waitFor } from "../lib.mjs";

const MiB = 1024 * 1024;

/**
 * Runner side.
 *
 * @param {string} work work directory
 * @param {string} tag image tag
 * @returns {object} container definition
 */
export function prepare(work, tag) {
  prepareHttpFiles(work);
  // an archive for the extraction stage (python's zipfile is on every runner; stored, not compressed)
  const inner = join(work, "archive-content.bin");
  writeFileSync(inner, payload(24 * MiB, 99));
  execFileSync("python3", [
    "-c",
    "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_STORED);z.write(sys.argv[2],'content.bin');z.close()",
    join(work, "seed", "archive.zip"),
    inner,
  ]);
  // The image copies /defaults/cfg only when /config/cfg is missing, and its init script edits files of it — so the
  // defaults are taken out of the image and the settings below are laid over them.
  const image = `jlesage/jdownloader-2:${tag}`;
  const cfg = join(work, "jd", "cfg");
  mkdirSync(join(work, "jd"), { recursive: true });
  pull(image);
  sh("docker", ["create", "--name", "jd-defaults", image]);
  sh("docker", ["cp", "jd-defaults:/defaults/cfg", cfg]);
  sh("docker", ["rm", "jd-defaults"]);
  const files = {
    "org.jdownloader.api.RemoteAPIConfig.json": {
      deprecatedapienabled: true,
      deprecatedapiport: 3128,
      deprecatedapilocalhostonly: false,
      headlessmyjdownloadermandatory: false,
    },
    "org.jdownloader.settings.GeneralSettings.json": {
      defaultdownloadfolder: "/output",
      maxsimultanedownloads: 1,
    },
    "org.jdownloader.api.myjdownloader.MyJDownloaderSettings.json": {
      autoconnectenabledv2: false,
      email: "",
      password: "",
      devicename: "JDownloader@CI",
    },
  };
  for (const [name, content] of Object.entries(files)) {
    const file = join(cfg, name);
    const base = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...base, ...content }, null, 2));
  }
  mkdirSync(join(work, "output"), { recursive: true, mode: 0o777 });
  return {
    image,
    name: "jd",
    internet: true,
    env: { USER_ID: "1000", GROUP_ID: "1000", TZ: "Etc/UTC" },
    volumes: [`${join(work, "jd")}:/config`, `${join(work, "output")}:/output`],
  };
}

const PACKAGE_QUERY = {
  bytesLoaded: true,
  bytesTotal: true,
  childCount: true,
  comment: true,
  enabled: true,
  eta: true,
  finished: true,
  hosts: true,
  priority: true,
  running: true,
  saveTo: true,
  speed: true,
  status: true,
  maxResults: -1,
  startAt: 0,
};
const LINK_QUERY = {
  addedDate: true,
  advancedStatus: true,
  bytesLoaded: true,
  bytesTotal: true,
  comment: true,
  enabled: true,
  eta: true,
  extractionStatus: true,
  finished: true,
  finishedDate: true,
  host: true,
  jobUUID: true,
  priority: true,
  running: true,
  skipped: true,
  speed: true,
  status: true,
  url: true,
  maxResults: -1,
  startAt: 0,
};
const GS = "org.jdownloader.settings.GeneralSettings";

/**
 * Recorder side.
 *
 * @param {object} _ctx paths (unused)
 * @returns {Promise<Recorder>} the recorder
 */
export async function record(_ctx) {
  const http = new Http("http://jd:3128");
  let rid = 0;
  /**
   * @param {string} path API path, e.g. /downloadsV2/queryLinks
   * @param {unknown[]} params positional params
   * @returns {Promise<{ status: number, text: string, headers: Record<string,string>, json: () => Record<string, unknown>, sent: string }>} answer
   */
  const call = async (path, params = []) => {
    const body = { apiVer: 1, url: path, params, rid: ++rid };
    const res = await http.req("POST", path, { json: body });
    return { ...res, sent: JSON.stringify(body) };
  };
  const data = async (path, params) => (await call(path, params)).json().data;
  await waitFor("JDownloader local API", async () => (await call("/jd/version")).status === 200, 900_000, 5000);

  const versionRes = await call("/jd/version");
  const rec = new Recorder("jdownloader", String(versionRes.json().data));
  const w = (state, name, res) => rec.write(state, name, `POST ${res.sent}`, res);
  w("auth", "jd-version", versionRes);
  w("auth", "device-ping", await call("/device/ping"));
  w("auth", "unknown-method", await call("/downloadsV2/noSuchMethod"));
  w("open-points", "config-get-storage-null", await call("/config/get", [GS, null, "DownloadSpeedLimit"]));
  w("open-points", "config-get-storage-cfg", await call("/config/get", [GS, "cfg", "DownloadSpeedLimit"]));

  const snapshot = async state => {
    w(state, "toolbar-get-status", await call("/toolbar/getStatus"));
    w(state, "current-state", await call("/downloadcontroller/getCurrentState"));
    w(state, "speed-in-bps", await call("/downloadcontroller/getSpeedInBps"));
    w(state, "query-packages", await call("/downloadsV2/queryPackages", [PACKAGE_QUERY]));
    w(state, "query-links", await call("/downloadsV2/queryLinks", [LINK_QUERY]));
  };
  const links = async () => data("/downloadsV2/queryLinks", [LINK_QUERY]);
  const packages = async () => data("/downloadsV2/queryPackages", [PACKAGE_QUERY]);
  const add = async (name, file, extra = {}) => {
    const res = await call("/linkgrabberv2/addLinks", [
      { links: `http://seed:8080/${file}`, autostart: true, assignJobID: true, packageName: name, ...extra },
    ]);
    const job = res.json().data?.id;
    const inList = async () => (await links()).find(x => x.jobUUID === job)?.packageUUID;
    const pkg = await waitFor(`${name} in the download list`, inList, 30_000).catch(async () => {
      // an offline link (404) stays in the link grabber despite autostart — move it over like a user would
      const crawled = await call("/linkgrabberv2/queryLinks", [{ jobUUIDs: [job], availability: true, status: true }]);
      w("open-points", `linkgrabber-${name}`, crawled);
      const cl = crawled.json().data ?? [];
      w(
        "open-points",
        `move-to-downloadlist-${name}`,
        await call("/linkgrabberv2/moveToDownloadlist", [
          cl.map(l => l.uuid),
          [...new Set(cl.map(l => l.packageUUID))],
        ]),
      );
      return waitFor(`${name} in the download list after moving`, inList, 30_000);
    });
    return { res, pkg };
  };
  const pkgOf = async uuid => (await packages()).find(p => p.uuid === uuid);
  const linksOf = async uuid => (await links()).filter(l => l.packageUUID === uuid);

  await snapshot("empty");

  // completed + failed (404)
  const small = await add("small", "small.bin");
  w("commands", "add-links", small.res);
  const failed = await add("missing", "missing.bin");
  await waitFor(
    "small finished + missing failed",
    async () =>
      (await pkgOf(small.pkg))?.finished && (await linksOf(failed.pkg)).every(l => l.advancedStatus?.FinalLinkState),
    180_000,
    1000,
  );
  await snapshot("finished-and-failed");

  // running: one package downloads (max 1 at a time), one waits, one disabled (JD's per-item pause)
  const big = await add("big", "big.bin");
  await add("queued", "queued.bin");
  const stopped = await add("stopped", "stopped.bin");
  w("commands", "set-enabled-false", await call("/downloadsV2/setEnabled", [false, [], [stopped.pkg]]));
  await waitFor("big running", async () => (await pkgOf(big.pkg))?.running, 120_000, 1000);
  await snapshot("running");

  // open point: empty id lists — nothing or everything?
  w("open-points", "set-enabled-empty-lists", await call("/downloadsV2/setEnabled", [true, [], []]));
  w("open-points", "after-empty-lists", await call("/downloadsV2/queryPackages", [PACKAGE_QUERY]));
  await call("/downloadsV2/setEnabled", [false, [], [stopped.pkg]]);

  // global pause (only while RUNNING), then resume
  w("commands", "pause-true", await call("/downloadcontroller/pause", [true]));
  await waitFor("paused", async () => (await data("/downloadcontroller/getCurrentState")) === "PAUSE", 30_000);
  await snapshot("paused-global");
  w("commands", "pause-false", await call("/downloadcontroller/pause", [false]));

  // limits
  w("commands", "config-set-limit", await call("/config/set", [GS, null, "DownloadSpeedLimit", 2_000_000]));
  w("commands", "config-set-limit-enabled", await call("/config/set", [GS, null, "DownloadSpeedLimitEnabled", true]));
  await snapshot("limited");
  await call("/config/set", [GS, null, "DownloadSpeedLimitEnabled", false]);

  // events: the envelope of subscribe/listen
  const sub = await call("/events/subscribe", [["downloads.*", "downloadwatchdog.*"], []]);
  w("open-points", "events-subscribe", sub);
  const subId = sub.json().data?.subscriptionid;
  if (subId !== undefined) {
    w("open-points", "events-listen", await call("/events/listen", [subId]));
    await call("/events/unsubscribe", [subId]);
  }

  // stop, then start again; open point: does stop keep partial progress?
  w("commands", "stop", await call("/downloadcontroller/stop"));
  await waitFor(
    "stopped",
    async () => /STOPPED_STATE|IDLE/.test(await data("/downloadcontroller/getCurrentState")),
    60_000,
  );
  await snapshot("stopped");
  w("commands", "start", await call("/downloadcontroller/start"));

  // extraction (best effort: a stored zip extracts fast)
  const archive = await add("archive", "archive.zip", { autoExtract: true });
  const seen = new Set();
  await waitFor(
    "archive extracted",
    async () => {
      const l = (await linksOf(archive.pkg))[0];
      const ex = l?.advancedStatus?.ExtractionStatus?.id ?? l?.extractionStatus;
      if (ex) {
        seen.add(ex);
      }
      if (ex === "RUNNING" && !rec.written.some(f => f.includes("/extracting/"))) {
        await snapshot("extracting");
      }
      return ex === "SUCCESSFUL" || (typeof ex === "string" && ex.startsWith("ERR"));
    },
    300_000,
    200,
  );
  console.log(`jdownloader: extraction states seen: ${[...seen].join(", ")}`);
  await snapshot("extracted");

  // finish, remove from the list (files stay)
  await waitFor("big finished", async () => (await pkgOf(big.pkg))?.finished, 240_000, 2000);
  await snapshot("finished");
  w("commands", "remove-links", await call("/downloadsV2/removeLinks", [[], [failed.pkg]]));
  await snapshot("removed");
  return rec;
}
