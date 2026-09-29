vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
    translate: vi.fn((key: string) => `label:${key}`),
  },
}));

import { FakeAdapter } from "../../../test/helpers/fake-adapter";
import type { Capability, DownloadItem, ExtraDefinition, ProgramSnapshot } from "./model";
import { KnownObjects } from "./objects";
import { ProgramTree, type TreeOptions } from "./tree";
import { KnownStates } from "./states";

const NS = "dl-manager.0";
const CAPS: Capability[] = ["itemPause", "itemRemove", "upload", "itemSpeed", "itemEta", "globalPause", "add"];
const driver = (
  caps: Capability[] = CAPS,
  extras: ExtraDefinition[] = [],
): {
  type: string;
  capabilities: ReadonlySet<Capability>;
  extras: readonly ExtraDefinition[];
} => ({ type: "qbittorrent", capabilities: new Set(caps), extras });

const item = (key: string, over: Partial<DownloadItem> = {}): DownloadItem => ({
  key,
  name: `name ${key}`,
  status: "downloading",
  sizeBytes: 1e9,
  doneBytes: 5e8,
  speedBps: 1e6,
  etaSeconds: 500,
  error: "",
  ...over,
});

const snap = (items: DownloadItem[], complete = true): ProgramSnapshot => ({
  status: { version: "5.2.3", paused: false, downloadBps: 1e6, uploadBps: 2e5 },
  items,
  complete,
});

async function makeTree(
  a: FakeAdapter,
  opts: TreeOptions = { scope: "all", limit: 0 },
  caps = CAPS,
): Promise<ProgramTree> {
  const t = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(caps), opts);
  await t.load();
  await t.ensureDevice(undefined);
  return t;
}

/**
 * The tree the way the adapter wires it: state writes through the adapter's state store, which forgets what a
 * delete removed.
 *
 * @param a the database stand-in
 * @returns the tree's adapter and the store
 */
function storeBacked(a: FakeAdapter): { tree: FakeAdapter; states: KnownStates } {
  const states = new KnownStates(a);
  const tree = Object.assign(Object.create(a) as FakeAdapter, {
    setState: (id: string, st: ioBroker.SettableState) => states.set(id, st),
    setStateChanged: (id: string, st: ioBroker.SettableState) => states.put(id, st),
    delObject: async (id: string, opts?: { recursive?: boolean }) => {
      await a.delObject(id, opts);
      states.remove(id, { recursive: opts?.recursive === true });
    },
  });
  return { tree, states };
}

const ALL: TreeOptions = { scope: "all", limit: 0 };
const DEV = `${NS}.qbittorrent-nas`;
const CH = `${DEV}.downloads.11112222`;

