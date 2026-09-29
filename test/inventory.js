/* global describe, it, before, after */
"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller,
//   drive it with fixtures covering EVERY device type the adapter supports
//   (feedFixtures), then dump every <adapter>.0.* object to
//   test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory): seed the previous
//   objects BEFORE start, start, feed, then assert that every object carries the
//   current common (every field) and object type, and that removed objects are gone.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
// An object is written at most three times in one start: created, its name refreshed, enriched once after
// discovery. More is churn — every write goes to the database and to every subscriber (round 60, measured
// 2026-09-28 over the fleet: 1-3 everywhere, 251 for an object whose stored key flipped on every resync).
const MAX_OBJECT_WRITES = 3;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
// Value dumps for the readable-values judge (`iobroker-adapter-checks values`, gate D08 + CI job): the states
// after the fixture run, and the objects once more from a run in a second system language. Generated, not
// committed (.gitignore) — timestamps and counters would make a golden file drift on every run.
const STATES_INVENTORY = path.join(__dirname, "states.inventory.json");
const OBJECTS_SECOND_LANGUAGE = path.join(__dirname, "objects.inventory.de.json");
const FIRST_LANGUAGE = "en";
const SECOND_LANGUAGE = "de";
const VOLATILE = ["ts", "from", "user", "acl"];
// Key order carries no meaning in an ioBroker object: extendObject keeps the key order an existing
// object already has, while adapter-core's I18n.getTranslatedObject builds its own — the same eleven
// texts in another order are the same name. Arrays keep their order.
const canonical = v =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, x[k]]),
        )
      : x,
  );
// How long the upgrade suite keeps watching after its verdict: a write in that window means the wait ended before
// the adapter did (round 61, measured 2026-09-29 over the fleet: none in 10 s at HEAD; parcelapp's old wait judged
// 5 ms before the first of 187 writes).
const SETTLE_MS = 10000;
const INSTANCE_OBJECTS = new Set(
  (require(path.join(ADAPTER_DIR, "io-package.json")).instanceObjects ?? []).map(o => `${NS}${o._id}`),
);
// Round 62: every adapter start loads test/resource-probe.js (fleet master) FIRST; at its exit it records what the
// adapter or one of its libraries left open after onUnload, and the run fails on any of it (the after() at the end).
const RESOURCE_PROBE = path.join(__dirname, "resource-probe.js");
const RESOURCE_DIR = fs.mkdtempSync(path.join(require("node:os").tmpdir(), `${ADAPTER}-resources-`));
// Round 62: the adapter's read-only states (`common.write: false`) — only the adapter writes them, so it compares them
// in memory; a database read of one in the quiet window after the verdict is a finding.
const READ_ONLY = new Set();

/**
 * The environment of every adapter start: the resource probe first, then the test hooks of this adapter.
 *
 * @param {...string} hooks absolute paths of `--require` hooks (fixture servers, DNS)
 */
function adapterEnv(...hooks) {
  return {
    NODE_OPTIONS: [RESOURCE_PROBE, ...hooks].map(file => `--require ${file}`).join(" "),
    RESOURCE_PROBE_DIR: RESOURCE_DIR,
    RESOURCE_PROBE_NS: NS,
  };
}

