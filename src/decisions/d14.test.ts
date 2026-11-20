// Core decision D-14 (accepted 2026-11-19 18:54): the adapter supports only download programs — programs that load
// downloads themselves. What only hands downloads on to other software and loads nothing itself, a program of its own or
// a setting of other software, it does not support: it cannot be chosen in the admin and gets no device. krobi
// 2026-11-17 08:32, on Blackhole being only a folder for Sonarr and Radarr and Pneumatic handing every download to
// SABnzbd: "yes right, because they sit as it were only between pieces of software and are no downloaders themselves" ·
// 08:41: "dl-manager can remember this behaviour directly for further cases of this kind" · 2026-11-19 18:44: "only
// downloaders are supported, no pseudo programs that do something. so if blackhole really only forwards to sonarr, then
// it is sonarr and there is no blackhole for anything".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProgramManager, type ManagerAdapter } from "../lib/core/manager";
import type { ProgramDriver, ProgramEntry } from "../lib/core/model";
import { pickProgramForm } from "../lib/dm-forms";
import { CATALOG } from "../lib/programs/catalog";
import { findProgram } from "../lib/programs/registry";

/**
 * A precondition of this guard — it throws when the guard cannot run, it asserts nothing of the rule.
 *
 * @param ok what has to hold for the guard to run
 * @param what what is missing otherwise
 */
function need(ok: unknown, what: string): asserts ok {
  if (!ok) {
    throw new Error(`the guard cannot run: ${what}`);
  }
}

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

const json = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), file), "utf8")) as Record<string, unknown>;

/** Release gate A15's list: every download way Sonarr and Radarr know, the ones that only hand on under `excluded`. */
const sources = json("device-sources.json");
/** What only hands downloads on, under the name Sonarr and Radarr give it (Blackhole, Pneumatic). */
const HANDS_ON = Object.keys(sources.excluded as Record<string, string>);

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
  removeObject(): Promise<void> {
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

describe("D-14 only download programs, nothing that only hands downloads on", () => {
  it("has no program for what only hands downloads on", () => {
    need(HANDS_ON.length > 0, "nothing that only hands on is known");
    for (const p of CATALOG) {
      for (const name of HANDS_ON) {
        expect([p.type, p.label.toLowerCase()], name).not.toContain(name.toLowerCase());
      }
    }
  });

  it("lets nothing that only hands downloads on be chosen in the admin, and gives it no device", async () => {
    const pick = pickProgramForm(() => undefined) as unknown as { items: { type: { options: { value: string }[] } } };
    const offered = pick.items.type.options.map(o => o.value.toLowerCase());
    need(offered.length > 0, "the admin offers no program");
    for (const name of HANDS_ON) {
      expect(offered, name).not.toContain(name.toLowerCase());
    }

    // a stored row of every kind: a catalogue program, and each that only hands on (only a hand-edited file holds one)
    const a = new Memory();
    const driver = (type: string): ProgramDriver => ({
      type,
      capabilities: new Set(["globalPause"]),
      extras: [],
      poll: () => new Promise(() => undefined),
      command: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
    // the adapter's own lookup decides which type is a program; the driver behind it is a stand-in that never asks
    const find = (type: string): ProgramEntry | undefined => {
      const entry = findProgram(type);
      return entry && { ...entry, needs: [], create: () => driver(type) };
    };
    const manager = new ProgramManager(
      {
        adapter: a,
        timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
        find,
        problems: { report: () => undefined, forget: () => undefined },
        moveDevice: () => Promise.resolve(),
      },
      { intervalMs: 10_000, scope: "all", limit: 100 },
    );
    await manager.start([
      { id: "qbittorrent-nas", type: "qbittorrent", name: "NAS", host: "nas", username: "u", password: "pw" },
      ...HANDS_ON.map(name => ({ id: `${name.toLowerCase()}-nas`, type: name.toLowerCase(), name, host: "nas" })),
    ]);
    const devices = [...a.objects].filter(([, o]) => o.type === "device").map(([id]) => id);
    need(devices.length > 0, "the manager built no device");
    for (const name of HANDS_ON) {
      expect(devices.join(" "), name).not.toContain(name.toLowerCase());
    }
  });
});