describe("ProgramTree — device", () => {
  it("creates the device with the online indicator, marked offline and Unknown", async () => {
    const a = new FakeAdapter(NS);
    await makeTree(a);
    const dev = a.objects.get(DEV);
    expect(dev?.type).toBe("device");
    expect(dev?.common.statusStates).toEqual({ onlineId: `${DEV}.online` });
    expect(a.val("qbittorrent-nas.online")).toBe(false);
    expect(a.val("qbittorrent-nas.error")).toBe("Unknown");
    expect(a.objects.get(`${DEV}.downloads`)?.type).toBe("folder");
  });

  it("creates program datapoints only for capabilities the driver has", async () => {
    const a = new FakeAdapter(NS);
    await makeTree(a, ALL, ["itemPause"]);
    expect(a.objects.has(`${DEV}.downloadSpeed`)).toBe(true);
    expect(a.objects.has(`${DEV}.uploadSpeed`)).toBe(false);
    expect(a.objects.has(`${DEV}.add`)).toBe(false);
    expect(a.objects.has(`${DEV}.paused`)).toBe(false);
  });

  it("writes program values from the snapshot and marks it online", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222"), item("q1", { status: "queued" })]));
    expect(a.val("qbittorrent-nas.online")).toBe(true);
    expect(a.val("qbittorrent-nas.error")).toBe("");
    expect(a.val("qbittorrent-nas.downloadSpeed")).toBe(1);
    expect(a.val("qbittorrent-nas.uploadSpeed")).toBe(0.2);
    expect(a.val("qbittorrent-nas.active")).toBe(1);
    expect(a.val("qbittorrent-nas.queued")).toBe(1);
    expect(a.val("qbittorrent-nas.total")).toBe(2);
    expect(a.val("qbittorrent-nas.downloading")).toBe(true);
    expect(a.val("qbittorrent-nas.version")).toBe("5.2.3");
  });

  it("markOffline sets online false and the reason", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([]));
    await t.markOffline("fetch failed (ECONNREFUSED)");
    expect(a.val("qbittorrent-nas.online")).toBe(false);
    expect(a.val("qbittorrent-nas.error")).toBe("fetch failed (ECONNREFUSED)");
  });

  it("shows a row that cannot run as a bare device with its problem", async () => {
    const a = new FakeAdapter(NS);
    const t = new ProgramTree(a, "emule-x", "eMule", { type: "emule", capabilities: new Set(), extras: [] }, ALL);
    await t.ensureBareDevice("unknown program type: emule");
    const ids = [...a.objects.keys()].filter(k => k.startsWith(`${NS}.emule-x`)).sort();
    expect(ids).toEqual([`${NS}.emule-x`, `${NS}.emule-x.error`, `${NS}.emule-x.online`]);
    expect(a.val("emule-x.online")).toBe(false);
    expect(a.val("emule-x.error")).toBe("unknown program type: emule");
  });

  it("stores the program address on the device", async () => {
    const a = new FakeAdapter(NS);
    const t = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(), ALL);
    await t.load();
    await t.ensureDevice(undefined, "http://10.0.0.2:8080");
    expect(a.objects.get(DEV)?.native).toMatchObject({ type: "qbittorrent", address: "http://10.0.0.2:8080" });
  });

  it("finds the raw key of a download channel, also after a restart", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    expect(t.itemKey("11112222")).toBe("aaaa11112222");
    expect(t.itemKey("nothing")).toBeUndefined();
    const t2 = await makeTree(a);
    expect(t2.itemKey("11112222")).toBe("aaaa11112222");
  });
});