/**
 * Every object write of the adapter in this suite, and which of them changed nothing (round 61). An unchanged
 * rewrite still goes to the database and to every subscriber — the adapter writes only what differs. The FIRST
 * write of an `instanceObjects` entry is js-controller's own (`_createInstancesObjects` extends every entry before
 * `onReady`, 7.2.2) and not the adapter's choice. Called as the suite's first await, so the start is watched from
 * its first write; the known content comes from the database, a seed included.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function watchObjectWrites(harness) {
  const watch = { writes: new Map(), peak: new Map(), unchanged: [], deleted: [], times: [], unchangedIndicators: [] };
  const known = new Map();
  const roles = new Map();
  const states = new Map();
  const content = obj => {
    const { ts, from, user, ...rest } = obj;
    return canonical(rest);
  };
  harness.on("objectChange", (id, obj) => {
    if (!id.startsWith(NS)) {
      return;
    }
    if (!obj) {
      watch.deleted.push(id);
      known.delete(id);
      roles.delete(id);
      return;
    }
    roles.set(id, obj.common?.role);
    if (obj.type === "state" && obj.common?.write === false) {
      READ_ONLY.add(id);
    } else {
      READ_ONLY.delete(id);
    }
    const now = content(obj);
    if (obj.from === `system.adapter.${ADAPTER}.0`) {
      const n = (watch.writes.get(id) ?? 0) + 1;
      watch.writes.set(id, n);
      watch.peak.set(id, Math.max(watch.peak.get(id) ?? 0, n));
      watch.times.push([id, Date.now()]);
      if (known.get(id) === now && !(n === 1 && INSTANCE_OBJECTS.has(id))) {
        watch.unchanged.push(id);
      }
    }
    known.set(id, now);
  });
  // Round 62: an indicator state (`indicator.*`) is written only on a change (read-only: compared in memory,
  // writable: setStateChangedAsync) — a write that changes nothing is a finding. Compared is what js-controller
  // 7.2.2 compares in setStateChangedAsync: val strictly, ack, q, c; an object value always counts as changed.
  harness.on("stateChange", (id, state) => {
    if (!id.startsWith(NS) || !state || state.from !== `system.adapter.${ADAPTER}.0`) {
      return;
    }
    const now =
      state.val !== null && typeof state.val === "object" ? null : canonical([state.val, state.ack, state.q, state.c]);
    if (now !== null && states.get(id) === now && String(roles.get(id)).startsWith("indicator")) {
      watch.unchangedIndicators.push(id);
    }
    states.set(id, now);
  });
  // Round 64: a restart the harness plays (playControllerRestarts) is a new start — the per-start counts begin again,
  // the known object content stays (it is the database's).
  watch.newStart = () => {
    watch.writes.clear();
    states.clear();
  };
  const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
  for (const row of list.rows) {
    if (row.value) {
      known.set(row.id, content(row.value));
      roles.set(row.id, row.value.common?.role);
      if (row.value.type === "state" && row.value.common?.write === false) {
        READ_ONLY.add(row.id);
      }
    }
  }
  return watch;
}

/**
 * Adapter-specific: make the adapter create every object it can create.
 * A catalog-driven adapter needs nothing here (its objects appear at start).
 * A device/API-driven adapter feeds fixtures for EVERY device type here — a fake
 * device/cloud endpoint on localhost, MQTT messages, or a message via sendTo —
 * never only the maintainer's own devices.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function feedFixtures(harness) {
  await waitForAdapterWork(harness);
}

/**
 * Adapter-specific: wait until the adapter has really DONE its work on top of the SEEDED tree.
 * Suite 2 only — suite 1 needs nothing beyond feedFixtures. Name it after the adapter's own cycle
 * (parcelapp: `waitForCompletedPoll`); what matters is the criterion, not the name.
 *
 * Suite 2 seeds the previous release's OBJECTS before the start, so a wait that looks for objects
 * — which is exactly what feedFixtures does in suite 1 — is satisfied on its first look, and the
 * assertions run before the adapter has written anything. Suite 1 has the same blind spot wherever
 * ALL objects come from `instanceObjects`: js-controller creates them before `ready` fires, so an
 * object wait proves nothing about the adapter; there suite 1 also waits for a value the adapter
 * itself writes (for example `info.connection`, acknowledged). Measured public-holidays 2026-09-25:
 * with the ready handler never registered, suite 1 stayed green on the object wait alone. Measured parcelapp
 * 2026-09-07 (its first upgrade run): the assertion fired 13 ms after `onReady`, and the adapter's
 * only poll attempt hit the fixture server AFTER `after()` had already closed it. The suite then
 * reported "desc still undefined" for the three datapoints whose description was new — which reads
 * exactly like an adapter that fails to reach existing objects, while in truth nothing had run yet.
 * A catalog adapter, whose feedFixtures is `void harness`, has NO wait here at all.
 *
 * The seed uses `setObjectAsync` — objects only, never a VALUE. State values are therefore the one
 * signal it cannot fake.
 *
 * ⚠️ Cover EVERY object area the suites check, and wait there for the value the cycle writes LAST.
 * The wait ends as soon as every id below has a state; whatever the cycle writes after the last waited
 * id is checked unwaited. Measured on parcelapp 2026-09-25 (CI run 36123917452): the wait watched
 * `.carrier` (written early, per package), `updateSummary` wrote the three `summary.*` values a few
 * milliseconds after the check, and the suite reported "desc still …" only there — green locally,
 * red in CI. A value counts as written once its state exists (`""` included where the adapter really
 * writes it — the seed never writes values).
 *
 * ⚠️ Pick ids the adapter writes UNCONDITIONALLY on every cycle. A value behind a condition hangs
 * the wait until the deadline: parcelapp's `lastUpdated` writes only when the tracking data really
 * changed, and `info.connection` is no substitute either — it flips right after the API call and
 * before the per-device states are written.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function waitForAdapterWork(harness) {
  // A tree, not a count: every program is online and every one lists its downloads, and the summary the
  // adapter writes after each poll says all are reachable (written last in the cycle).
  const deadline = Date.now() + 90000;
  for (;;) {
    const missing = [];
    for (const dev of DEVICES) {
      const online = await harness.states.getState(`${NS}${dev}.online`);
      if (online?.val !== true) {
        missing.push(`${NS}${dev}.online`);
        continue;
      }
      const channels = await harness.objects.getObjectList({
        startkey: `${NS}${dev}.downloads.`,
        endkey: `${NS}${dev}.downloads.香`,
      });
      if (!channels.rows.some(r => r.value?.type === "channel")) missing.push(`${NS}${dev}.downloads.*`);
    }
    const all = await harness.states.getState(`${NS}info.programsAllOnline`);
    if (all?.val !== true) missing.push(`${NS}info.programsAllOnline`);
    if (missing.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `no completed cycle — ${missing.length} id(s) without a value, e.g. ${missing.slice(0, 5).join(", ")}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Every program type once — each host name is answered by test/fixture-hook.js from the recordings in
 * test/fixtures/ (JDownloader through My.JDownloader by the hook's own api.jdownloader.org with real AES).
 */
