import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceIcon, ICON_BY_TYPE, ICON_URI_PREFIX, normaliseLineEndings } from "./device-icons";
import { PROGRAMS } from "./programs/registry";

const DIR = join(__dirname, "..", "..", "admin", "icons");
const decode = (uri: string): string => Buffer.from(uri.slice(ICON_URI_PREFIX.length), "base64").toString("utf8");

describe("device pictograms (CLAUDE_PATTERNS.md § Geräte-Piktogramme)", () => {
  it("embeds the file's bytes as an inline data URI", () => {
    const uri = deviceIcon("qbittorrent");
    expect(uri?.startsWith(ICON_URI_PREFIX)).toBe(true);
    expect(decode(String(uri))).toBe(readFileSync(join(DIR, "torrent.svg"), "utf8"));
  });

  it("gives every program type its file and never a path", () => {
    for (const p of PROGRAMS) {
      const uri = deviceIcon(p.type);
      expect([p.type, uri?.startsWith(ICON_URI_PREFIX)]).toEqual([p.type, true]);
      expect(decode(String(uri))).toBe(readFileSync(join(DIR, ICON_BY_TYPE[p.type]), "utf8"));
    }
  });

  it("shares one file among the torrent programs and one among the usenet programs", () => {
    expect(ICON_BY_TYPE.transmission).toBe(ICON_BY_TYPE.qbittorrent);
    expect(ICON_BY_TYPE.deluge).toBe(ICON_BY_TYPE.qbittorrent);
    expect(ICON_BY_TYPE.nzbget).toBe(ICON_BY_TYPE.sabnzbd);
    expect(ICON_BY_TYPE["jdownloader-cloud"]).toBe(ICON_BY_TYPE.jdownloader);
  });

  it("gives the same URI for a CRLF checkout (Windows runner)", () => {
    const svg = readFileSync(join(DIR, "aria2.svg"), "utf8");
    expect(normaliseLineEndings(svg.replace(/\n/g, "\r\n"))).toBe(svg.replace(/\r\n/g, "\n"));
  });

  it("returns the same value every time", () => {
    expect(deviceIcon("pyload")).toBe(deviceIcon("pyload"));
  });

  it("leaves an unknown or inherited type without a pictogram", () => {
    expect(deviceIcon("emule")).toBeUndefined();
    expect(deviceIcon(undefined)).toBeUndefined();
    expect(deviceIcon("constructor")).toBeUndefined();
    expect(deviceIcon("toString")).toBeUndefined();
  });

  it("has a file for every map entry and no orphan file", () => {
    const files = readdirSync(DIR)
      .filter(f => f.endsWith(".svg"))
      .sort();
    expect([...new Set(Object.values(ICON_BY_TYPE))].sort()).toEqual(files);
  });

  it("draws only with currentColor or none — a fixed colour vanishes in one theme family", () => {
    for (const f of readdirSync(DIR).filter(n => n.endsWith(".svg"))) {
      const svg = readFileSync(join(DIR, f), "utf8");
      const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map(m => m[1]);
      expect([f, colours.filter(c => c !== "currentColor" && c !== "none")]).toEqual([f, []]);
      expect([f, /#[0-9a-f]{3,8}\b|rgb\(|\bblack\b|\bwhite\b/i.test(svg)]).toEqual([f, false]);
    }
  });

  it("uses no element the object browser renders 0 px wide", () => {
    for (const f of readdirSync(DIR).filter(n => n.endsWith(".svg"))) {
      const inner = readFileSync(join(DIR, f), "utf8").replace(/^<svg[^>]*>/, "");
      expect([f, /<(rect|image|use|svg|foreignObject)\b/.test(inner)]).toEqual([f, false]);
    }
  });

  it("draws for a 64 box with stroke 4", () => {
    for (const f of readdirSync(DIR).filter(n => n.endsWith(".svg"))) {
      const root = /^<svg[^>]*>/.exec(readFileSync(join(DIR, f), "utf8"))?.[0] ?? "";
      expect([f, root.includes('viewBox="0 0 64 64"') && root.includes('stroke-width="4"')]).toEqual([f, true]);
    }
  });

  it("the CRLF proof: every file rewritten with CRLF still gives the same URIs", () => {
    const files = readdirSync(DIR).filter(n => n.endsWith(".svg"));
    const before = Object.fromEntries(files.map(f => [f, readFileSync(join(DIR, f), "utf8")]));
    try {
      for (const f of files) {
        writeFileSync(join(DIR, f), before[f].replace(/\n/g, "\r\n"));
      }
      for (const f of files) {
        const svg = normaliseLineEndings(readFileSync(join(DIR, f), "utf8"));
        expect(svg).toBe(before[f]);
      }
    } finally {
      for (const f of files) {
        writeFileSync(join(DIR, f), before[f]);
      }
    }
  });
});
