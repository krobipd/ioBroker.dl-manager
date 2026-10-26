// Core decision D-09 (accepted 2026-10-22): the "last" values — last finished, when, last failed, when — stand in a
// channel `last` of their own, below every program and below the summary: last.finished, last.finishedTime, last.failed,
// last.failedTime. krobi 2026-09-29 22:46: "maybe put all these lasterror, lastfinish etc. into a subcategory" · 22:49 on
// the tree before/after: "about the tree, it is good like this".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROGRAM_DATAPOINTS } from "../lib/core/datapoints";
import type { DownloadItem, Status } from "../lib/core/model";
import { ProgramTree, type TreeAdapter } from "../lib/core/tree";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

const LAST = ["last.finished", "last.finishedTime", "last.failed", "last.failedTime"];

/** The object and state store of an instance, in memory — this guard's own copy (a guard imports no test code). */
class Memory implements TreeAdapter {
  readonly namespace = "dl-manager.0";
  readonly objects = new Map<string, ioBroker.Object>();
  readonly states = new Map<string, ioBroker.StateValue>();
  readonly log = { debug: () => undefined, info: () => undefined, warn: () => undefined };
  extendObject(id: string, obj: ioBroker.PartialObject): Promise<void> {
    const old = (this.objects.get(id) ?? {}) as Record<string, unknown>;
    this.objects.set(id, { ...old, ...structuredClone(obj) } as unknown as ioBroker.Object);
    return Promise.resolve();
  }
  delObject(): Promise<void> {
    return Promise.resolve();
  }
  knownObject(id: string): unknown {
    return this.objects.get(id);
  }
  getForeignObjects(): Promise<Record<string, ioBroker.Object>> {
    return Promise.resolve({});
  }
  knownValue(id: string): ioBroker.StateValue | undefined {
    return this.states.get(id);
  }
  setState(id: string, state: ioBroker.SettableState): Promise<void> {
    this.states.set(id, state.val ?? null);
    return Promise.resolve();
  }
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<void> {
    return this.setState(id, state);
  }
}

const item = (key: string, status: Status): DownloadItem => ({
  key,
  name: `name-${key}`,
  status,
  sizeBytes: 1,
  doneBytes: 1,
  speedBps: 0,
  etaSeconds: null,
  finishedMs: status === "completed" ? 1_700_000_000_000 : null,
  error: "",
});
const snapshot = (items: DownloadItem[]): Parameters<ProgramTree["sync"]>[0] => ({
  status: { version: "1", paused: false, downloadBps: 0 },
  items,
  complete: true,
});

describe("D-09 the last values stand in the channel last", () => {
  it("are datapoints of the channel last below every program, none of them flat", () => {
    const ids = PROGRAM_DATAPOINTS.map(d => d.id);
    expect(ids).toEqual(expect.arrayContaining(LAST));
    expect(ids.filter(id => /^last[A-Z]/.test(id))).toEqual([]);
  });

  it("are written into the channel last of the program's device", async () => {
    const a = new Memory();
    const tree = new ProgramTree(
      a,
      "qbittorrent-nas",
      "NAS",
      { type: "qbittorrent", capabilities: new Set(), extras: [] },
      { scope: "all", limit: 0 },
    );
    await tree.ensureDevice(undefined, "http://nas:8080");
    expect(a.objects.get("dl-manager.0.qbittorrent-nas.last")?.type).toBe("channel");
    for (const id of LAST) {
      expect(a.objects.get(`dl-manager.0.qbittorrent-nas.${id}`)?.type, id).toBe("state");
    }
    await tree.sync(snapshot([item("a", "downloading"), item("b", "downloading")]));
    await tree.sync(snapshot([item("a", "completed"), item("b", "failed")]));
    expect(a.states.get("dl-manager.0.qbittorrent-nas.last.finished")).toBe("name-a");
    expect(a.states.get("dl-manager.0.qbittorrent-nas.last.finishedTime")).toBe(1_700_000_000_000);
    expect(a.states.get("dl-manager.0.qbittorrent-nas.last.failed")).toBe("name-b");
    expect(typeof a.states.get("dl-manager.0.qbittorrent-nas.last.failedTime")).toBe("number");
  });

  it("stand in the channel last of the summary", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "io-package.json"), "utf8")) as {
      instanceObjects: { _id: string; type: string }[];
    };
    const type = (id: string): string | undefined => pkg.instanceObjects.find(o => o._id === id)?.type;
    expect(type("summary.last")).toBe("channel");
    for (const id of LAST) {
      expect(type(`summary.${id}`), id).toBe("state");
    }
  });
});