const PROGRAM_ROWS = [
  ["jdownloader", "JDownloader", { host: "jdownloader.fixture", port: 3128 }],
  [
    "jdownloader-cloud",
    "JDownloader (My.JDownloader)",
    { username: "fixture@example.com", password: "fixture", device: "JD Fixture" },
  ],
  ["qbittorrent", "qBittorrent", { host: "qbittorrent.fixture", port: 8080, username: "admin", password: "fixture" }],
  [
    "transmission",
    "Transmission",
    { host: "transmission.fixture", port: 9091, username: "admin", password: "fixture" },
  ],
  ["deluge", "Deluge", { host: "deluge.fixture", port: 8112, password: "fixture" }],
  ["sabnzbd", "SABnzbd", { host: "sabnzbd.fixture", port: 8080, apiKey: "fixture" }],
  ["nzbget", "NZBGet", { host: "nzbget.fixture", port: 6789, username: "admin", password: "fixture" }],
  ["aria2", "aria2", { host: "aria2.fixture", port: 6800, apiKey: "fixture" }],
  ["pyload", "pyLoad", { host: "pyload.fixture", port: 8000, apiKey: "fixture" }],
];
/** Device id of each row (`<type>-<key>`). */
const DEVICES = PROGRAM_ROWS.map(([type]) => `${type}-fixture`);

