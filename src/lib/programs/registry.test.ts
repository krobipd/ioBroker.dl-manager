import { findProgram, PROGRAMS, type ProgramConfig } from "./registry";

const deps = {
  setTimeout: (): undefined => undefined,
  clearTimeout: (): void => undefined,
  log: { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined },
};
const row = (type: string): ProgramConfig => ({
  type,
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
});

describe("registry", () => {
  it("has each program type once, and each builds a driver of its own type", () => {
    const types = PROGRAMS.map(p => p.type);
    expect(new Set(types).size).toBe(types.length);
    for (const p of PROGRAMS) {
      expect(findProgram(p.type)?.create(row(p.type), deps).type).toBe(p.type);
    }
  });

  it("knows JDownloader (local API), which needs only the host", () => {
    expect(findProgram("jdownloader")?.needs).toEqual(["host"]);
  });

  it("knows qBittorrent (login or API key, so only the host is required)", () => {
    expect(findProgram("qbittorrent")?.needs).toEqual(["host"]);
  });

  it("knows Transmission (user and password optional)", () => {
    expect(findProgram("transmission")?.needs).toEqual(["host"]);
  });

  it("knows Deluge (password only — the web UI has no user)", () => {
    expect(findProgram("deluge")?.needs).toEqual(["host", "password"]);
  });

  it("knows SABnzbd, which needs the API key", () => {
    expect(findProgram("sabnzbd")?.needs).toEqual(["host", "apiKey"]);
  });

  it("knows NZBGet (user and password optional — NZBGet can run without)", () => {
    expect(findProgram("nzbget")?.needs).toEqual(["host"]);
  });

  it("knows aria2 (the RPC secret is optional)", () => {
    expect(findProgram("aria2")?.needs).toEqual(["host"]);
  });

  it("knows pyLoad (API key, or user and password on builds before 0.5.0b3.dev97)", () => {
    expect(findProgram("pyload")?.needs).toEqual(["host"]);
  });

  it("returns nothing for an unknown type", () => {
    expect(findProgram("emule")).toBeUndefined();
  });
});
