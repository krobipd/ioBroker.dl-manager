import { describe, expect, it } from "vitest";
import { baseUrl, CATALOG, catalogEntry, effectiveEndpoint, needsOf, programInfo } from "./catalog";
import { PROGRAMS } from "./registry";

type Endpoint = { host: string; port: number; https: boolean; path: string };
const row = (over: Partial<Endpoint> = {}): Endpoint => ({
  host: "nas",
  port: 0,
  https: false,
  path: "",
  ...over,
});

describe("catalog", () => {
  it("has one registry entry per catalog type, in the same order", () => {
    expect(PROGRAMS.map(p => p.type)).toEqual(CATALOG.map(p => p.type));
  });

  it("knows every type once", () => {
    expect(new Set(CATALOG.map(p => p.type)).size).toBe(CATALOG.length);
  });

  it("finds a known type and nothing for an unknown or inherited name", () => {
    expect(programInfo("deluge")?.port).toBe(8112);
    expect(programInfo("emule")).toBeUndefined();
    expect(programInfo("constructor")).toBeUndefined();
  });

  it("throws for a type the code names but the catalog lacks", () => {
    expect(() => catalogEntry("nope" as never)).toThrow(/no entry for nope/);
  });

  it("derives the required fields from the login", () => {
    expect(needsOf(catalogEntry("jdownloader"))).toEqual(["host"]);
    expect(needsOf(catalogEntry("jdownloader-cloud"))).toEqual(["username", "password", "device"]);
    expect(needsOf(catalogEntry("deluge"))).toEqual(["host", "password"]);
    expect(needsOf(catalogEntry("sabnzbd"))).toEqual(["host", "apiKey"]);
    for (const t of ["qbittorrent", "transmission", "nzbget", "aria2", "pyload"] as const) {
      expect(needsOf(catalogEntry(t))).toEqual(["host"]);
    }
  });
});

describe("effectiveEndpoint", () => {
  it("takes the program's port and path when the row leaves them empty", () => {
    expect(effectiveEndpoint(row(), catalogEntry("transmission"))).toEqual({ port: 9091, path: "/transmission/rpc" });
  });

  it("takes the row's own port and path, with a leading and no trailing slash", () => {
    expect(effectiveEndpoint(row({ port: 443, path: "qb/" }), catalogEntry("qbittorrent"))).toEqual({
      port: 443,
      path: "/qb",
    });
  });

  it("reads a path of only slashes or blanks as empty", () => {
    expect(effectiveEndpoint(row({ path: " / " }), catalogEntry("aria2")).path).toBe("/jsonrpc");
    expect(effectiveEndpoint(row({ path: "//" }), catalogEntry("deluge")).path).toBe("");
  });
});

describe("baseUrl", () => {
  it("builds http and https", () => {
    expect(baseUrl(row(), catalogEntry("deluge"))).toBe("http://nas:8112");
    expect(baseUrl(row({ https: true, port: 8443, path: "/dl" }), catalogEntry("deluge"))).toBe("https://nas:8443/dl");
  });

  it("builds ws and wss", () => {
    expect(baseUrl(row(), catalogEntry("aria2"), "ws")).toBe("ws://nas:6800/jsonrpc");
    expect(baseUrl(row({ https: true }), catalogEntry("aria2"), "ws")).toBe("wss://nas:6800/jsonrpc");
  });
});
