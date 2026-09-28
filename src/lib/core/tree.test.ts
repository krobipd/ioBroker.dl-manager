vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
    translate: vi.fn((key: string) => `label:${key}`),
  },
}));

import { FakeAdapter } from "../../../test/helpers/fake-adapter";
import type { Capability, DownloadItem, ExtraDefinition, ProgramSnapshot } from "./model";
import { ProgramTree } from "./tree";

const NS = "download-manager.0";
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

async function makeTree(a: FakeAdapter, opts = { removeFinished: false }, caps = CAPS): Promise<ProgramTree> {
  const t = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(caps), opts);
  await t.load();
  await t.ensureDevice(undefined);
  return t;
}

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
    await makeTree(a, { removeFinished: false }, ["itemPause"]);
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
    const t = new ProgramTree(
      a,
      "emule-x",
      "eMule",
      { type: "emule", capabilities: new Set(), extras: [] },
      {
        removeFinished: false,
      },
    );
    await t.ensureBareDevice("unknown program type: emule");
    const ids = [...a.objects.keys()].filter(k => k.startsWith(`${NS}.emule-x`)).sort();
    expect(ids).toEqual([`${NS}.emule-x`, `${NS}.emule-x.error`, `${NS}.emule-x.online`]);
    expect(a.val("emule-x.online")).toBe(false);
    expect(a.val("emule-x.error")).toBe("unknown program type: emule");
  });

  it("stores the program address on the device", async () => {
    const a = new FakeAdapter(NS);
    const t = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(), { removeFinished: false });
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

  it("writes no object for known channels after a restart either", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a);
    await t.sync(snap([item("aaaa11112222")]));
    const again = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(), { removeFinished: false });
    await again.load();
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
    const again = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(), { removeFinished: false });
    await again.load();
    await again.sync(snap([]));
    expect(a.objects.has(CH)).toBe(false);
  });

  it("creates item extras declared by the driver and writes their values", async () => {
    const a = new FakeAdapter(NS);
    const extras: ExtraDefinition[] = [
      { id: "recheck", level: "item", type: "boolean", role: "button", write: true, read: false, nameKey: "recheck" },
    ];
    const t = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(CAPS, extras), {
      removeFinished: false,
    });
    await t.load();
    await t.ensureDevice(undefined);
    await t.sync(snap([item("aaaa11112222")]));
    expect(a.objects.get(`${CH}.recheck`)?.common.role).toBe("button");
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

describe("ProgramTree — removeFinished option", () => {
  it("removes completed, keeps seeding and failed, never re-creates a removed one", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { removeFinished: true });
    await t.sync(snap([item("c1"), item("s1"), item("f1")]));
    const e = await t.sync(
      snap([
        item("c1", { status: "completed" }),
        item("s1", { status: "seeding" }),
        item("f1", { status: "failed", error: "x" }),
      ]),
    );
    expect(e.finished.map(i => i.key)).toEqual(["c1", "s1"]);
    expect(e.removedFromTree).toBe(1);
    expect(a.objects.has(`${DEV}.downloads.c1`)).toBe(false);
    expect(a.objects.has(`${DEV}.downloads.s1`)).toBe(true);
    expect(a.objects.has(`${DEV}.downloads.f1`)).toBe(true);
    await t.sync(snap([item("c1", { status: "completed" })]));
    expect(a.objects.has(`${DEV}.downloads.c1`)).toBe(false);
  });

  it("remembers removed downloads across a restart and forgets them once the program drops them", async () => {
    const a = new FakeAdapter(NS);
    const t = await makeTree(a, { removeFinished: true });
    await t.sync(snap([item("c1")]));
    await t.sync(snap([item("c1", { status: "completed" })]));
    const again = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(), { removeFinished: true });
    await again.load();
    await again.sync(snap([item("c1", { status: "completed" })]));
    expect(a.objects.has(`${DEV}.downloads.c1`)).toBe(false);
    await again.sync(snap([]));
    expect(a.objects.get(DEV)?.native.removed).toEqual([]);
  });

  it("clears the tree of completed downloads that already existed when the option was switched on", async () => {
    const a = new FakeAdapter(NS);
    const off = await makeTree(a);
    await off.sync(snap([item("c1", { status: "completed" }), item("d1")]));
    const on = new ProgramTree(a, "qbittorrent-nas", "qBittorrent (NAS)", driver(), { removeFinished: true });
    await on.load();
    const e = await on.sync(snap([item("c1", { status: "completed" }), item("d1")]));
    expect(e.removedFromTree).toBe(1);
    expect(a.objects.has(`${DEV}.downloads.c1`)).toBe(false);
    expect(a.objects.has(`${DEV}.downloads.d1`)).toBe(true);
  });
});
