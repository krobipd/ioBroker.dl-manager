import { readDevices, type DevicesAdapter } from "./devices";

const adapter = (devices: Record<string, Partial<ioBroker.Object>>): DevicesAdapter =>
  ({
    namespace: "dl-manager.0",
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    getForeignObjects: (pattern: string, type: string) =>
      Promise.resolve(structuredClone(pattern === "dl-manager.0.*" && type === "device" ? devices : {})),
  }) as unknown as DevicesAdapter;

describe("readDevices", () => {
  it("lists the program devices at the root with their native", async () => {
    const found = await readDevices(
      adapter({
        "dl-manager.0.transmission-nas": { native: { type: "transmission", address: "http://nas:9091" } },
        "dl-manager.0.jdownloader-cloud": { native: { type: "jdownloader-cloud", movingTo: "dl-manager.0.jd-1" } },
      }),
    );
    expect([...found.keys()]).toEqual(["transmission-nas", "jdownloader-cloud"]);
    expect(found.get("jdownloader-cloud")?.movingTo).toBe("dl-manager.0.jd-1");
  });

  it("never takes the instance's own roots, a device below the root or one the adapter did not write", async () => {
    const found = await readDevices(
      adapter({
        "dl-manager.0.summary": { native: { type: "summary" } },
        "dl-manager.0.info": { native: { type: "info" } },
        "dl-manager.0.programs": { native: { type: "x" } },
        "dl-manager.0.qbittorrent-nas.sub": { native: { type: "qbittorrent" } },
        "dl-manager.0.handmade": { native: {} },
        "dl-manager.0.nonative": {},
      }),
    );
    expect([...found.keys()]).toEqual([]);
  });
});
