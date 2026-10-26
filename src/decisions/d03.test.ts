// Core decision D-03 (accepted 2026-10-22): JDownloader is reached locally or through My.JDownloader, and both live in
// ONE card — a switch local / My.JDownloader in the JDownloader dialog; with My.JDownloader the user picks the
// JDownloader instance of the account from a list. krobi 2026-09-28 21:52: "if possible build in both ways, local and
// cloud access" · 2026-09-29 18:14: "a really modern, nice setup that offers only the options the service has — e.g. for
// jdownloader a toggle for my.jdownloader or local, and it asks the data depending on that" · 18:21: "when you choose
// my.jdownloader there is a dropdown which server you want to have there".
import { describe, expect, it, vi } from "vitest";
import { DlDeviceManagement, type DmHost } from "../lib/device-management";
import { dialogType, OFFERED, programForm, rowToForm, storedType } from "../lib/dm-forms";

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

describe("D-03 JDownloader local and My.JDownloader in one card", () => {
  it("offers one JDownloader dialog for both connections", () => {
    const offered = OFFERED.map(p => p.type);
    expect(offered).toContain("jdownloader");
    expect(offered).not.toContain("jdownloader-cloud");
    expect(dialogType({ type: "jdownloader-cloud" })).toBe("jdownloader");
    expect(dialogType({ type: "jdownloader" })).toBe("jdownloader");
  });

  it("switches between local and My.JDownloader inside that dialog and asks only the fields of the chosen way", () => {
    const items = itemsOf(programForm("jdownloader", { takenKeys: [] }));
    expect(items.mode.options?.map(o => o.value)).toEqual(["local", "cloud"]);
    const local = { mode: "local" as const };
    const cloud = { mode: "cloud" as const };
    expect(run(items.host.hidden, local)).toBe(false);
    expect(run(items.host.hidden, cloud)).toBe(true);
    expect(run(items.username.hidden, local)).toBe(true);
    expect(run(items.username.hidden, cloud)).toBe(false);
    expect(run(items.password.hidden, cloud)).toBe(false);
    expect(storedType("jdownloader", local)).toBe("jdownloader");
    expect(storedType("jdownloader", cloud)).toBe("jdownloader-cloud");
    expect(rowToForm({ type: "jdownloader-cloud" }).mode).toBe("cloud");
  });

  it("lets the user pick the JDownloader instance of the account from a list, and stores the chosen one", async () => {
    let stored: Record<string, unknown>[] = [];
    const listed: string[] = [];
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
      listJdDevices: email => {
        listed.push(email);
        return Promise.resolve([
          { id: "aaaa1111", name: "Cellar" },
          { id: "bbbb2222", name: "Office" },
        ]);
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
    const offeredDevices: string[][] = [];
    const answers: ((schema: { items: Items }) => unknown)[] = [
      () => ({ type: "jdownloader" }),
      () => ({ name: "JD friend", mode: "cloud", username: "me@example.com", password: "secret", enabled: true }),
      schema => {
        offeredDevices.push(schema.items.device.options?.map(o => o.value) ?? []);
        return { device: "bbbb2222" };
      },
    ];
    const ctx = {
      showForm: (schema: { items: Items }) => Promise.resolve(answers.shift()?.(schema)),
      showMessage: () => Promise.resolve(),
      openProgress: () => Promise.resolve({ update: () => Promise.resolve(), close: () => Promise.resolve() }),
    };
    await dm.getInstanceInfo().actions[0].handler(ctx);
    expect(listed).toEqual(["me@example.com"]);
    expect(offeredDevices).toEqual([["aaaa1111", "bbbb2222"]]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ type: "jdownloader-cloud", device: "Office", deviceId: "bbbb2222" });
  });
});
