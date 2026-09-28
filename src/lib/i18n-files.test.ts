import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ITEM_DATAPOINTS, PROGRAM_DATAPOINTS } from "./core/datapoints";
import { PROGRAMS } from "./programs/registry";

const I18N = join(__dirname, "..", "..", "admin", "i18n");
const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const en = read(join(I18N, "en.json"));

/**
 * @param node part of jsonConfig
 * @param out collected keys
 * @returns every label, help text, tooltip and option label of the settings page
 */
function uiKeys(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach(n => uiKeys(n, out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (["label", "help", "tooltip", "text", "title"].includes(k) && typeof v === "string") {
        out.add(v);
      }
      uiKeys(v, out);
    }
  }
  return out;
}

describe("admin/i18n", () => {
  it("has the same keys in every language, none empty", () => {
    const keys = Object.keys(en).sort();
    for (const file of readdirSync(I18N).filter(f => f.endsWith(".json"))) {
      const lang = read(join(I18N, file));
      expect([file, Object.keys(lang).sort()]).toEqual([file, keys]);
      expect([
        file,
        Object.entries(lang)
          .filter(([, v]) => typeof v !== "string" || !v.trim())
          .map(([k]) => k),
      ]).toEqual([file, []]);
    }
  });

  it("carries every text the settings page shows", () => {
    const ui = uiKeys(JSON.parse(readFileSync(join(__dirname, "..", "..", "admin", "jsonConfig.json"), "utf8")));
    expect([...ui].filter(k => !(k in en) && /^[A-Za-z_]+$/.test(k))).toEqual([]);
  });

  it("carries every name and explanation of the datapoints and of every driver's extras", () => {
    const keys = [
      ...[...PROGRAM_DATAPOINTS, ...ITEM_DATAPOINTS].flatMap(d => [d.nameKey, d.descKey]),
      ...PROGRAMS.flatMap(p =>
        p
          .create(
            {
              type: p.type,
              key: "",
              name: "",
              host: "h",
              port: 0,
              https: false,
              path: "",
              username: "u",
              password: "p",
              apiKey: "k",
              device: "d",
            },
            {
              setTimeout: () => undefined,
              clearTimeout: () => undefined,
              log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
            },
          )
          .extras.flatMap(e => [e.nameKey, e.descKey]),
      ),
    ].filter((k): k is NonNullable<typeof k> => k !== undefined);
    expect(keys.filter(k => !(k in en))).toEqual([]);
  });
});
