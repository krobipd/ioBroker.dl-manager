import { routeState, type RouteTarget } from "./commands";
import type { Capability, ExtraDefinition } from "./model";

const EXTRAS: ExtraDefinition[] = [
  { id: "recheck", level: "item", type: "boolean", role: "button", write: true, read: false, nameKey: "remove" },
  { id: "forceStart", level: "item", type: "boolean", role: "switch", write: true, read: true, nameKey: "paused" },
  { id: "restart", level: "program", type: "boolean", role: "button", write: true, read: false, nameKey: "add" },
  { id: "label", level: "item", type: "string", role: "text", write: false, read: true, nameKey: "category" },
];
const ALL: Capability[] = ["globalPause", "itemPause", "itemRemove", "add", "speedLimit", "uploadLimit", "altSpeed"];

const target = (caps: Capability[] = ALL): RouteTarget => ({
  capabilities: new Set(caps),
  extras: EXTRAS,
  itemKey: ch => (ch === "11112222" ? "aaaa11112222" : undefined),
});
const lookup =
  (caps?: Capability[]) =>
  (program: string): RouteTarget | undefined =>
    program === "qbittorrent-nas" ? target(caps) : undefined;

describe("routeState", () => {
  it("routes the adapter-wide pause switch", () => {
    expect(routeState("summary.pauseAll", true, lookup())).toEqual({ kind: "pauseAll", on: true });
    expect(routeState("summary.pauseAll", false, lookup())).toEqual({ kind: "pauseAll", on: false });
  });

  it("routes program switches and limits without confirming them", () => {
    const r = (id: string, v: ioBroker.StateValue): unknown => routeState(`qbittorrent-nas.${id}`, v, lookup());
    expect(r("paused", true)).toEqual({
      kind: "command",
      program: "qbittorrent-nas",
      cmd: { kind: "pauseAll" },
      confirm: false,
    });
    expect(r("paused", false)).toMatchObject({ cmd: { kind: "resumeAll" } });
    expect(r("speedLimit", 2.5)).toMatchObject({ cmd: { kind: "setSpeedLimit", bps: 2_500_000 }, confirm: false });
    expect(r("speedLimit", 0)).toMatchObject({ cmd: { kind: "setSpeedLimit", bps: 0 } });
    expect(r("uploadLimit", 1)).toMatchObject({ cmd: { kind: "setUploadLimit", bps: 1_000_000 } });
    expect(r("altSpeed", true)).toMatchObject({ cmd: { kind: "setAltSpeed", on: true } });
  });

  it("routes add and confirms it", () => {
    expect(routeState("qbittorrent-nas.add", " magnet:?xt=1 ", lookup())).toEqual({
      kind: "command",
      program: "qbittorrent-nas",
      cmd: { kind: "add", url: "magnet:?xt=1" },
      confirm: true,
    });
    expect(routeState("qbittorrent-nas.add", "", lookup())).toEqual({ kind: "ignore" });
  });

  it("routes download switches and buttons with the program's raw key", () => {
    const d = "qbittorrent-nas.downloads.11112222";
    expect(routeState(`${d}.paused`, true, lookup())).toMatchObject({
      cmd: { kind: "pause", key: "aaaa11112222" },
      confirm: false,
    });
    expect(routeState(`${d}.paused`, false, lookup())).toMatchObject({ cmd: { kind: "resume", key: "aaaa11112222" } });
    expect(routeState(`${d}.remove`, true, lookup())).toMatchObject({
      cmd: { kind: "remove", key: "aaaa11112222" },
      confirm: true,
    });
  });

  it("routes writable extras, confirms buttons only", () => {
    const d = "qbittorrent-nas.downloads.11112222";
    expect(routeState(`${d}.recheck`, true, lookup())).toMatchObject({
      cmd: { kind: "extra", name: "recheck", key: "aaaa11112222" },
      confirm: true,
    });
    expect(routeState(`${d}.forceStart`, true, lookup())).toMatchObject({
      cmd: { kind: "extra", name: "forceStart", key: "aaaa11112222", value: true },
      confirm: false,
    });
    expect(routeState("qbittorrent-nas.restart", true, lookup())).toMatchObject({
      cmd: { kind: "extra", name: "restart" },
      confirm: true,
    });
  });

  it("ignores what it cannot route", () => {
    const ignore = { kind: "ignore" };
    expect(routeState("qbittorrent-nas.downloads.11112222.label", "x", lookup())).toEqual(ignore);
    expect(routeState("qbittorrent-nas.downloads.unknown.remove", true, lookup())).toEqual(ignore);
    expect(routeState("other-x.paused", true, lookup())).toEqual(ignore);
    expect(routeState("qbittorrent-nas.version", "1", lookup())).toEqual(ignore);
    expect(routeState("qbittorrent-nas.downloads.11112222.remove", false, lookup())).toEqual(ignore);
    expect(routeState("info.connection", true, lookup())).toEqual(ignore);
  });

  it("ignores a datapoint whose capability the program lacks", () => {
    expect(routeState("qbittorrent-nas.speedLimit", 1, lookup(["globalPause"]))).toEqual({ kind: "ignore" });
    expect(routeState("qbittorrent-nas.downloads.11112222.remove", true, lookup([]))).toEqual({ kind: "ignore" });
  });
});
