// Core decision D-13 (accepted 2026-11-19 18:54): every decision of the dl-manager holds for every download program
// the adapter drives, today and in future, with the same result for the user. Where a program behaves differently, the
// adapter adapts only its handling of this program until the result is the same; what cannot be reached there that way,
// it does not offer at this program. A decision, exception or question of its own for a single program does not exist;
// what the user is to choose himself becomes a setting in the admin that offers every program the same choice.
// krobi 2026-11-19 17:38: "you are showing me this now? I am confused, the same decisions hold for every downloader,
// why should I make a decision of its own for one downloader only? what is the general decision for all downloaders" ·
// 2026-10-22 22:24, on K8 (a new link in a paused program): "k8 is a specific answer, … if at all, such a decision is
// better placed in the admin, where the user can set this behaviour".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parsePrograms } from "../lib/core/config";
import { RefusedError } from "../lib/core/errors";
import type { DriverDeps, ProgramConfig } from "../lib/core/model";
import {
  dialogType,
  emptyForm,
  formFromData,
  formToRow,
  programForm,
  storedType,
  type DialogType,
  type FormContext,
} from "../lib/dm-forms";
import { CATALOG, type ProgramInfo } from "../lib/programs/catalog";
import { findProgram } from "../lib/programs/registry";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));
// no program is reached: whatever a driver sends fails at once instead of waiting for an address nobody answers (fetch,
// and node:http(s) where the HTTP client keeps the header names or the certificate)
const offline = vi.hoisted(() => (): never => {
  throw new TypeError("offline");
});
vi.mock("node:http", async importOriginal => ({ ...(await importOriginal<object>()), request: offline }));
vi.mock("node:https", async importOriginal => ({ ...(await importOriginal<object>()), request: offline }));

const CFG: ProgramConfig = {
  type: "",
  name: "guard",
  host: "192.0.2.1",
  port: 0,
  https: false,
  path: "",
  username: "user@example.com",
  password: "pw",
  apiKey: "key",
  device: "dev",
  deviceId: "dev1",
};
const DEPS: DriverDeps = {
  setTimeout: () => undefined,
  clearTimeout: () => undefined,
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
};
const KEY = "42";
const de = JSON.parse(readFileSync(join(process.cwd(), "admin", "i18n", "de.json"), "utf8")) as Record<string, unknown>;
/** The one choice a program may be unable to carry out: D-04's switch, as krobi named it. */
const SWITCH = "Beim Entfernen auch die Dateien löschen";

/**
 * @param field a dialog field
 * @returns the German text of its label
 */
const german = (field: unknown): unknown => de[String((field as { label?: { en?: unknown } }).label?.en)];

/**
 * Every list of string literals in a guard that names two programs of the catalog or more.
 *
 * @param file the guard's name
 * @param text its source
 * @returns `<file>:<line> <programs>` per list
 */