describe("ProgramTree — downloads", () => {
  it("creates a channel named after the download with the capability datapoints only", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    const ch = a.objects.get(CH);
    expect(ch?.type).toBe("channel");
    expect(ch?.common.name).toBe("name aaaa11112222");
    expect(ch?.native).toMatchObject({ key: "aaaa11112222", nameSource: "api" });
    expect(a.objects.has(`${CH}.uploadSpeed`)).toBe(true);
    expect(a.objects.has(`${CH}.category`)).toBe(false);
    expect(a.val("qbittorrent-nas.downloads.11112222.progress")).toBe(50);
    expect(a.val("qbittorrent-nas.downloads.11112222.size")).toBe(1);
    expect(a.val("qbittorrent-nas.downloads.11112222.speed")).toBe(1);
    expect(a.val("qbittorrent-nas.downloads.11112222.eta")).toBe(500);
    expect(a.val("qbittorrent-nas.downloads.11112222.status")).toBe("downloading");
    expect(a.val("qbittorrent-nas.downloads.11112222.paused")).toBe(false);
  });

  it("gives status labels as plain strings in the system language, never equal to the key", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    const states = a.objects.get(`${CH}.status`)?.common.states as Record<string, string>;
    expect(Object.keys(states)).toHaveLength(9);
    for (const [k, v] of Object.entries(states)) {
      expect(typeof v).toBe("string");
      expect(v).not.toBe(k);
    }
    expect(a.objects.get(`${CH}.status`)?.common.role).toBe("text");
  });

  it("writes no object on an identical second poll, even with 2000 downloads", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    const many = Array.from({ length: 2000 }, (_, i) => item(`k${String(i).padStart(12, "0")}`));
    await t.sync(snap(many));
    a.objectWrites = 0;
    await t.sync(snap(many));
    expect(a.objectWrites).toBe(0);
  });

  it("reads nothing from the database on an identical second poll — through the adapter's state store", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(storeBacked(a).tree);
    const many = Array.from({ length: 2000 }, (_, i) => item(`k${String(i).padStart(12, "0")}`));
    await t.sync(snap(many));
    a.stateWrites = 0;
    await t.sync(snap(many));
    expect(a.stateWrites).toBe(0);
    expect(a.changedChecks).toBe(0);
  });

  it("writes online again after markOffline, and a value the user wrote again", async () => {
    const a = new FakeAdapter(NS);
    const { tree, states } = storeBacked(a);
    const t = await makeTree(tree);
    await t.sync(snap([item("aaaa11112222")]));
    await t.markOffline("timeout");
    await t.sync(snap([item("aaaa11112222")]));
    expect(a.val("qbittorrent-nas.online")).toBe(true);
    expect(a.val("qbittorrent-nas.error")).toBe("");
    await a.setState("qbittorrent-nas.downloads.11112222.paused", { val: true, ack: false });
    states.forget(`${CH}.paused`);
    await t.sync(snap([item("aaaa11112222")]));
    expect(a.states.get(`${CH}.paused`)).toMatchObject({ val: false, ack: true });
  });

  it("writes every value of a download that comes back — through the adapter's state store (review R1)", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(storeBacked(a).tree);
    await t.sync(snap([item("aaaa11112222")]));
    await t.sync(snap([]));
    expect(a.states.has(`${CH}.status`)).toBe(false);
    await t.sync(snap([item("aaaa11112222")]));
    expect(a.states.get(`${CH}.status`)).toMatchObject({ val: "downloading", ack: true });
    expect(a.states.get(`${CH}.size`)?.val).not.toBeUndefined();
  });

  it("writes every value of a download that comes back after it was removed", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    await t.sync(snap([]));
    await t.sync(snap([item("aaaa11112222")]));
    expect(a.val("qbittorrent-nas.downloads.11112222.progress")).toBe(50);
  });

  it("writes no object for known channels after a restart either (writes go through KnownObjects, as in the adapter)", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    const known = new KnownObjects(a);
    await known.load();
    const writes = {
      ...a,
      namespace: NS,
      log: a.log,
      extendObject: (id: string, obj: ioBroker.PartialObject) => known.extend(id, obj),
      setForeignObject: (id: string, obj: ioBroker.SettableObject) => known.replace(id, obj),
      delObject: (id: string, o: { recursive: boolean }) => known.remove(id, o),
      getObject: (id: string) => a.getObject(id),
      getForeignObjects: (p: string, ty: ioBroker.ObjectType) => a.getForeignObjects(p, ty),
      getState: (id: string) => a.getState(id),
      setState: (id: string, s: ioBroker.SettableState) => a.setState(id, s),
      setStateChanged: (id: string, s: ioBroker.SettableState) => a.setStateChanged(id, s),
    };
    const again = new ProgramTree(writes, "qbittorrent-nas", "qBittorrent (NAS)", driver(), ALL);
    await again.load();
    a.objectWrites = 0;
    await again.ensureDevice(undefined);
    await again.sync(snap([item("aaaa11112222")]));
    expect(a.objectWrites).toBe(0);
  });

  it("brings a known channel's datapoints to the current texts once after a restart", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    const stale = a.objects.get(`${CH}.progress`);
    if (stale) {
      stale.common.name = "old name";
    }
    const again = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(), ALL);
    await again.load();
    await again.sync(snap([item("aaaa11112222")]));
    expect(a.objects.get(`${CH}.progress`)?.common.name).toEqual({ en: "progress", de: "progress_de" });
    a.objectWrites = 0;
    await again.sync(snap([item("aaaa11112222")]));
    expect(a.objectWrites).toBe(0);
  });

  it("renames the channel when the program renames the download", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    await t.sync(snap([item("aaaa11112222", { name: "renamed" })]));
    expect(a.objects.get(CH)?.common.name).toBe("renamed");
  });

  it("removes nothing when the poll was incomplete", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    await t.sync(snap([], false));
    expect(a.objects.has(CH)).toBe(true);
  });

  it("removes a channel with its datapoints when the program no longer lists it", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    await t.sync(snap([]));
    expect(a.objects.has(CH)).toBe(false);
    expect(a.objects.has(`${CH}.status`)).toBe(false);
  });

  it("removes a channel the program dropped while the adapter was stopped", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    const again = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(), ALL);
    await again.load();
    await again.sync(snap([]));
    expect(a.objects.has(CH)).toBe(false);
  });

  it("writes no value without its datapoint — a driver without any capability", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, ALL, []);
    const full = item("aaaa11112222", {
      uploadBps: 1,
      ratio: 1,
      addedMs: 1,
      finishedMs: 2,
      category: "tv",
      error: "x",
      extra: { forceStart: true },
    });
    await t.sync({
      status: {
        version: "1",
        paused: true,
        downloadBps: 1,
        uploadBps: 1,
        speedLimitBps: 1,
        uploadLimitBps: 1,
        altSpeed: true,
        freeSpaceBytes: 1,
        extra: { x: 1 },
      },
      items: [full],
      complete: true,
    });
    expect(a.orphanWrites).toEqual([]);
  });

  it("writes no value without its datapoint — a driver with every capability", async () => {
    const a = new FakeAdapter(NS);
    const all: Capability[] = [
      "globalPause",
      "itemPause",
      "itemRemove",
      "add",
      "speedLimit",
      "upload",
      "uploadLimit",
      "altSpeed",
      "freeSpace",
      "itemSpeed",
      "itemEta",
      "itemAdded",
      "itemFinished",
      "category",
      "itemError",
    ];
    const t = await makeTree(a, ALL, all);
    await t.sync(snap([item("aaaa11112222", { ratio: 2, category: "tv" })]));
    expect(a.orphanWrites).toEqual([]);
  });

  it("writes no value for an extra the download does not carry", async () => {
    const a = new FakeAdapter(NS);
    const extras: ExtraDefinition[] = [
      { id: "recheck", level: "item", type: "boolean", role: "button", write: true, read: false, nameKey: "recheck" },
    ];
    const t = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(CAPS, extras), ALL);
    await t.load();
    await t.ensureDevice(undefined);
    await t.sync(snap([item("aaaa11112222")]));
    expect(a.states.has(`${CH}.recheck`)).toBe(false);
  });

  it("gives buttons (datapoint and extra) the default false", async () => {
    const a = new FakeAdapter(NS);
    const extras: ExtraDefinition[] = [
      { id: "recheck", level: "item", type: "boolean", role: "button", write: true, read: false, nameKey: "recheck" },
    ];
    const t = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver([...CAPS, "itemRemove"], extras), ALL);
    await t.load();
    await t.ensureDevice(undefined);
    await t.sync(snap([item("aaaa11112222")]));
    expect(a.objects.get(`${CH}.remove`)?.common.def).toBe(false);
    expect(a.objects.get(`${CH}.recheck`)?.common.def).toBe(false);
  });

  it("mirrors the status into the download's paused switch", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222", { status: "paused" })]));
    expect(a.val("qbittorrent-nas.downloads.11112222.paused")).toBe(true);
  });

  it("writes an unknown ratio as null", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    expect(a.val("qbittorrent-nas.downloads.11112222.ratio")).toBeNull();
  });

  it("counts post-processing as downloading and an unknown alternative speed as off", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, ALL, [...CAPS, "altSpeed"]);
    await t.sync(snap([item("aaaa11112222", { status: "postprocessing" })]));
    expect(a.val("qbittorrent-nas.downloading")).toBe(true);
    expect(a.val("qbittorrent-nas.altSpeed")).toBe(false);
  });

  it("rebuilds the channels when the driver's datapoint set grew", async () => {
    const a = new FakeAdapter(NS);
    const small = await makeTree(a, ALL, []);
    await small.sync(snap([item("aaaa11112222")]));
    expect(a.objects.has(`${CH}.speed`)).toBe(false);
    const big = await makeTree(a);
    await big.sync(snap([item("aaaa11112222")]));
    expect(a.objects.has(`${CH}.speed`)).toBe(true);
  });

  it("ignores a channel below downloads that carries no key", async () => {
    const a = new FakeAdapter(NS);
    await a.extendObject(`${DEV}.downloads.foreign`, { type: "channel", common: { name: "x" }, native: {} });
    const t = await makeTree(a);
    await expect(t.sync(snap([item("aaaa11112222")]))).resolves.toBeDefined();
    expect(a.objects.has(`${DEV}.downloads.foreign`)).toBe(true);
  });

  it("creates item extras declared by the driver and writes their values", async () => {
    const a = new FakeAdapter(NS);
    const extras: ExtraDefinition[] = [
      { id: "recheck", level: "item", type: "boolean", role: "button", write: true, read: false, nameKey: "recheck" },
    ];
    const t = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(CAPS, extras), ALL);
    await t.load();
    await t.ensureDevice(undefined);
    await t.sync(snap([item("aaaa11112222")]));
    expect(a.objects.get(`${CH}.recheck`)?.common.role).toBe("button");
  });
});

