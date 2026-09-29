import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
    translate: vi.fn((key: string) => `${key}_plain`),
  },
}));

import { tDesc, tName, tState, tText } from "./i18n";

describe("i18n helpers", () => {
  it("tName and tDesc return translation objects", () => {
    expect(tName("channelInfo")).toEqual({ en: "channelInfo", de: "channelInfo_de" });
    expect(tDesc("descConnection")).toEqual({ en: "descConnection", de: "descConnection_de" });
  });
  it("tState and tText return plain strings (common.states and radio labels must never hold an object)", () => {
    expect(tState("statusQueued")).toBe("statusQueued_plain");
    expect(tText("dmJdLocal")).toBe("dmJdLocal_plain");
  });
});

describe("i18n completeness", () => {
  const dir = join(__dirname, "../../admin/i18n");
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  const byLang = new Map(
    files.map(f => [f.replace(".json", ""), JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, string>]),
  );
  const en = byLang.get("en")!;

  it("has all eleven ioBroker languages", () => {
    expect([...byLang.keys()].sort()).toEqual(["de", "en", "es", "fr", "it", "nl", "pl", "pt", "ru", "uk", "zh-cn"]);
  });

  for (const [lang, table] of byLang) {
    it(`${lang} carries exactly the keys of en, none empty`, () => {
      expect(Object.keys(table).sort()).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(table)) {
        expect(typeof text, key).toBe("string");
        expect(text.trim().length, key).toBeGreaterThan(0);
      }
    });
  }
});