/** Adapter-specific config the fixtures need (fake endpoint address, credentials, ...). */
const FIXTURE_NATIVE = {
  // secrets go in as typed, the way the program rows hold them
  programs: PROGRAM_ROWS.map(([type, name, cfg]) => ({
    enabled: true,
    type,
    key: "fixture",
    name,
    host: "",
    port: 0,
    https: false,
    path: "",
    username: "",
    password: "",
    apiKey: "",
    device: "",
    ...cfg,
  })),
  pollInterval: 10,
  treeScope: "all",
  maxDownloads: 0,
};

/** The adapter process gets the fetch hook — the test process keeps the real fetch. */
const HOOK = path.join(__dirname, "fixture-hook.js");

async function dumpObjects(harness) {
  // The range starts at "<adapter>.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) delete obj[key];
    out[row.id] = obj;
  }
  return out;
}

/**
 * Set the throwaway controller's system language — what the adapter reads from `system.config`.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {string} language an ioBroker language code
 */
async function setSystemLanguage(harness, language) {
  const config = await harness.objects.getObject("system.config");
  config.common.language = language;
  await harness.objects.setObject("system.config", config);
}

/**
 * Dump the value of every state of the instance: `{ "<id>": { val, ack } }`, sorted. The states client has no
 * `getKeysAsync` — `getKeys`/`getStates` (like `getObject`/`setObject`) return a promise without a callback.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function dumpStates(harness) {
  const keys = (await harness.states.getKeys(`${NS}*`)).sort();
  const values = await harness.states.getStates(keys);
  const out = {};
  keys.forEach((key, i) => {
    if (values[i]) out[key] = { val: values[i].val, ack: values[i].ack };
  });
  return out;
}

/**
 * The throwaway js-controller keeps its instance object between runs, and changeAdapterConfig only
 * EXTENDS native — a key that an older version of this adapter wrote would survive and trigger the
 * start-up key migration and with it a host restart (played since round 64) in every suite. Null every key the
 * fixture does not know, then apply the fixture (null is the post-migration state of a renamed key).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function resetInstanceNative(harness) {
  const instance = await harness.objects.getObjectAsync(`system.adapter.${ADAPTER}.0`);
  const stale = {};
  for (const key of Object.keys(instance?.native ?? {})) {
    if (!Object.hasOwn(FIXTURE_NATIVE, key)) stale[key] = null;
  }
  // The program rows hold password and API key as typed (protectedNative, no encryptedAttributes) —
  // the fixture rows go in the same way.
  await harness.changeAdapterConfig(ADAPTER, { native: { ...stale, ...FIXTURE_NATIVE } });
}

/**
 * js-controller 7.2.2 restarts an instance on EVERY change of its instance object while it runs (controller main.ts,
 * objects `change` handler: `stopInstance`, then `startInstance` after `stopTimeout` + 2.5 s) — whoever wrote it, the
 * adapter's own settings migration or device table included. The harness has no host; this plays it (round 64): the
 * first change while the adapter runs stops it and starts it once more with the same hooks, so what the adapter did
 * after that write in the same start is cut off here as it is on a real host. A change after that restart is a finding:
 * on a host the instance would restart again, for good.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {object | null} watch the suite's write watcher (watchObjectWrites), null in a suite without one
 * @param {...string} hooks the test hooks the suite starts the adapter with (as for adapterEnv)
 */