describe("ProgramTree — keys the 0.0.1 placeholder left on its objects", () => {
  it("nulls the device's removed list and every channel's signature once, and adds neither to a fresh tree", async () => {
    const a = new FakeAdapter(NS);
    await a.extendObject(DEV, {
      type: "device",
      common: { name: "x" },
      native: { type: "qbittorrent", removed: ["k"] },
    });
    await a.extendObject(CH, {
      type: "channel",
      common: { name: "name aaaa11112222" },
      native: { key: "aaaa11112222", sig: "status" },
    });
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    expect(a.objects.get(DEV)?.native.removed).toBeNull();
    expect(a.objects.get(CH)?.native.sig).toBeNull();
    const fresh = new FakeAdapter(NS);
    const f = await makeTree(fresh);
    await f.sync(snap([item("aaaa11112222")]));
    expect("removed" in (fresh.objects.get(DEV)?.native ?? {})).toBe(false);
    expect("sig" in (fresh.objects.get(CH)?.native ?? {})).toBe(false);
  });
});

describe("ProgramTree — finished and failed events", () => {
  it("fires finished on the transition, not on the startup baseline", async () => {
    const a = new FakeAdapter(NS);
    a.states.set(`${DEV}.lastFinishedTime`, { val: 5000, ack: true } as ioBroker.State);
    const t = await makeTree(a);
    const e1 = await t.sync(snap([item("k1", { status: "completed", finishedMs: 1000 })]));
    expect(e1.finished).toHaveLength(0);
    const e2 = await t.sync(snap([item("k1", { status: "completed", finishedMs: 1000 }), item("k2")]));
    const e3 = await t.sync(
      snap([item("k1", { status: "completed", finishedMs: 1000 }), item("k2", { status: "seeding" })]),
    );
    expect(e2.finished).toHaveLength(0);
    expect(e3.finished.map(i => i.key)).toEqual(["k2"]);
    expect(a.val("qbittorrent-nas.lastFinished")).toBe("name k2");
  });

  it("catches a download that finished while the adapter was stopped", async () => {
    const a = new FakeAdapter(NS);
    a.states.set(`${DEV}.lastFinishedTime`, { val: 5000, ack: true } as ioBroker.State);
    const t = await makeTree(a);
    const e = await t.sync(snap([item("k1", { status: "completed", finishedMs: 9000 })]));
    expect(e.finished.map(i => i.key)).toEqual(["k1"]);
  });

  it("fires nothing on the very first start (no recorded finish yet)", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    const e = await t.sync(snap([item("k1", { status: "completed", finishedMs: 9000 })]));
    expect(e.finished).toHaveLength(0);
  });

  it("fires failed on the transition and writes lastFailed", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("k1")]));
    const e = await t.sync(snap([item("k1", { status: "failed", error: "404" })]));
    expect(e.failed.map(i => i.key)).toEqual(["k1"]);
    expect(a.val("qbittorrent-nas.lastFailed")).toBe("name k1");
    expect(typeof a.val("qbittorrent-nas.lastFailedTime")).toBe("number");
  });

  it("does not repeat the recorded finish after a restart", async () => {
    const a = new FakeAdapter(NS);
    a.states.set(`${DEV}.lastFinishedTime`, { val: 5000, ack: true } as ioBroker.State);
    const t = await makeTree(a);
    const e = await t.sync(snap([item("k1", { status: "completed", finishedMs: 5000 })]));
    expect(e.finished).toHaveLength(0);
  });

  it("reports no old failure on the first poll and a lasting failure only once", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    const e1 = await t.sync(snap([item("k1", { status: "failed", error: "x" })]));
    expect(e1.failed).toHaveLength(0);
    await t.sync(snap([item("k1", { status: "failed", error: "x" }), item("k2")]));
    const e2 = await t.sync(snap([item("k1", { status: "failed", error: "x" }), item("k2", { status: "failed" })]));
    const e3 = await t.sync(snap([item("k1", { status: "failed", error: "x" }), item("k2", { status: "failed" })]));
    expect(e2.failed.map(i => i.key)).toEqual(["k2"]);
    expect(e3.failed).toHaveLength(0);
  });

  it("does not report a second finish when seeding ends", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("k1")]));
    await t.sync(snap([item("k1", { status: "seeding" })]));
    const e = await t.sync(snap([item("k1", { status: "completed" })]));
    expect(e.finished).toHaveLength(0);
  });

  it("takes the last of several finishes and failures of one poll", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("k1"), item("k2"), item("k3"), item("k4")]));
    await t.sync(
      snap([
        item("k1", { status: "completed", finishedMs: 1000 }),
        item("k2", { status: "completed", finishedMs: 2000 }),
        item("k3", { status: "failed" }),
        item("k4", { status: "failed" }),
      ]),
    );
    expect(a.val("qbittorrent-nas.lastFinished")).toBe("name k2");
    expect(a.val("qbittorrent-nas.lastFinishedTime")).toBe(2000);
    expect(a.val("qbittorrent-nas.lastFailed")).toBe("name k4");
  });

  it("counts a download that appears already finished after the baseline", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([]));
    const e = await t.sync(snap([item("k9", { status: "completed" })]));
    expect(e.finished.map(i => i.key)).toEqual(["k9"]);
  });

  it("writes lastFinished again for the same name (an update event for Blockly)", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("k1")]));
    await t.sync(snap([item("k1", { status: "completed" })]));
    const writes = a.stateWrites;
    await t.sync(snap([item("k1", { status: "downloading" })]));
    await t.sync(snap([item("k1", { status: "completed" })]));
    expect(a.stateWrites).toBeGreaterThan(writes);
    expect(a.val("qbittorrent-nas.lastFinished")).toBe("name k1");
  });
});

