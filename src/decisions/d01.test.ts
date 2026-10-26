// Core decision D-01 (accepted 2026-10-22): one adapter for every download program — JDownloader, qBittorrent,
// Transmission, Deluge, SABnzbd, NZBGet, aria2 and pyLoad run through this adapter, each as a driver behind the same
// interface; a new program is one more driver, the core stays. krobi 2026-09-28 21:10: "of course one adapter that can
// do all of them, not several — that was always the concept" · 21:13: "it is basically about the right structure, so
// that new downloaders can simply be added later".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverDeps, ProgramConfig } from "../lib/core/model";
import { CATALOG } from "../lib/programs/catalog";
import { findProgram, PROGRAMS } from "../lib/programs/registry";

const CFG: ProgramConfig = {
  type: "",
  name: "guard",
  host: "192.0.2.1",
  port: 0,
  https: false,
  path: "",
  username: "user@example.com",
  password: "pw",
  apiKey: "key",
  device: "dev",
  deviceId: "dev1",
};
const DEPS: DriverDeps = {
  setTimeout: () => undefined,
  clearTimeout: () => undefined,
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
};

describe("D-01 one adapter for every download program", () => {
  it("knows all eight programs", () => {
    const labels = new Set(CATALOG.map(p => p.label));
    expect([...labels]).toEqual(
      expect.arrayContaining([
        "JDownloader 2",
        "qBittorrent",
        "Transmission",
        "Deluge",
        "SABnzbd",
        "NZBGet",
        "aria2",
        "pyLoad",
      ]),
    );
  });

  it("reaches every program through a driver behind the one driver interface", () => {
    expect(PROGRAMS.map(p => p.type)).toEqual(CATALOG.map(p => p.type));
    for (const info of CATALOG) {
      const entry = findProgram(info.type);
      expect(entry, info.type).toBeDefined();
      const driver = entry!.create({ ...CFG, type: info.type }, DEPS);
      expect(driver.type, info.type).toBe(info.type);
      expect(driver.capabilities, info.type).toBeInstanceOf(Set);
      expect(typeof driver.poll, info.type).toBe("function");
      expect(typeof driver.command, info.type).toBe("function");
      expect(typeof driver.close, info.type).toBe("function");
    }
  });

  it("keeps the core free of program code — it knows the programs only through the catalog", () => {
    const core = join(process.cwd(), "src", "lib", "core");
    const sources = readdirSync(core).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(join(core, file), "utf8");
      const programImports = [...text.matchAll(/from\s+["'](\.\.\/programs\/[^"']+)["']/g)].map(m => m[1]);
      expect(
        programImports.filter(p => p !== "../programs/catalog"),
        file,
      ).toEqual([]);
    }
  });
});
