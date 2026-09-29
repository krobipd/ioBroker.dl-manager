import type { ProgramEntry } from "../programs/registry";
import { addressOf, parseMaxDownloads, parsePollInterval, parsePrograms, parseTreeScope } from "./config";

const ENTRIES: Record<string, ProgramEntry> = {
  qbittorrent: { type: "qbittorrent", needs: ["host", "username", "password"], create: () => undefined as never },
  sabnzbd: { type: "sabnzbd", needs: ["host", "apiKey"], create: () => undefined as never },
  "jdownloader-cloud": {
    type: "jdownloader-cloud",
    needs: ["username", "password", "device"],
    create: () => undefined as never,
  },
};
const find = (type: string): ProgramEntry | undefined => ENTRIES[type];
const decrypt = (v: string): string => (v ? `plain(${v})` : "");

describe("parsePrograms", () => {
  it("reads a complete row, decrypts password and API key, and derives the device id", () => {
    const [row] = parsePrograms(
      [
        {
          enabled: true,
          type: "qbittorrent",
          key: "nas",
          name: "NAS",
          host: "10.0.0.2",
          port: 8080,
          https: false,
          path: "",
          username: "admin",
          password: "enc",
        },
      ],
      decrypt,
      find,
    );
    expect(row.id).toBe("qbittorrent-nas");
    expect(row.problem).toBe("");
    expect(row.enabled).toBe(true);
    expect(row.cfg).toMatchObject({
      host: "10.0.0.2",
      port: 8080,
      username: "admin",
      password: "plain(enc)",
      apiKey: "",
    });
  });

  it("names the missing field of an incomplete row", () => {
    const rows = parsePrograms(
      [
        { enabled: true, type: "sabnzbd", key: "a", host: "h" },
        { enabled: true, type: "qbittorrent", key: "b", username: "u", password: "p" },
      ],
      decrypt,
      find,
    );
    expect(rows.map(r => r.problem)).toEqual(["API key missing", "host missing"]);
  });

  it("marks an unknown program type, keeps its device id", () => {
    const [row] = parsePrograms([{ enabled: true, type: "emule", key: "x", host: "h" }], decrypt, find);
    expect(row.id).toBe("emule-x");
    expect(row.problem).toBe("unknown program type: emule");
  });

  it("uses the type as device id while the key is empty, and cleans a hand-edited key", () => {
    const rows = parsePrograms(
      [
        { enabled: true, type: "sabnzbd", key: "", host: "h", apiKey: "k" },
        { enabled: true, type: "sabnzbd", key: "Mein NAS.2", host: "h2", apiKey: "k" },
      ],
      decrypt,
      find,
    );
    expect(rows.map(r => r.id)).toEqual(["sabnzbd", "sabnzbd-mein-nas-2"]);
  });

  it("reports the second row with the same device id as a duplicate", () => {
    const rows = parsePrograms(
      [
        { enabled: true, type: "sabnzbd", key: "a", host: "h", apiKey: "k" },
        { enabled: true, type: "sabnzbd", key: "a", host: "h2", apiKey: "k" },
      ],
      decrypt,
      find,
    );
    expect(rows.map(r => r.problem)).toEqual(["", "device id sabnzbd-a is used twice"]);
  });

  it("keeps a disabled row without judging it", () => {
    const [row] = parsePrograms([{ enabled: false, type: "sabnzbd", key: "a" }], decrypt, find);
    expect(row.enabled).toBe(false);
    expect(row.problem).toBe("");
  });

  it("survives garbage from native", () => {
    expect(parsePrograms(undefined, decrypt, find)).toEqual([]);
    expect(parsePrograms("x", decrypt, find)).toEqual([]);
    const rows = parsePrograms([null, 7, { type: 5, key: {}, port: "80" }], decrypt, find);
    expect(rows).toHaveLength(1);
    expect(rows[0].problem).toBe("program type missing");
    expect(rows[0].cfg.port).toBe(0);
  });

  it("never decrypts an empty secret, and takes only real ports and a real https switch", () => {
    const rows = parsePrograms(
      [
        { type: "qbittorrent", key: "a", host: "h", username: "u", password: "", port: 70000, https: "yes" },
        { type: "qbittorrent", key: "b", host: "h", username: "u", password: "p", port: -5 },
        { type: "", key: "c" },
      ],
      v => (v ? `plain(${v})` : "garbage"),
      find,
    );
    expect(rows[0].cfg.password).toBe("");
    expect(rows[0].cfg.port).toBe(0);
    expect(rows[0].cfg.https).toBe(false);
    expect(rows[1].cfg.port).toBe(0);
    expect(rows[2].id).toBe("program-c");
  });

  it("lets a failing decrypt through as an empty secret", () => {
    const [row] = parsePrograms(
      [{ enabled: true, type: "sabnzbd", key: "a", host: "h", apiKey: "x" }],
      () => {
        throw new Error("bad secret");
      },
      find,
    );
    expect(row.problem).toBe("API key missing");
  });

  it("does not need a host for My.JDownloader", () => {
    const [row] = parsePrograms(
      [{ enabled: true, type: "jdownloader-cloud", key: "", username: "me@x", password: "p", device: "PC" }],
      decrypt,
      find,
    );
    expect(row.problem).toBe("");
  });
});

describe("addressOf", () => {
  it("identifies a program by its URL or, without a host, by account and device", () => {
    const base = { username: "", device: "", path: "", https: false, port: 0 };
    expect(addressOf({ ...base, host: "10.0.0.2", port: 8080, path: "/qb" })).toBe("http://10.0.0.2:8080/qb");
    expect(addressOf({ ...base, host: "nas", https: true })).toBe("https://nas");
    expect(addressOf({ ...base, host: "", username: "me@x", device: "PC" })).toBe("me@x/PC");
  });
});

describe("parsePollInterval", () => {
  it("returns milliseconds and never less than 2 s", () => {
    expect(parsePollInterval(10)).toBe(10_000);
    expect(parsePollInterval(1)).toBe(2_000);
    expect(parsePollInterval("15")).toBe(15_000);
    expect(parsePollInterval(undefined)).toBe(10_000);
    expect(parsePollInterval(Number.NaN)).toBe(10_000);
    expect(parsePollInterval(1e9)).toBe(3_600_000);
  });
});

describe("parseTreeScope", () => {
  it("takes the three known scopes and falls back to all", () => {
    expect(parseTreeScope("all")).toBe("all");
    expect(parseTreeScope("withoutCompleted")).toBe("withoutCompleted");
    expect(parseTreeScope("unfinished")).toBe("unfinished");
    expect(parseTreeScope("unfinishedx")).toBe("all");
    expect(parseTreeScope(undefined)).toBe("all");
    expect(parseTreeScope(3)).toBe("all");
  });
});

describe("parseMaxDownloads", () => {
  it("takes whole numbers from 0 to 1000, 100 when unusable", () => {
    expect(parseMaxDownloads(5)).toBe(5);
    expect(parseMaxDownloads(0)).toBe(0);
    expect(parseMaxDownloads(1000)).toBe(1000);
    expect(parseMaxDownloads("25")).toBe(25);
    expect(parseMaxDownloads(7.9)).toBe(7);
    expect(parseMaxDownloads(1001)).toBe(1000);
    expect(parseMaxDownloads(-3)).toBe(0);
    expect(parseMaxDownloads("")).toBe(100);
    expect(parseMaxDownloads(undefined)).toBe(100);
    expect(parseMaxDownloads(Number.NaN)).toBe(100);
    expect(parseMaxDownloads("abc")).toBe(100);
  });
});
