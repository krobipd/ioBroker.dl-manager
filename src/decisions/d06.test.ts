// Core decision D-06 (accepted 2026-10-22): which downloads stand in the object tree is set by a scope (all / without
// finished / only unfinished — failed ones always stay) and a highest number per program (0–1000, 0 = all, default 100);
// above it the best ranked stay — running → failed → paused/waiting → queue → seeding → finished, the newest first within
// a rank; the sums count everything; at 0 or above 200 the settings page and the log warn clearly. krobi 2026-09-29
// 08:45: "that one has crazy many downloads and it would slow everything down … should go into an adapter setting" ·
// 08:48: "ok but that is very coarse, maybe I only want 5 or so" · 08:49: "number field is ok, but a clear warning must
// be there too" · 08:51 on the warning box, its text and the log line: "go".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseMaxDownloads } from "../lib/core/config";
import { ProgramManager, type ManagerAdapter } from "../lib/core/manager";
import type { DownloadItem, ProgramDriver, ProgramEntry, ProgramSnapshot, Status } from "../lib/core/model";
import { shownKeys } from "../lib/core/visibility";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

const json = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), file), "utf8")) as Record<string, unknown>;
const page = (): Record<string, Record<string, unknown>> =>
  json("admin/jsonConfig.json").items as Record<string, Record<string, unknown>>;

const item = (key: string, status: Status, ms: number | null = null): DownloadItem => ({
  key,
  name: key,
  status,
  sizeBytes: 100,
  doneBytes: 50,
  speedBps: 0,
  etaSeconds: null,
  addedMs: ms,
  finishedMs: ms,
  error: "",
});

