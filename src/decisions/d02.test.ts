// Core decision D-02 (accepted 2026-10-22): all download programs run in the same dl-manager instance, each one a device
// (not one adapter per downloader — see D-01); every download is its own channel with typed single datapoints (status,
// progress, speed …) usable in Blockly, never a JSON list instead of that subtree. krobi 2026-09-28 21:11, asked "one
// instance with all programs? downloads as sums plus a JSON list instead of a subtree per download?": "yes, what else?
// one adapter = one instance! of course. what is a user supposed to do with a JSON list???" · 2026-10-22 22:51: "one
// adapter = one instance means here that we run several downloaders in one adapter instance" — "and not build 10
// adapters with one downloader each".
import { describe, expect, it, vi } from "vitest";
import { ProgramManager, type ManagerAdapter } from "../lib/core/manager";
import type { DownloadItem, ProgramDriver, ProgramEntry, Status } from "../lib/core/model";
import { ProgramTree } from "../lib/core/tree";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

/** The object and state store of an instance, in memory — this guard's own copy (a guard imports no test code). */
class Memory implements ManagerAdapter {
  readonly namespace = "dl-manager.0";
  readonly objects = new Map<string, ioBroker.Object>();
  readonly states = new Map<string, ioBroker.StateValue>();
  readonly log = { debug: () => undefined, info: () => undefined, warn: () => undefined };
  private full(id: string): string {
    return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
  }
  extendObject(id: string, obj: ioBroker.PartialObject): Promise<void> {
    const old = (this.objects.get(this.full(id)) ?? {}) as Record<string, unknown>;
    const patch = structuredClone(obj) as Record<string, unknown>;
    this.objects.set(this.full(id), {
      ...old,
      ...patch,
      common: { ...(old.common as object), ...(patch.common as object) },
      native: { ...(old.native as object), ...(patch.native as object) },
    } as unknown as ioBroker.Object);
    return Promise.resolve();
  }
  delObject(): Promise<void> {
    return Promise.resolve();
  }
  knownObject(id: string): unknown {
    return this.objects.get(this.full(id));
  }
  getForeignObjects(): Promise<Record<string, ioBroker.Object>> {
    return Promise.resolve({});
  }
  knownValue(id: string): ioBroker.StateValue | undefined {
    return this.states.get(this.full(id));
  }
  setState(id: string, state: ioBroker.SettableState): Promise<void> {
    this.states.set(this.full(id), state.val ?? null);
    return Promise.resolve();
  }
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<void> {
    return this.setState(id, state);
  }
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null> {
    return Promise.resolve(structuredClone(this.objects.get(id) ?? null));
  }
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
    this.objects.set(id, obj as ioBroker.Object);
    return Promise.resolve();
  }
}

const item = (key: string, status: Status): DownloadItem => ({
  key,
  name: `name-${key}`,
  status,
  sizeBytes: 200,
  doneBytes: 50,
  speedBps: 1_000_000,
  etaSeconds: null,
  finishedMs: null,
  error: "",
});

describe("D-02 all programs in one instance, every download a channel of single datapoints", () => {
  it("runs every program of the instance — several of the same kind too — as a device of that one instance", async () => {
    const a = new Memory();
    const polled: string[] = [];
    const driver = (type: string, id: string): ProgramDriver => ({
      type,
      capabilities: new Set(["globalPause", "add"]),
      extras: [],
      poll: () => {
        polled.push(id);
        return new Promise(() => undefined);
      },
      command: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
    const entry = (type: string): ProgramEntry => ({
      type,
      needs: [],
      create: cfg => driver(type, `${type}:${cfg.name}`),
    });
    const entries: Record<string, ProgramEntry> = {
      "jdownloader-cloud": entry("jdownloader-cloud"),
      qbittorrent: entry("qbittorrent"),
      transmission: entry("transmission"),
    };
    const manager = new ProgramManager(
      {
        adapter: a,
        timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
        find: type => entries[type],
        problems: { report: () => undefined, forget: () => undefined },
        moveDevice: () => Promise.resolve(),
      },
      { intervalMs: 10_000, scope: "all", limit: 100 },
    );
    await manager.start([
      {
        id: "jdownloader-2222",
        type: "jdownloader-cloud",
        name: "JD",
        username: "owner@example.com",
        password: "pw",
        device: "Office",
        deviceId: "bbbb2222",
      },
      { id: "qbittorrent-nas", type: "qbittorrent", name: "NAS", host: "nas", username: "u", password: "pw" },
      { id: "qbittorrent-pc", type: "qbittorrent", name: "PC", host: "pc", username: "u", password: "pw" },
      { id: "transmission-nas", type: "transmission", name: "TR", host: "nas", username: "u", password: "pw" },
    ]);
    const devices = [...a.objects].filter(([, o]) => o.type === "device").map(([id]) => id);
    expect(devices.sort()).toEqual([
      "dl-manager.0.jdownloader-2222",
      "dl-manager.0.qbittorrent-nas",
      "dl-manager.0.qbittorrent-pc",
      "dl-manager.0.transmission-nas",
    ]);
    expect([...new Set(polled)].sort()).toEqual([
      "jdownloader-cloud:JD",
      "qbittorrent:NAS",
      "qbittorrent:PC",
      "transmission:TR",
    ]);
  });

  it("gives every download its own channel with typed single datapoints, no JSON list anywhere", async () => {
    const a = new Memory();
    const tree = new ProgramTree(
      a,
      "qbittorrent-nas",
      "NAS",
      { type: "qbittorrent", capabilities: new Set(["itemSpeed"]), extras: [] },
      { scope: "all", limit: 0 },
    );
    await tree.load();
    await tree.ensureDevice(undefined, "http://nas:8080");
    await tree.sync({
      status: { version: "1", paused: false, downloadBps: 0 },
      items: [item("a", "downloading"), item("b", "queued")],
      complete: true,
    });
    const channels = [...a.objects]
      .filter(([id, o]) => id.startsWith("dl-manager.0.qbittorrent-nas.downloads.") && o.type === "channel")
      .map(([id]) => id);
    expect(channels).toHaveLength(2);
    for (const ch of channels) {
      const common = (dp: string): ioBroker.StateCommon | undefined =>
        (a.objects.get(`${ch}.${dp}`) as ioBroker.StateObject | undefined)?.common;
      expect(a.objects.get(`${ch}.status`)?.type, ch).toBe("state");
      expect(common("status")?.type, ch).toBe("string");
      expect(common("progress")?.type, ch).toBe("number");
      expect(common("speed")?.type, ch).toBe("number");
      expect(a.states.get(`${ch}.progress`), ch).toBe(25);
      expect(a.states.get(`${ch}.speed`), ch).toBe(1);
    }
    expect(channels.map(ch => a.states.get(`${ch}.status`)).sort()).toEqual(["downloading", "queued"]);
    for (const [id, o] of a.objects) {
      const common = o.common as Partial<ioBroker.StateCommon>;
      expect(["array", "object", "json"].includes(String(common.type)), id).toBe(false);
      expect(String(common.role ?? "").startsWith("json"), id).toBe(false);
    }
    for (const [id, v] of a.states) {
      expect(typeof v === "string" && /^\s*[[{]/.test(v), id).toBe(false);
    }
  });
});