const at = (key: string, status: DownloadItem["status"], addedMs?: number, finishedMs?: number): DownloadItem =>
  item(key, {
    status,
    ...(addedMs === undefined ? {} : { addedMs }),
    ...(finishedMs === undefined ? {} : { finishedMs }),
  });
const shownKeys = (a: FakeAdapter): string[] =>
  [...a.objects.values()]
    .filter(o => o.type === "channel")
    .map(o => String(o.native.key))
    .sort();

describe("ProgramTree — which downloads the tree shows (scope)", () => {
  it("shows every download with the scope all", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, ALL);
    await t.sync(snap([at("c1", "completed"), at("s1", "seeding"), at("f1", "failed"), at("d1", "downloading")]));
    expect(shownKeys(a)).toEqual(["c1", "d1", "f1", "s1"]);
  });

  it("leaves completed downloads out without completed, keeps seeding and failed", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { scope: "withoutCompleted", limit: 0 });
    await t.sync(snap([at("c1", "downloading"), at("s1", "downloading"), at("f1", "downloading")]));
    const e = await t.sync(snap([at("c1", "completed"), at("s1", "seeding"), at("f1", "failed")]));
    expect(e.finished.map(i => i.key)).toEqual(["c1", "s1"]);
    expect(e.removedFromTree).toBe(1);
    expect(shownKeys(a)).toEqual(["f1", "s1"]);
  });

  it("brings a download back when it leaves the completed status again", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { scope: "withoutCompleted", limit: 0 });
    await t.sync(snap([at("c1", "completed")]));
    expect(shownKeys(a)).toEqual([]);
    await t.sync(snap([at("c1", "seeding")]));
    expect(shownKeys(a)).toEqual(["c1"]);
  });

  it("shows only unfinished and failed downloads with the scope unfinished", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { scope: "unfinished", limit: 0 });
    await t.sync(
      snap([
        at("c1", "completed"),
        at("s1", "seeding"),
        at("f1", "failed"),
        at("q1", "queued"),
        at("p1", "paused"),
        at("w1", "waiting"),
        at("k1", "checking"),
        at("x1", "postprocessing"),
        at("d1", "downloading"),
      ]),
    );
    expect(shownKeys(a)).toEqual(["d1", "f1", "k1", "p1", "q1", "w1", "x1"]);
  });

  it("takes out channels that existed before the scope was narrowed, and counts them", async () => {
    const a = new FakeAdapter(NS);
    const wide = await makeTree(a, ALL);
    await wide.sync(snap([at("c1", "completed"), at("s1", "seeding"), at("d1", "downloading")]));
    const narrow = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(), {
      scope: "unfinished",
      limit: 0,
    });
    await narrow.load();
    const e = await narrow.sync(snap([at("c1", "completed"), at("s1", "seeding"), at("d1", "downloading")]));
    expect(e.removedFromTree).toBe(2);
    expect(shownKeys(a)).toEqual(["d1"]);
    const again = await narrow.sync(snap([at("c1", "completed"), at("s1", "seeding"), at("d1", "downloading")]));
    expect(again.removedFromTree).toBe(0);
  });
});