function playControllerRestarts(harness, watch, ...hooks) {
  const restarts = { count: 0, again: [], done: Promise.resolve() };
  harness.on("objectChange", id => {
    if (id !== `system.adapter.${ADAPTER}.0` || !harness.isAdapterRunning()) {
      return;
    }
    if (restarts.count > 0) {
      restarts.again.push(Date.now());
      return;
    }
    restarts.count++;
    restarts.done = (async () => {
      await harness.stopAdapter();
      watch?.newStart();
      // What the host does when the process exits: `alive` false (a start that still sees it true ends with
      // ADAPTER_ALREADY_RUNNING, exit code 7), then the start after stopTimeout + 2.5 s.
      await harness.states.setState(`system.adapter.${ADAPTER}.0.alive`, {
        val: false,
        ack: true,
        from: "system.host.testing",
      });
      await new Promise(resolve => setTimeout(resolve, RESTART_DELAY_MS));
      // @iobroker/testing refuses a second start of one harness ("already been used"); the host starts the same
      // instance again — reset the exit marker, and fail loudly should the harness no longer keep it there.
      harness._adapterExit = undefined;
      assert.ok(
        !harness.didAdapterStop(),
        "@iobroker/testing changed its exit marker — the restart play needs a new form",
      );
      await harness.startAdapterAndWait(false, adapterEnv(...hooks));
    })();
  });
  return restarts;
}

/** Round 64: the host's wait before it starts a stopped instance again (controller main.ts, `stopTimeout || 500` + 2.5 s). */
const RESTART_DELAY_MS = (require(path.join(ADAPTER_DIR, "io-package.json")).common.stopTimeout || 500) + 2500;
/** Round 64: the recording marker every seeded state carries in `common.custom`, naming the id it was seeded under. */
const RECORDING = "inventory-recording.0";

/**
 * Seed the previous release's objects before the start. Every state carries a recording marker (round 64): what hangs
 * on a datapoint is the user's — it goes on with the SAME datapoint (its id, or the one id a move gives it), never onto
 * a new datapoint, and never decides what the adapter creates, keeps or deletes (that shows up as a leftover or a
 * missing object against the committed inventory).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, ioBroker.Object>} previous the previous release's inventory
 */
async function seedPrevious(harness, previous) {
  for (const [id, obj] of Object.entries(previous)) {
    const common =
      obj.type === "state"
        ? { ...obj.common, custom: { ...obj.common?.custom, [RECORDING]: { enabled: true, origin: id } } }
        : obj.common;
    await harness.objects.setObjectAsync(id, { ...obj, common });
  }
}

