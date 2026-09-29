import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, unknown>;

describe("manifest — the device manager can talk to the adapter", () => {
  const common = read("io-package.json").common as Record<string, unknown>;

  it("declares deviceManager in supportedMessages — without it no dm message arrives, and no boot test notices", () => {
    expect(common.supportedMessages).toEqual({ deviceManager: true });
  });

  it("carries no messagebox switch any more (supportedMessages decides)", () => {
    expect(common).not.toHaveProperty("messagebox");
  });

  it("ships dm-utils as a runtime dependency and puts the device manager on the settings page", () => {
    expect((read("package.json").dependencies as Record<string, string>)["@iobroker/dm-utils"]).toBeDefined();
    const items = (read("admin/jsonConfig.json").items ?? {}) as Record<string, { type?: string }>;
    expect(Object.values(items).filter(i => i.type === "deviceManager")).toHaveLength(1);
    expect(Object.values(items).filter(i => i.type === "table")).toHaveLength(0);
  });
});
