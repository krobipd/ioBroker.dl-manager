import type { ProgramRow } from "./config";
import { continues, planHandover, type DeviceNative } from "./devices";

const r = (type: string, key: string, host = "h1", over: Partial<ProgramRow> = {}): ProgramRow => ({
  id: `${type}-${key}`,
  enabled: true,
  problem: "",
  cfg: {
    type,
    key,
    name: "",
    host,
    port: 0,
    https: false,
    path: "",
    username: "u",
    password: "",
    apiKey: "",
    device: "d",
  },
  ...over,
});

describe("continues", () => {
  const r = (type: string, key: string, host = "h1"): ProgramRow => ({
    id: `${type}-${key}`,
    enabled: true,
    problem: "",
    cfg: {
      type,
      key,
      name: "",
      host,
      port: 0,
      https: false,
      path: "",
      username: "u",
      password: "",
      apiKey: "",
      device: "d",
    },
  });

  it("takes the same type at the same address", () => {
    expect(continues(r("deluge", "new"), "deluge-old", { type: "deluge", address: "http://h1:8112" })).toBe(true);
    expect(continues(r("deluge", "new"), "deluge-old", { type: "deluge", address: "http://h2:8112" })).toBe(false);
  });

  it("takes the other JDownloader connection only under the same ID", () => {
    expect(continues(r("jdownloader-cloud", "a", ""), "jdownloader-a", { type: "jdownloader" })).toBe(true);
    expect(continues(r("jdownloader", "a"), "jdownloader-cloud-a", { type: "jdownloader-cloud" })).toBe(true);
    expect(continues(r("jdownloader-cloud", "b", ""), "jdownloader-a", { type: "jdownloader" })).toBe(false);
  });

  it("never lets another program family take a device, whatever the ID", () => {
    expect(continues(r("transmission", "a"), "qbittorrent-a", { type: "qbittorrent" })).toBe(false);
    expect(continues(r("jdownloader", "a"), "pyload-a", { type: "pyload" })).toBe(false);
    expect(continues(r("jdownloader", "a"), "x-a", {})).toBe(false);
  });
});

describe("planHandover", () => {
  const devices = (entries: [string, DeviceNative][]): Map<string, DeviceNative> => new Map(entries);

  it("keeps a device its row still names, hands one on and lets the rest go", () => {
    const plan = planHandover(
      [r("deluge", "a"), r("deluge", "new", "h2")],
      devices([
        ["deluge-a", { type: "deluge", address: "http://h1:8112" }],
        ["deluge-old", { type: "deluge", address: "http://h2:8112" }],
        ["deluge-gone", { type: "deluge", address: "http://h9:8112" }],
      ]),
    );
    expect([...plan.carries]).toEqual([["deluge-new", "deluge-old"]]);
    expect(plan.orphans).toEqual(["deluge-gone"]);
  });

  it("hands a device only to an enabled, sound row without a device of its own, one device per row", () => {
    const old = devices([
      ["deluge-o1", { type: "deluge", address: "http://h1:8112" }],
      ["deluge-o2", { type: "deluge", address: "http://h1:8112" }],
    ]);
    expect(planHandover([r("deluge", "n")], old)).toEqual({
      carries: new Map([["deluge-n", "deluge-o1"]]),
      orphans: ["deluge-o2"],
    });
    expect(planHandover([r("deluge", "n", "h1", { enabled: false })], old).orphans).toEqual(["deluge-o1", "deluge-o2"]);
    expect(planHandover([r("deluge", "n", "h1", { problem: "x" })], old).orphans).toEqual(["deluge-o1", "deluge-o2"]);
    const own = devices([...old, ["deluge-n", { type: "deluge", address: "http://h1:8112" }]]);
    expect(planHandover([r("deluge", "n")], own).orphans).toEqual(["deluge-o1", "deluge-o2"]);
  });
});
