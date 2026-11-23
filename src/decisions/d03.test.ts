// Core decision D-03 (accepted 2026-10-22, since 2026-11-20 a consequence of D-13 for every program): where a program
// is reached locally or through an account with its maker, its dialog switches between the two ways and asks only the
// fields of the chosen way; through an account the user picks the program's installation from the account's list.
// krobi 2026-09-28 21:52: "if possible build in both ways, local and cloud access" · 2026-09-29 18:14: "a really
// modern, nice setup that offers only the options the service has — e.g. for jdownloader a toggle for my.jdownloader
// or local, and it asks the data depending on that" · 18:21: "when you choose my.jdownloader there is a dropdown which
// server you want to have there" · 2026-11-20 18:38, on whether other downloaders' accounts get the same: "of course
// every downloader, what else". Every program of the catalog with an account way is checked; today that is
// My.JDownloader.
import { describe, expect, it, vi } from "vitest";
import { DlDeviceManagement, type DmHost } from "../lib/device-management";
import { dialogType, OFFERED, programForm, rowToForm, storedType } from "../lib/dm-forms";
import { CATALOG, needsOf, type ProgramInfo } from "../lib/programs/catalog";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

type Items = Record<string, { hidden?: string; options?: { value: string }[] }>;
const itemsOf = (schema: unknown): Items => (schema as { items: Items }).items;
/**
 * @param expr a dialog expression
 * @param data the dialog data
 * @returns what the admin computes for it
 */
const run = (expr: string | undefined, data: Record<string, unknown>): unknown =>
  expr === undefined ? false : (new Function("data", `return ${expr}`) as (d: unknown) => unknown)(data);

/**
 * @param what what the guard needs to run at all
 * @param ok whether it is there
 */
function need(what: string, ok: boolean): void {
  if (!ok) {
    throw new Error(`D-03 guard cannot run: ${what}`);
  }
}

/** A program the catalog reaches both ways: its local entry and its account entry (same product). */
interface BothWays {
  local: ProgramInfo;
  account: ProgramInfo;
}
const BOTH: BothWays[] = CATALOG.filter(p => p.login === "account").flatMap(account => {
  const local = CATALOG.find(p => p.label === account.label && p.login !== "account");
  return local ? [{ local, account }] : [];
});

/** The dialog field whose choices store the two ways, and the choice of each way. */
interface WaySwitch {
  key: string;
  choices: string[];
  local: string;
  account: string;
}
/**
 * @param program the program reached both ways
 * @param items the fields of its dialog
 * @returns the switch between the two ways, undefined when the dialog has none
 */
function waySwitch(program: BothWays, items: Items): WaySwitch | undefined {
  for (const [key, item] of Object.entries(items)) {
    const choices = item.options?.map(o => o.value) ?? [];
    const stores = (choice: string): string => storedType(program.local.type, { [key]: choice } as never);
    const local = choices.find(c => stores(c) === program.local.type);
    const account = choices.find(c => stores(c) === program.account.type);
    if (local !== undefined && account !== undefined) {
      return { key, choices, local, account };
    }
  }
  return undefined;
}

