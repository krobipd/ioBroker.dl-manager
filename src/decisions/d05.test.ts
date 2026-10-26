// Core decision D-05 (accepted 2026-10-22): what is the same for all downloads is set once for the instance — never per
// download, never per program. krobi 2026-09-28 22:03: "removing the finished ones from iobroker I would rather make an
// adapter option, one general option for all and done. otherwise you have the same option 1000 times".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { emptyForm, formToRow, OFFERED, programForm } from "../lib/dm-forms";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

/** The settings that hold for every program and every download of the instance. */
const INSTANCE_SETTINGS = ["pollInterval", "treeScope", "maxDownloads"];

const json = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), file), "utf8")) as Record<string, unknown>;

describe("D-05 settings hold for the whole instance", () => {
  it("are instance settings: declared in the instance's native and shown on the instance settings page", () => {
    const native = json("io-package.json").native as Record<string, unknown>;
    const page = (json("admin/jsonConfig.json").items ?? {}) as Record<string, unknown>;
    for (const key of INSTANCE_SETTINGS) {
      expect(native, key).toHaveProperty(key);
      expect(page, key).toHaveProperty(key);
    }
  });

  it("are no field of a program's dialog and no part of a program row", () => {
    for (const p of OFFERED) {
      const items = (programForm(p.type, { takenKeys: [] }) as unknown as { items: Record<string, unknown> }).items;
      const row = formToRow(p.type, { ...emptyForm(p.type), name: "x", host: "h" }, "id");
      for (const key of INSTANCE_SETTINGS) {
        expect(items, `${p.type} dialog`).not.toHaveProperty(key);
        expect(row, `${p.type} row`).not.toHaveProperty(key);
      }
    }
  });
});