function programLists(file: string, text: string): string[] {
  const types = new Set<string>(CATALOG.map(p => p.type));
  // comments explain, they decide nothing — a line keeps its number
  const code = text.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
  const found: string[] = [];
  for (const m of code.matchAll(/\[([^[\]]*)\]/g)) {
    const parts = m[1]
      .split(",")
      .map(p => p.trim())
      .filter(p => p !== "");
    if (!parts.length || !parts.every(p => /^(["'`])[^"'`]*\1$/.test(p))) {
      continue;
    }
    const named = parts.map(p => p.slice(1, -1)).filter(v => types.has(v));
    if (named.length >= 2) {
      found.push(`${file}:${code.slice(0, m.index).split("\n").length} ${named.join(", ")}`);
    }
  }
  return found;
}

/**
 * Removes a download that is loading — the program's queue lists it — and deletes its files.
 *
 * @param info a program of the catalog
 * @returns the reason the driver refuses, or undefined when it carries the removal out
 */
async function refusalOfDelete(info: ProgramInfo): Promise<string | undefined> {
  const driver = findProgram(info.type)!.create({ ...CFG, type: info.type }, DEPS);
  // the download is loading: the queue or the task list the driver keeps of the program's last answer lists it
  const own = driver as unknown as Record<string, unknown>;
  if (own.inQueue instanceof Set) {
    own.inQueue.add(KEY);
  }
  if (own.tasks instanceof Map) {
    own.tasks.set(KEY, { id: KEY, status: "downloading", row: {} });
  }
  try {
    await driver.command({ kind: "remove", key: KEY, deleteFiles: true });
  } catch (err: unknown) {
    if (err instanceof RefusedError) {
      return err.message;
    }
  }
  return undefined;
}

/**
 * @param info a program of the catalog
 * @returns its dialog, and the dialog's answer that stores a row of exactly this program
 */
function dialogOf(info: ProgramInfo): { dialog: DialogType; mode: "local" | "cloud" } {
  const dialog = dialogType({ type: info.type });
  expect(dialog, info.type).toBeDefined();
  const mode = (["local", "cloud"] as const).find(m => storedType(dialog!, { mode: m }) === info.type);
  expect(mode, info.type).toBeDefined();
  return { dialog: dialog!, mode: mode! };
}

/**
 * A field is the user's choice when another answer changes the stored program, but not how the program is reached.
 *
 * @param info a program of the catalog
 * @param key the field's key in the dialog's answer
 * @param field the field
 * @returns whether the field is a choice
 */
function isChoice(info: ProgramInfo, key: string, field: unknown): boolean {
  const { dialog, mode } = dialogOf(info);
  const opened = emptyForm(dialog);
  const base: Record<string, unknown> = { mode, host: "nas", name: info.label };
  const now = base[key] ?? (opened as unknown as Record<string, unknown>)[key];
  const options = (field as { options?: unknown }).options;
  const values = Array.isArray(options)
    ? options.map(o => (o as { value?: unknown }).value)
    : options && typeof options === "object"
      ? Object.keys(options)
      : [];
  const other =
    values.find(v => v !== now) ?? (typeof now === "boolean" ? !now : typeof now === "string" ? `1${now}` : true);
  const read = (answer: Record<string, unknown>): Record<string, unknown> => {
    const row = formToRow(dialog, formFromData(answer, opened), `${info.type}-nas`);
    const [program] = parsePrograms([row], findProgram);
    expect(program, info.type).toBeDefined();
    return program as unknown as Record<string, unknown>;
  };
  // the program is reached with what the row hands its driver
  const { cfg: reachedBefore, ...before } = read(base);
  const { cfg: reachedAfter, ...after } = read({ ...base, [key]: other });
  return isDeepStrictEqual(reachedBefore, reachedAfter) && !isDeepStrictEqual(before, after);
}

/**
 * @param info a program of the catalog
 * @param ctx the instance's settings
 * @returns the choices of its dialog
 */
function choicesOf(info: ProgramInfo, ctx: FormContext): Record<string, unknown> {
  const items = (programForm(dialogOf(info).dialog, ctx) as unknown as { items: Record<string, unknown> }).items;
  return Object.fromEntries(Object.entries(items).filter(([k, f]) => isChoice(info, k, f)));
}

/**
 * @param choices the choices of a dialog
 * @returns the delete question among them, and the rest
 */
function split(choices: Record<string, unknown>): { question: unknown; rest: Record<string, unknown> } {
  const entries = Object.entries(choices);
  return {
    question: entries.find(([, f]) => german(f) === SWITCH),
    rest: Object.fromEntries(entries.filter(([, f]) => german(f) !== SWITCH)),
  };
}

describe("D-13 every decision holds for every program, with the same result for the user", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("holds every decision for every program — no guard keeps a list of programs of its own", () => {
    const dir = join(process.cwd(), "src", "decisions");
    const guards = readdirSync(dir).filter(f => f.endsWith(".test.ts"));
    expect(guards.length).toBeGreaterThan(1);
    const lists = guards.flatMap(f => programLists(f, readFileSync(join(dir, f), "utf8")));
    expect(lists).toEqual([]);
  });

  it("offers at a program only what it can reach there — the delete choice exactly where the program deletes", async () => {
    let asking = 0;
    for (const info of CATALOG) {
      const offered = split(choicesOf(info, { takenKeys: [] })).question !== undefined;
      asking += offered ? 1 : 0;
      const refusal = await refusalOfDelete(info);
      // where the card asks, the program carries the deletion out; where it cannot, the card does not ask
      expect(refusal === undefined, `${info.type}: ${refusal ?? "carried out"}`).toBe(offered);
    }
    expect(asking).toBeGreaterThan(0);
  });

  it("makes what the user chooses a setting that offers every program the same choice", () => {
    for (const deleteFilesAll of [false, true]) {
      const ctx: FormContext = { takenKeys: [], deleteFilesAll };
      const cards = CATALOG.map(info => ({ type: info.type, ...split(choicesOf(info, ctx)) }));
      const question = cards.find(c => c.question !== undefined)?.question;
      expect(question).toBeDefined();
      for (const card of cards) {
        // every choice is the same at every program
        expect(card.rest, card.type).toEqual(cards[0].rest);
        // and the delete question is the same at every program that can carry it out
        if (card.question !== undefined) {
          expect(card.question, card.type).toEqual(question);
        }
      }
    }
  });
});