describe("ProgramTree — how many downloads the tree shows (limit)", () => {
  it("keeps the running, the failed and the newest seeding ones when there are more than the limit", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { scope: "all", limit: 5 });
    const seeds = Array.from({ length: 30 }, (_, n) =>
      at(`s${String(n).padStart(2, "0")}`, "seeding", 1000 + n, 5000 + n),
    );
    await t.sync(snap([...seeds, at("d1", "downloading", 10), at("d2", "downloading", 11), at("f1", "failed", 12)]));
    expect(shownKeys(a)).toEqual(["d1", "d2", "f1", "s28", "s29"]);
  });

  it("ranks running, failed, paused and waiting, queued, seeding, completed — the newest first within a rank", async () => {
    const items = [
      at("c1", "completed", 1, 99),
      at("s1", "seeding", 1, 50),
      at("q1", "queued", 5),
      at("q2", "queued", 6),
      at("w1", "waiting", 1),
      at("p1", "paused", 2),
      at("f1", "failed", 1),
      at("x1", "postprocessing", 1),
      at("k1", "checking", 2),
      at("d1", "downloading", 3),
    ];
    const expectations: [number, string[]][] = [
      [3, ["d1", "k1", "x1"]],
      [4, ["d1", "f1", "k1", "x1"]],
      [6, ["d1", "f1", "k1", "p1", "w1", "x1"]],
      [7, ["d1", "f1", "k1", "p1", "q2", "w1", "x1"]],
      [9, ["d1", "f1", "k1", "p1", "q1", "q2", "s1", "w1", "x1"]],
    ];
    for (const [limit, keys] of expectations) {
      const store = new FakeAdapter(NS);
      const t = await makeTree(store, { scope: "all", limit });
      await t.sync(snap(items));
      expect(shownKeys(store), `limit ${limit}`).toEqual(keys);
    }
  });

  it("orders finished downloads by when they finished, and keeps the program order where no time is known", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { scope: "all", limit: 2 });
    await t.sync(snap([at("c1", "completed", 900, 10), at("c2", "completed", 1, 20), at("c3", "completed")]));
    expect(shownKeys(a)).toEqual(["c1", "c2"]);
    const one = new FakeAdapter(NS);
    const single = await makeTree(one, { scope: "all", limit: 1 });
    await single.sync(snap([at("c1", "completed", 900, 10), at("c2", "completed", 1, 20)]));
    expect(shownKeys(one)).toEqual(["c2"]);
    const b = new FakeAdapter(NS);
    const u = await makeTree(b, { scope: "all", limit: 2 });
    await u.sync(snap([at("q3", "queued"), at("q1", "queued"), at("q2", "queued")]));
    expect(shownKeys(b)).toEqual(["q1", "q3"]);
  });

  it("gives a dropped download its channel back once there is room again", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { scope: "all", limit: 2 });
    await t.sync(snap([at("d1", "downloading", 3), at("d2", "downloading", 2), at("d3", "downloading", 1)]));
    expect(shownKeys(a)).toEqual(["d1", "d2"]);
    await t.sync(snap([at("d2", "downloading", 2), at("d3", "downloading", 1)]));
    expect(shownKeys(a)).toEqual(["d2", "d3"]);
  });

  it("drops the lower-ranked channel when a higher-ranked download arrives", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { scope: "all", limit: 1 });
    await t.sync(snap([at("s1", "seeding", 1, 2)]));
    const e = await t.sync(snap([at("s1", "seeding", 1, 2), at("d1", "downloading", 3)]));
    expect(e.removedFromTree).toBe(1);
    expect(shownKeys(a)).toEqual(["d1"]);
  });

  it("applies the scope before the limit", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { scope: "unfinished", limit: 2 });
    await t.sync(
      snap([at("s1", "seeding", 9, 9), at("q1", "queued", 1), at("q2", "queued", 2), at("q3", "queued", 3)]),
    );
    expect(shownKeys(a)).toEqual(["q2", "q3"]);
  });

  it("shows every download with the limit 0", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, ALL);
    await t.sync(snap(Array.from({ length: 12 }, (_, n) => at(`k${n}`, "seeding", n))));
    expect(shownKeys(a)).toHaveLength(12);
  });
});