tests.integration(ADAPTER_DIR, {
  controllerVersion: "stable",
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      let watch;
      let restarts;
      before(async function () {
        this.timeout(120000);
        harness = getHarness();
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness);
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        restarts = playControllerRestarts(harness, watch, HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(HOOK));
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });

      it("gives every device a pictogram that decodes to one of admin/icons/*.svg", async function () {
        const objects = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
        const iconDir = path.join(ADAPTER_DIR, "admin", "icons");
        const files = new Set(
          fs.readdirSync(iconDir).map(f => fs.readFileSync(path.join(iconDir, f), "utf8").replace(/\r\n/g, "\n")),
        );
        const devices = Object.entries(objects).filter(([, o]) => o.type === "device");
        assert.ok(devices.length > 0, "no device in the inventory");
        for (const [id, o] of devices) {
          const icon = String(o.common?.icon ?? "");
          assert.ok(icon.startsWith("data:image/svg+xml;base64,"), `${id}: icon is not an inline data URI`);
          const svg = Buffer.from(icon.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
          assert.ok(files.has(svg), `${id}: icon is none of the pictogram files`);
        }
      });

      it("writes test/states.inventory.json", async function () {
        this.timeout(30000);
        const states = await dumpStates(harness);
        assert.ok(Object.keys(states).length > 0, "no states written — fixtures did not reach the adapter");
        fs.writeFileSync(STATES_INVENTORY, `${JSON.stringify(states, null, 2)}\n`);
      });

      it("writes no object more than MAX_OBJECT_WRITES times", function () {
        const churn = [...watch.peak].filter(([, n]) => n > MAX_OBJECT_WRITES).map(([id, n]) => `${id} ×${n}`);
        assert.deepStrictEqual(churn, [], `objects written more than ${MAX_OBJECT_WRITES} times in one start`);
      });

      it("rewrites no object unchanged", function () {
        const idle = [...new Set(watch.unchanged)];
        assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
      });

      it("rewrites no indicator state unchanged", function () {
        const idle = [...new Set(watch.unchangedIndicators)];
        assert.deepStrictEqual(idle, [], `indicator states written without a change:\n${idle.join("\n")}`);
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });
    });

    // The same run once more in a second system language: a label that stays the same in both was never
    // translated. A suite of its own — the harness starts an adapter only once per suite (a second
    // startAdapterAndWait in the same suite never resolves), and every suite gets a fresh database.
    suite("second system language", getHarness => {
      let harness;
      let restarts;
      before(async function () {
        this.timeout(120000);
        harness = getHarness();
        await resetInstanceNative(harness);
        await setSystemLanguage(harness, SECOND_LANGUAGE);
        restarts = playControllerRestarts(harness, null, HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(HOOK));
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });

      it("writes test/objects.inventory.de.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(OBJECTS_SECOND_LANGUAGE, `${JSON.stringify(objects, null, 2)}\n`);
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        let watch;
        let restarts;
        let verdictAt;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(120000);
          harness = getHarness();
          watch = await watchObjectWrites(harness);
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          await seedPrevious(harness, previous);
          await resetInstanceNative(harness);
          // The inventory was written in FIRST_LANGUAGE: labels an adapter localises itself (`states`)
          // only compare in the same language.
          await setSystemLanguage(harness, FIRST_LANGUAGE);
          restarts = playControllerRestarts(harness, watch, HOOK);
          await harness.startAdapterAndWait(false, adapterEnv(HOOK));
          await feedFixtures(harness);
          // The seeded set makes feedFixtures a no-op here — this is the real wait.
          await waitForAdapterWork(harness);
          // A migration that wrote the instance object restarts the instance (round 64) — the verdict
          // comes after the second start has done its work.
          await restarts.done;
          await waitForAdapterWork(harness);
          verdictAt = Date.now();
          fs.writeFileSync(
            path.join(RESOURCE_DIR, "window.json"),
            JSON.stringify({ start: verdictAt, end: verdictAt + SETTLE_MS }),
          );
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            // Every field of `common`, not a chosen few: an adapter writes only what differs (round 61),
            // so every changed field must reach an existing installation.
            for (const f of new Set([...Object.keys(obj.common ?? {}), ...Object.keys(got.common ?? {})])) {
              if (f === "custom") {
                continue; // the user's recording — judged on its own below (round 64)
              }
              if (canonical(got.common?.[f]) !== canonical(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            // The KIND of the object (state/channel/device/folder/meta) lives one level
            // ABOVE `common`; `common.type` is the VALUE type (string/number/
            // boolean) — something entirely different that merely shares the name. Without
            // this comparison a type migration that never reaches an existing installation
            // stays green: every text matches while every datapoint under the wrongly
            // declared container is a repochecker E2001 (hueemu v1.17.0, `clients` from
            // `meta` to `folder` — found on the live tree, by no gate).
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
          }
          assert.deepStrictEqual(stale, [], "objects an update did not reach:\n" + stale.join("\n"));
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], "leftover objects:\n" + leftovers.join("\n"));
        });

        it("rewrites no object unchanged", function () {
          const idle = [...new Set(watch.unchanged)];
          assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
        });

        it("rewrites no indicator state unchanged", function () {
          const idle = [...new Set(watch.unchangedIndicators)];
          assert.deepStrictEqual(idle, [], `indicator states written without a change:\n${idle.join("\n")}`);
        });

        // A kept object that is deleted and created anew makes the suite judge a fresh object, not the
        // upgraded one (hassemu v1.43.1: the stale cleanup removed 18 seeded clients before the dump).
        it("deletes no object the release keeps", function () {
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const lost = [...new Set(watch.deleted)].filter(id => id in previous && id in current);
          assert.deepStrictEqual(lost, [], `kept objects deleted during the upgrade:\n${lost.join("\n")}`);
        });

        it("a recording goes on only with its own datapoint", async function () {
          this.timeout(30000);
          const live = await dumpObjects(harness);
          const carriers = new Map();
          for (const [id, obj] of Object.entries(live)) {
            const origin = obj.common?.custom?.[RECORDING]?.origin;
            if (origin) {
              carriers.set(origin, [...(carriers.get(origin) ?? []), id]);
            }
          }
          const wrong = [];
          for (const [origin, ids] of carriers) {
            if (ids.length > 1) {
              wrong.push(`${origin} → ${ids.join(", ")}: one recording on several datapoints`);
            } else if (ids[0] !== origin && origin in live) {
              wrong.push(`${origin} → ${ids[0]}: copied while ${origin} lives on`);
            } else if (ids[0] !== origin && live[ids[0]].common?.type !== previous[origin]?.common?.type) {
              wrong.push(`${origin} → ${ids[0]}: another value type — a new datapoint, not the same one moved`);
            }
          }
          // A state that lives on keeps what hangs on it — the recording is the user's, never destroyed.
          for (const [id, obj] of Object.entries(previous)) {
            if (obj.type === "state" && live[id]?.type === "state" && !carriers.get(id)?.includes(id)) {
              wrong.push(`${id}: its recording is gone although the datapoint lives on`);
            }
          }
          assert.deepStrictEqual(wrong, [], `recordings that left their datapoint:\n${wrong.join("\n")}`);
        });

        // What a fresh installation does not have, an upgrade must not have either — whatever made it (round 64:
        // a datapoint created because the old one was recorded is exactly that).
        it("creates nothing a fresh installation lacks", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const extra = Object.keys(live).filter(id => !(id in current));
          assert.deepStrictEqual(extra, [], `objects a fresh installation does not have:\n${extra.join("\n")}`);
        });

        it("restarts at most once for its own instance object", function () {
          assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
        });

        // Last in the suite: a write after the verdict means waitForAdapterWork ended before the adapter did.
        it("writes nothing after the verdict", async function () {
          this.timeout(SETTLE_MS + 5000);
          await new Promise(resolve => setTimeout(resolve, Math.max(0, verdictAt + SETTLE_MS - Date.now())));
          const late = [...new Set(watch.times.filter(([, t]) => t > verdictAt).map(([id]) => id))];
          assert.deepStrictEqual(late, [], `objects written after the verdict:\n${late.join("\n")}`);
        });
      });
    }
  },
});