/** The object and state store of an instance, in memory — this guard's own copy (a guard imports no test code). */
class Memory implements ManagerAdapter {
  readonly namespace = "dl-manager.0";
  readonly objects = new Map<string, ioBroker.Object>();
  readonly states = new Map<string, ioBroker.StateValue>();
  readonly lines: string[] = [];
  readonly log = {
    debug: (m: string): void => void this.lines.push(`debug: ${m}`),
    info: (m: string): void => void this.lines.push(`info: ${m}`),
    warn: (m: string): void => void this.lines.push(`warn: ${m}`),
  };
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
  removeObject(id: string): Promise<void> {
    const f = this.full(id);
    for (const key of [...this.objects.keys()].filter(k => k === f || k.startsWith(`${f}.`))) {
      this.objects.delete(key);
      this.states.delete(key);
    }
    return Promise.resolve();
  }
  knownObject(id: string): unknown {
    return this.objects.get(this.full(id));
  }
  getForeignObjects(pattern: string, type: ioBroker.ObjectType): Promise<Record<string, ioBroker.Object>> {
    const re = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`);
    return Promise.resolve(Object.fromEntries([...this.objects].filter(([id, o]) => re.test(id) && o.type === type)));
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
  channels(device: string): string[] {
    return [...this.objects]
      .filter(([id, o]) => o.type === "channel" && id.startsWith(`${this.namespace}.${device}.downloads.`))
      .map(([id]) => id);
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * @param items what every program lists, by host
 * @param limit the instance's highest number per program
 * @param polls how many times every program is asked
 * @returns the store after every program was asked
 */
async function treeWith(items: Record<string, DownloadItem[]>, limit: number, polls = 1): Promise<Memory> {
  const a = new Memory();
  // the next poll each runner plans, run by hand
  const planned: (() => void)[] = [];
  const entry: ProgramEntry = {
    type: "qbittorrent",
    needs: ["host"],
    create: (cfg): ProgramDriver => ({
      type: "qbittorrent",
      capabilities: new Set(),
      extras: [],
      poll: (): Promise<ProgramSnapshot> =>
        Promise.resolve({
          status: { version: "1", paused: false, downloadBps: 0 },
          items: items[cfg.host],
          complete: true,
        }),
      command: () => Promise.resolve(),
      close: () => Promise.resolve(),
    }),
  };
  const manager = new ProgramManager(
    {
      adapter: a,
      timers: { setTimeout: (fn: () => void) => void planned.push(fn), clearTimeout: () => undefined },
      find: () => entry,
      problems: { report: () => undefined, forget: () => undefined },
      moveDevice: () => Promise.resolve(),
    },
    { intervalMs: 10_000, scope: "all", limit },
  );
  await manager.start(
    Object.keys(items).map(host => ({ id: `qbittorrent-${host}`, type: "qbittorrent", name: host, host })),
  );
  await settle();
  for (let i = 1; i < polls; i++) {
    for (const poll of planned.splice(0)) {
      poll();
    }
    await settle();
  }
  return a;
}

describe("D-06 scope and number per program decide which downloads stand in the tree, with a clear warning", () => {
  it("takes 0 to 1000 downloads per program, 0 for all, 100 by default", () => {
    expect(page().maxDownloads).toMatchObject({ type: "number", min: 0, max: 1000, default: 100 });
    expect((json("io-package.json").native as Record<string, unknown>).maxDownloads).toBe(100);
    for (const n of [0, 5, 1000]) {
      expect(parseMaxDownloads(n), String(n)).toBe(n);
    }
    const many = Array.from({ length: 1001 }, (_, i) => item(`k${i}`, "queued", i));
    expect(shownKeys(many, { scope: "all", limit: 0 }).size).toBe(1001);
    expect(shownKeys(many, { scope: "all", limit: 1000 }).size).toBe(1000);
  });

  it("offers the scopes all, without finished and only unfinished — failed downloads always stay", () => {
    expect((page().treeScope.options as { value: string }[]).map(o => o.value)).toEqual([
      "all",
      "withoutCompleted",
      "unfinished",
    ]);
    const items = [item("run", "downloading"), item("bad", "failed"), item("done", "completed")];
    const keys = (scope: "all" | "withoutCompleted" | "unfinished"): string[] => [
      ...shownKeys(items, { scope, limit: 0 }),
    ];
    expect(keys("all")).toEqual(["run", "bad", "done"]);
    expect(keys("withoutCompleted")).toEqual(["run", "bad"]);
    expect(keys("unfinished")).toEqual(["run", "bad"]);
  });

  it("keeps the best ranked above the number: running, failed, paused/waiting, queue, seeding, finished — newest first", () => {
    const items = [
      item("done", "completed", 9),
      item("seed", "seeding", 9),
      item("queued", "queued", 9),
      item("paused", "paused", 1),
      item("waiting", "waiting", 5),
      item("failed", "failed", 9),
      item("old-run", "downloading", 1),
      item("new-run", "downloading", 2),
    ];
    const first = (n: number): string[] => [...shownKeys(items, { scope: "all", limit: n })].sort();
    expect(first(1)).toEqual(["new-run"]);
    expect(first(2)).toEqual(["new-run", "old-run"]);
    expect(first(3)).toEqual(["failed", "new-run", "old-run"]);
    expect(first(4)).toEqual(["failed", "new-run", "old-run", "waiting"]);
    expect(first(5)).toEqual(["failed", "new-run", "old-run", "paused", "waiting"]);
    expect(first(6)).toEqual(["failed", "new-run", "old-run", "paused", "queued", "waiting"]);
    expect(first(7)).toEqual(["failed", "new-run", "old-run", "paused", "queued", "seed", "waiting"]);
  });

  it("applies the number to each program and counts everything in the sums", async () => {
    const lists = {
      a: [item("a1", "queued", 1), item("a2", "queued", 2), item("a3", "queued", 3)],
      b: [item("b1", "queued", 1), item("b2", "queued", 2)],
    };
    const a = await treeWith(lists, 1);
    expect(a.channels("qbittorrent-a")).toHaveLength(1);
    expect(a.channels("qbittorrent-b")).toHaveLength(1);
    expect(a.states.get("dl-manager.0.qbittorrent-a.total")).toBe(3);
    expect(a.states.get("dl-manager.0.qbittorrent-a.queued")).toBe(3);
    expect(a.states.get("dl-manager.0.summary.queued")).toBe(5);
  });

  it("shows a warning box on the settings page at 0 or above 200", () => {
    const box = page()._warnManyDownloads as { hidden: string };
    const shows = (maxDownloads: number): boolean =>
      !(new Function("data", `return ${box.hidden}`) as (d: unknown) => boolean)({ maxDownloads });
    expect([0, 1, 100, 200, 201, 1000].map(shows)).toEqual([true, false, false, false, true, true]);
  });

  it("warns in the log once per program and start when a program shows more than 200 downloads in the tree", async () => {
    const many = Array.from({ length: 201 }, (_, i) => item(`k${i}`, "queued", i));
    const warns = (a: Memory): string[] => a.lines.filter(l => l.startsWith("warn: "));
    expect(warns(await treeWith({ all: many }, 0, 2))).toHaveLength(1);
    expect(warns(await treeWith({ a: many, b: many }, 0, 2))).toHaveLength(2);
    expect(warns(await treeWith({ all: many }, 200, 2))).toEqual([]);
  });
});