describe("D-03 a program reached locally or through an account", () => {
  it("has one dialog that switches between the two ways", () => {
    need("a program of the catalog with an account way and a local one", BOTH.length > 0);
    for (const program of BOTH) {
      const offered = OFFERED.map(p => p.type);
      expect(offered, program.account.type).toContain(program.local.type);
      expect(offered, program.account.type).not.toContain(program.account.type);
      expect(dialogType({ type: program.account.type }), program.account.type).toBe(program.local.type);
      expect(dialogType({ type: program.local.type }), program.local.type).toBe(program.local.type);
      const items = itemsOf(programForm(program.local.type as never, { takenKeys: [] }));
      const sw = waySwitch(program, items);
      expect(sw, `${program.local.type}: a switch whose choices store the two ways`).toBeDefined();
      expect(sw?.choices, program.local.type).toHaveLength(2);
      const reopened = (type: string): unknown => (rowToForm({ type }) as unknown as Record<string, unknown>)[sw!.key];
      expect(reopened(program.account.type), program.account.type).toBe(sw?.account);
      expect(reopened(program.local.type), program.local.type).toBe(sw?.local);
    }
  });

  it("asks only the fields of the chosen way", () => {
    need("a program of the catalog with an account way and a local one", BOTH.length > 0);
    for (const program of BOTH) {
      const items = itemsOf(programForm(program.local.type as never, { takenKeys: [] }));
      const sw = waySwitch(program, items);
      expect(sw, `${program.local.type}: a switch whose choices store the two ways`).toBeDefined();
      const fieldsOf = (way: ProgramInfo): string[] => needsOf(way).filter(f => f in items);
      const ways = [
        { info: program.local, choice: sw!.local, other: program.account },
        { info: program.account, choice: sw!.account, other: program.local },
      ];
      for (const way of ways) {
        const data = { [sw!.key]: way.choice };
        const own = fieldsOf(way.info);
        need(`${way.info.type}: a field of its way in the dialog`, own.length > 0);
        for (const field of own) {
          expect(run(items[field].hidden, data), `${way.info.type} asks ${field}`).toBe(false);
        }
        for (const field of fieldsOf(way.other).filter(f => !own.includes(f))) {
          expect(run(items[field].hidden, data), `${way.info.type} does not ask ${field}`).toBe(true);
        }
      }
    }
  });

  it("lets the user pick the program's installation from the account's list and stores the chosen one", async () => {
    need("a program of the catalog with an account way and a local one", BOTH.length > 0);
    for (const program of BOTH) {
      let stored: Record<string, unknown>[] = [];
      const asked: string[] = [];
      const installations = [
        { id: "aaaa1111", name: "Cellar" },
        { id: "bbbb2222", name: "Office" },
      ];
      const host: DmHost = {
        readRows: () => Promise.resolve(structuredClone(stored)),
        updateRows: change => {
          const next = change(structuredClone(stored));
          if (next) {
            stored = structuredClone(next);
          }
          return Promise.resolve();
        },
        hasObject: () => Promise.resolve(false),
        readState: () => Promise.resolve(undefined),
        test: () => Promise.resolve({ ok: true, version: "1" }),
        listJdDevices: account => {
          asked.push(account);
          return Promise.resolve(structuredClone(installations));
        },
        icon: () => undefined,
        iobHost: () => "iobhost",
      };
      const adapter = {
        namespace: "dl-manager.0",
        on: () => undefined,
        log: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
        setTimeout: () => undefined,
      };
      const dm = new DlDeviceManagement(adapter as never, host) as unknown as {
        getInstanceInfo(): { actions: { handler: (ctx: unknown) => Promise<unknown> }[] };
      };
      const items = itemsOf(programForm(program.local.type as never, { takenKeys: [] }));
      const sw = waySwitch(program, items);
      expect(sw, `${program.local.type}: a switch whose choices store the two ways`).toBeDefined();
      const typed: Record<string, unknown> = { name: "friend", enabled: true, [sw!.key]: sw!.account };
      for (const field of needsOf(program.account).filter(f => f in items)) {
        typed[field] = "me@example.com";
      }
      const offered: string[][] = [];
      const answers: ((schema: { items: Items }) => unknown)[] = [
        () => ({ type: program.local.type }),
        () => typed,
        schema => {
          const pick = Object.entries(schema.items).find(([, item]) =>
            installations.some(i => item.options?.some(o => o.value === i.id)),
          );
          offered.push(pick?.[1].options?.map(o => o.value) ?? []);
          return pick ? { [pick[0]]: "bbbb2222" } : undefined;
        },
      ];
      const ctx = {
        showForm: (schema: { items: Items }) => Promise.resolve(answers.shift()?.(schema)),
        showMessage: () => Promise.resolve(),
        openProgress: () => Promise.resolve({ update: () => Promise.resolve(), close: () => Promise.resolve() }),
      };
      await dm.getInstanceInfo().actions[0].handler(ctx);
      expect(asked, `${program.account.type}: the list of the typed account`).toEqual(["me@example.com"]);
      expect(offered, `${program.account.type}: the account's installations offered`).toEqual([
        ["aaaa1111", "bbbb2222"],
      ]);
      expect(stored, program.account.type).toHaveLength(1);
      expect(stored[0].type, program.account.type).toBe(program.account.type);
      expect(Object.values(stored[0]), `${program.account.type}: the chosen installation`).toContain("bbbb2222");
      expect(Object.values(stored[0]), `${program.account.type}: not another one`).not.toContain("aaaa1111");
    }
  });
});