// Round 62: after every suite, every adapter process of this run has exited — what it left open after onUnload fails
// the run. Every start leaves a marker: no marker means a start without adapterEnv(), a marker without a report a
// process that never reached its exit (killed after a hanging onUnload, or crashed).
after(function () {
  const files = fs.readdirSync(RESOURCE_DIR);
  const starts = files.filter(f => f.endsWith(".start")).map(f => f.slice(0, -".start".length));
  const silent = starts.filter(pid => !files.includes(`${pid}.json`));
  const reports = starts
    .filter(pid => !silent.includes(pid))
    .map(pid => JSON.parse(fs.readFileSync(path.join(RESOURCE_DIR, `${pid}.json`), "utf8")));
  const left = reports.flatMap(r => r.left);
  const reread = reports.flatMap(r =>
    Object.entries(r.quiet)
      .filter(([id]) => READ_ONLY.has(id))
      .map(([id, n]) => `${id} ×${n}`),
  );
  fs.rmSync(RESOURCE_DIR, { recursive: true, force: true });
  assert.ok(starts.length > 0, "no adapter start loaded the resource probe — a start without adapterEnv()");
  assert.deepStrictEqual(silent, [], "adapter processes that never reached their exit (killed or crashed)");
  assert.deepStrictEqual(left, [], `left open after onUnload:\n${left.join("\n")}`);
  assert.deepStrictEqual(
    reread,
    [],
    `read-only states read back from the database while nothing changed:\n${reread.join("\n")}`,
  );
});
