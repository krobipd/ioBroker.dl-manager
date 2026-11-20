// Core decision D-05 (accepted 2026-10-22, amended 2026-11-19 19:41): what is the same for all downloads is set once for
// the whole instance — never per download or per program, except the switch "Also delete the files when removing" of
// D-04. krobi 2026-09-28 22:03: "removing the finished ones from iobroker I would rather make an adapter option, one
// general option for all and done. otherwise you have the same option 1000 times" · 2026-11-19 19:41, on the answer
// that D-05 forbids a setting per program and so does not fit his switch per program: "Yes, but that is my new decision
// now".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ITEM_DATAPOINTS } from "../lib/core/datapoints";
import { emptyForm, formToRow, OFFERED, programForm } from "../lib/dm-forms";

// adapter-core's I18n needs a running adapter; the dialog's labels stay their text keys.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

const json = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), file), "utf8")) as Record<string, unknown>;
const de = json("admin/i18n/de.json");

/** The switch of D-04, as the rule names it. */
const SWITCH = "Beim Entfernen auch die Dateien löschen";

/**
 * @param label a field's label: a text key of the settings page, or a translated text of a dialog
 * @returns its German text
 */
const german = (label: unknown): unknown =>
  de[typeof label === "string" ? label : String((label as { en?: unknown } | undefined)?.en)];

/**
 * @param items the fields of a page
 * @returns every field, also those inside a panel, with its key
 */
function fieldsOf(items: Record<string, Record<string, unknown>>): [string, Record<string, unknown>][] {
  return Object.entries(items).flatMap(([k, f]) => [
    [k, f] as [string, Record<string, unknown>],
    ...(f.items ? fieldsOf(f.items as Record<string, Record<string, unknown>>) : []),
  ]);
}

/** The instance settings page. */
const PAGE = fieldsOf((json("admin/jsonConfig.json").items ?? {}) as Record<string, Record<string, unknown>>);
/** What the instance holds for itself: one value of each setting. */
const SETTINGS = Object.keys(json("io-package.json").native ?? {});
/** The German label of each setting on the settings page. */
const LABELS = new Map(SETTINGS.map(key => [key, german(PAGE.find(([k]) => k === key)?.[1].label)]));
/** The switch of D-04 among the settings. */
const GENERAL = SETTINGS.find(key => LABELS.get(key) === SWITCH);

/**
 * @param type a program of the admin's choice
 * @returns the settings its dialog asks — by key or by the label of the settings page — with the field's German label
 */
function askedAt(type: (typeof OFFERED)[number]["type"]): { key: string; label: unknown }[] {
  const items = (programForm(type, { takenKeys: [] }) as unknown as { items: Record<string, Record<string, unknown>> })
    .items;
  return Object.entries(items).flatMap(([k, f]) => {
    const label = german(f.label);
    const key = SETTINGS.find(s => s === k || (label !== undefined && LABELS.get(s) === label));
    return key ? [{ key, label }] : [];
  });
}

/**
 * @param type a program of the admin's choice
 * @returns the settings its stored row carries
 */
function storedAt(type: (typeof OFFERED)[number]["type"]): string[] {
  const row = formToRow(type, { ...emptyForm(type), name: "x", host: "h" }, "id");
  return Object.keys(row).filter(k => SETTINGS.includes(k));
}

describe("D-05 what is the same for all downloads is set once for the whole instance", () => {
  it("sets every setting of the instance once, on the instance settings page", () => {
    expect(SETTINGS.length).toBeGreaterThan(0);
    for (const key of SETTINGS) {
      expect(PAGE.filter(([k]) => k === key).length, key).toBe(1);
    }
  });

  it("sets none per download", () => {
    const labels = [...LABELS.values()];
    for (const d of ITEM_DATAPOINTS) {
      expect(SETTINGS, d.id).not.toContain(d.id);
      expect(labels, d.id).not.toContain(de[d.nameKey]);
    }
  });

  it("sets none per program — but the switch of D-04", () => {
    for (const p of OFFERED) {
      expect(
        askedAt(p.type)
          .map(s => s.key)
          .filter(k => k !== GENERAL),
        `${p.type} dialog`,
      ).toEqual([]);
      expect(
        storedAt(p.type).filter(k => k !== GENERAL),
        `${p.type} row`,
      ).toEqual([]);
    }
  });

  it("lets the switch of D-04 stand per program", () => {
    expect(GENERAL).toBeDefined();
    const asked = OFFERED.flatMap(p => askedAt(p.type));
    expect(asked.length).toBeGreaterThan(0);
    for (const s of asked) {
      expect(s.label, s.key).toBe(SWITCH);
    }
  });
});