describe("ProgramTree — the warning about many downloads", () => {
  const many = (n: number): ProgramSnapshot => snap(Array.from({ length: n }, (_, k) => at(`k${k}`, "seeding", k)));

  it("warns once when more than 200 downloads stand in the tree without a limit", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, ALL, []);
    await t.sync(many(201));
    await t.sync(many(202));
    const warns = a.logs.filter(l => l.level === "warn");
    expect(warns.map(l => l.msg)).toEqual([
      "qBittorrent (NAS): 201 downloads in the object tree — this many can slow ioBroker down; limit them in the adapter settings (100 or fewer recommended)",
    ]);
  });

  it("warns with a limit above 200 as well", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { scope: "all", limit: 300 }, []);
    await t.sync(many(250));
    expect(a.logs.filter(l => l.level === "warn")).toHaveLength(1);
  });

  it("stays quiet at 200 downloads and below, and with a limit of 200 or less", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, ALL, []);
    await t.sync(many(200));
    const b = new FakeAdapter(NS);
    const u = await makeTree(b, { scope: "all", limit: 200 }, []);
    await u.sync(many(400));
    expect([...a.logs, ...b.logs].filter(l => l.level === "warn")).toEqual([]);
  });
});

describe("ProgramTree — datapoints follow the capabilities", () => {
  const ITEM_BOUND = [
    "speed",
    "uploadSpeed",
    "ratio",
    "eta",
    "added",
    "finished",
    "category",
    "error",
    "paused",
    "remove",
  ];
  const PROGRAM_BOUND = ["paused", "uploadSpeed", "speedLimit", "uploadLimit", "altSpeed", "freeSpace", "add"];
  const ALL_CAPS: Capability[] = [
    "itemSpeed",
    "upload",
    "itemEta",
    "itemAdded",
    "itemFinished",
    "category",
    "itemError",
    "itemPause",
    "itemRemove",
    "globalPause",
    "speedLimit",
    "uploadLimit",
    "altSpeed",
    "freeSpace",
    "add",
  ];

  it("creates none of the capability-bound datapoints for a program without capabilities", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, ALL, []);
    await t.sync(snap([item("aaaa11112222")]));
    expect(ITEM_BOUND.filter(dp => a.objects.has(`${CH}.${dp}`))).toEqual([]);
    expect(PROGRAM_BOUND.filter(dp => a.objects.has(`${DEV}.${dp}`))).toEqual([]);
  });

  it("creates every one of them for a program that has them all", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, ALL, ALL_CAPS);
    await t.sync(snap([item("aaaa11112222")]));
    expect(ITEM_BOUND.filter(dp => !a.objects.has(`${CH}.${dp}`))).toEqual([]);
    expect(PROGRAM_BOUND.filter(dp => !a.objects.has(`${DEV}.${dp}`))).toEqual([]);
  });
});
