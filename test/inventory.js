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
  const watch = { writes: new Map(), unchanged: [], deleted: [], times: [] };
  const known = new Map();
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
      return;
    }
    const now = content(obj);
    if (obj.from === `system.adapter.${ADAPTER}.0`) {
      const n = (watch.writes.get(id) ?? 0) + 1;
      watch.writes.set(id, n);
      watch.times.push([id, Date.now()]);
      if (known.get(id) === now && !(n === 1 && INSTANCE_OBJECTS.has(id))) {
        watch.unchanged.push(id);
      }
    }
    known.set(id, now);
  });
  const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
  for (const row of list.rows) {
    if (row.value) {
      known.set(row.id, content(row.value));
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
  // secrets go in as typed, the way the settings table stores them
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
const ADAPTER_ENV = { NODE_OPTIONS: `--require ${path.join(__dirname, "fixture-hook.js")}` };

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
 * start-up key migration, which expects a host restart the harness never performs. Null every key the
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
  // The settings table stores password and API key as typed (protectedNative, no encryptedAttributes) —
  // the fixture rows go in the same way.
  await harness.changeAdapterConfig(ADAPTER, { native: { ...stale, ...FIXTURE_NATIVE } });
}

tests.integration(ADAPTER_DIR, {
  controllerVersion: "stable",
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      let watch;
      before(async function () {
        this.timeout(120000);
        harness = getHarness();
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness);
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        await harness.startAdapterAndWait(false, ADAPTER_ENV);
        await feedFixtures(harness);
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
        const churn = [...watch.writes].filter(([, n]) => n > MAX_OBJECT_WRITES).map(([id, n]) => `${id} ×${n}`);
        assert.deepStrictEqual(churn, [], `objects written more than ${MAX_OBJECT_WRITES} times in one start`);
      });

      it("rewrites no object unchanged", function () {
        const idle = [...new Set(watch.unchanged)];
        assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
      });
    });

    // The same run once more in a second system language: a label that stays the same in both was never
    // translated. A suite of its own — the harness starts an adapter only once per suite (a second
    // startAdapterAndWait in the same suite never resolves), and every suite gets a fresh database.
    suite("second system language", getHarness => {
      let harness;
      before(async function () {
        this.timeout(120000);
        harness = getHarness();
        await resetInstanceNative(harness);
        await setSystemLanguage(harness, SECOND_LANGUAGE);
        await harness.startAdapterAndWait(false, ADAPTER_ENV);
        await feedFixtures(harness);
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
        let verdictAt;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(120000);
          harness = getHarness();
          watch = await watchObjectWrites(harness);
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          for (const [id, obj] of Object.entries(previous)) {
            await harness.objects.setObjectAsync(id, obj);
          }
          await resetInstanceNative(harness);
          // The inventory was written in FIRST_LANGUAGE: labels an adapter localises itself (`states`)
          // only compare in the same language.
          await setSystemLanguage(harness, FIRST_LANGUAGE);
          await harness.startAdapterAndWait(false, ADAPTER_ENV);
          await feedFixtures(harness);
          // The seeded set makes feedFixtures a no-op here — this is the real wait.
          await waitForAdapterWork(harness);
          verdictAt = Date.now();
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

        // A kept object that is deleted and created anew makes the suite judge a fresh object, not the
        // upgraded one (hassemu v1.43.1: the stale cleanup removed 18 seeded clients before the dump).
        it("deletes no object the release keeps", function () {
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const lost = [...new Set(watch.deleted)].filter(id => id in previous && id in current);
          assert.deepStrictEqual(lost, [], `kept objects deleted during the upgrade:\n${lost.join("\n")}`);
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
