import { join } from "node:path";
import * as I18n from "@iobroker/adapter-core/i18n";
import { tName } from "./i18n";

// Against the real adapter-core translation module and the shipped texts — the other suites stub the translation
// away. The package root needs a js-controller, its `i18n` entry does not.
vi.mock("@iobroker/adapter-core", async () => ({ I18n: await import("@iobroker/adapter-core/i18n") }));

describe("tName — placeholders, with the real adapter-core", () => {
  beforeAll(async () => {
    await I18n.init(join(__dirname, "../../admin"), "en");
  });

  it("fills every placeholder in order, in every language", () => {
    const text = tName("dmTestOkDownloads", "JD", "2.0", 3) as Record<string, string>;
    expect(text.en).toBe("JD answers — version 2.0, 3 download(s).");
    for (const [lang, value] of Object.entries(text)) {
      expect(value, lang).not.toContain("%s");
      expect(value, lang).toContain("JD");
      expect(value, lang).toContain("2.0");
    }
  });

  it("names the program and the reason when it cannot be reached", () => {
    expect((tName("dmTestUnreachable", "JDownloader 2", "no answer within 10 s") as Record<string, string>).en).toBe(
      "JDownloader 2 cannot be reached: no answer within 10 s",
    );
  });

  it("keeps a key without placeholders as it is", () => {
    expect((tName("dmTest") as Record<string, string>).en).toBe("Test connection");
  });
});
