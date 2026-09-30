import type { ProgramEntry } from "./model";
import {
  addressOf,
  legacyId,
  parseMaxDownloads,
  parsePollInterval,
  parsePrograms,
  parseTreeScope,
  sameProgram,
} from "./config";

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

describe("parsePrograms", () => {
  it("reads a complete row with its stored device id", () => {
    const [row] = parsePrograms(
      [
        {
          enabled: true,
          type: "qbittorrent",
          id: "qbittorrent-nas",
          name: "NAS",
          host: "10.0.0.2",
          port: 8080,
          https: false,
          path: "",
          username: "admin",
          password: "enc",
          deviceId: "",
        },
      ],
      find,
    );
    expect(row.id).toBe("qbittorrent-nas");
    expect(row.problem).toBe("");
    expect(row.enabled).toBe(true);
    expect(row.cfg).toMatchObject({
      host: "10.0.0.2",
      port: 8080,
      username: "admin",
      password: "enc",
      apiKey: "",
    });
  });

  it("names the missing field of an incomplete row", () => {
    const rows = parsePrograms(
      [
        { enabled: true, type: "sabnzbd", key: "a", host: "h" },
        { enabled: true, type: "qbittorrent", key: "b", username: "u", password: "p" },
      ],
      find,
    );
    expect(rows.map(r => r.problem)).toEqual(["API key missing", "host missing"]);
  });

  it("marks an unknown program type, keeps its device id", () => {
    const [row] = parsePrograms([{ enabled: true, type: "emule", id: "emule-x", host: "h" }], find);
    expect(row.id).toBe("emule-x");
    expect(row.problem).toBe("unknown program type: emule");
  });

  it("takes a row without a stored id by the id it had up to 0.2.0, and ignores a hand-edited id that is no id", () => {
    const rows = parsePrograms(
      [
        { enabled: true, type: "sabnzbd", key: "", host: "h", apiKey: "k" },
        { enabled: true, type: "sabnzbd", key: "Mein NAS.2", host: "h2", apiKey: "k" },
        { enabled: true, type: "sabnzbd", id: "Not An Id", key: "x", host: "h3", apiKey: "k" },
      ],
      find,
    );
    expect(rows.map(r => r.id)).toEqual(["sabnzbd", "sabnzbd-mein-nas-2", "sabnzbd-x"]);
  });

  it("marks a row whose id waits for its My.JDownloader instance", () => {
    const rows = parsePrograms(
      [
        { enabled: true, type: "sabnzbd", id: "sabnzbd-nas", host: "h", apiKey: "k" },
        {
          enabled: true,
          type: "jdownloader-cloud",
          id: "jdownloader-cloud",
          idPending: true,
          username: "u",
          password: "p",
          device: "PC",
        },
      ],
      find,
    );
    expect(rows.map(r => r.scheme)).toEqual([true, false]);
    expect(rows[1].cfg.deviceId).toBe("");
  });

  it("reports the second row with the same device id as a duplicate", () => {
    const rows = parsePrograms(
      [
        { enabled: true, type: "sabnzbd", id: "sabnzbd-a", host: "h", apiKey: "k" },
        { enabled: true, type: "sabnzbd", id: "sabnzbd-a", host: "h2", apiKey: "k" },
      ],
      find,
    );
    expect(rows.map(r => r.problem)).toEqual(["", "device id sabnzbd-a is used twice"]);
  });

  it("reports the second row that reaches the same program, whatever its key", () => {
    const rows = parsePrograms(
      [
        { enabled: true, type: "sabnzbd", key: "a", host: "NAS", apiKey: "k" },
        { enabled: true, type: "sabnzbd", key: "b", host: "nas", port: 8080, apiKey: "k" },
        { enabled: true, type: "sabnzbd", key: "c", host: "nas", port: 8081, apiKey: "k" },
      ],
      find,
    );
    expect(rows.map(r => r.problem)).toEqual(["", "same program as sabnzbd-a", ""]);
  });

  it("compares only with enabled, sound rows", () => {
    const rows = parsePrograms(
      [
        { enabled: false, type: "sabnzbd", key: "off", host: "nas", apiKey: "k" },
        { enabled: true, type: "sabnzbd", key: "broken", host: "nas" },
        { enabled: true, type: "sabnzbd", key: "a", host: "nas", apiKey: "k" },
      ],
      find,
    );
    expect(rows.map(r => r.problem)).toEqual(["", "API key missing", ""]);
  });

  it("hands the registry entry only to a row that can run", () => {
    const rows = parsePrograms(
      [
        { enabled: true, type: "sabnzbd", key: "a", host: "h", apiKey: "k" },
        { enabled: true, type: "sabnzbd", key: "b", host: "h2" },
        { enabled: false, type: "sabnzbd", key: "c", host: "h3", apiKey: "k" },
        { enabled: true, type: "emule", key: "d", host: "h4" },
      ],
      find,
    );
    expect(rows.map(r => r.entry?.type)).toEqual(["sabnzbd", undefined, undefined, undefined]);
  });

  it("keeps a disabled row without judging it", () => {
    const [row] = parsePrograms([{ enabled: false, type: "sabnzbd", key: "a" }], find);
    expect(row.enabled).toBe(false);
    expect(row.problem).toBe("");
  });

  it("survives garbage from native", () => {
    expect(parsePrograms(undefined, find)).toEqual([]);
    expect(parsePrograms("x", find)).toEqual([]);
    const rows = parsePrograms([null, 7, { type: 5, key: {}, port: "80" }], find);
    expect(rows).toHaveLength(1);
    expect(rows[0].problem).toBe("program type missing");
    expect(rows[0].cfg.port).toBe(0);
  });

  it("takes only real ports and a real https switch", () => {
    const rows = parsePrograms(
      [
        { type: "qbittorrent", key: "a", host: "h", username: "u", password: "", port: 70000, https: "yes" },
        { type: "qbittorrent", key: "b", host: "h", username: "u", password: "p", port: -5 },
        { type: "", key: "c" },
      ],
      find,
    );
    expect(rows[0].cfg.password).toBe("");
    expect(rows[0].cfg.port).toBe(0);
    expect(rows[0].cfg.https).toBe(false);
    expect(rows[1].cfg.port).toBe(0);
    expect(rows[2].id).toBe("program-c");
  });

  it("does not need a host for My.JDownloader", () => {
    const [row] = parsePrograms(
      [{ enabled: true, type: "jdownloader-cloud", key: "", username: "me@x", password: "p", device: "PC" }],
      find,
    );
    expect(row.problem).toBe("");
  });
});

describe("legacyId", () => {
  it("is the device id up to 0.2.0: type and ID column", () => {
    expect(legacyId({ type: "qbittorrent", key: "NAS 1" })).toBe("qbittorrent-nas-1");
    expect(legacyId({ type: "jdownloader-cloud", key: "" })).toBe("jdownloader-cloud");
    expect(legacyId({ type: " ", key: "x" })).toBe("program-x");
  });
});

describe("addressOf", () => {
  const base = { type: "qbittorrent", username: "", device: "", path: "", https: false, port: 0 };

  it("is the URL the program is reached at, its default port and path filled in", () => {
    expect(addressOf({ ...base, host: "10.0.0.2", port: 8081, path: "qb/" })).toBe("http://10.0.0.2:8081/qb");
    expect(addressOf({ ...base, host: "nas", https: true })).toBe("https://nas:8080");
    expect(addressOf({ ...base, type: "transmission", host: "nas" })).toBe("http://nas:9091/transmission/rpc");
  });

  it("is account and device without a host", () => {
    expect(addressOf({ ...base, type: "jdownloader-cloud", host: "", username: "me@x", device: "PC" })).toBe("me@x/PC");
  });

  it("leaves the port out for a type the adapter does not know", () => {
    expect(addressOf({ ...base, type: "emule", host: "nas" })).toBe("http://nas");
    expect(addressOf({ ...base, type: "emule", host: "nas", port: 4662 })).toBe("http://nas:4662");
  });
});

describe("sameProgram", () => {
  const base = { type: "deluge", username: "", device: "", path: "", https: false, port: 0, host: "nas" };

  it("sees the same host, port and path as one program, whatever the case, scheme or spelled-out default", () => {
    expect(sameProgram(base, { ...base, host: "NAS", port: 8112, https: true, path: "/" })).toBe(true);
  });

  it("sees another port, path or host as another program", () => {
    expect(sameProgram(base, { ...base, port: 8113 })).toBe(false);
    expect(sameProgram(base, { ...base, path: "/b" })).toBe(false);
    expect(sameProgram(base, { ...base, host: "nas2" })).toBe(false);
  });

  it("sees two programs of different types on their own default ports as two programs", () => {
    expect(sameProgram({ ...base, type: "qbittorrent" }, { ...base, type: "transmission" })).toBe(false);
  });

  it("compares cloud accounts by e-mail (any case) and device", () => {
    const cloud = { ...base, type: "jdownloader-cloud", host: "", username: "Me@X", device: "PC" };
    expect(sameProgram(cloud, { ...cloud, username: "me@x" })).toBe(true);
    expect(sameProgram(cloud, { ...cloud, device: "Laptop" })).toBe(false);
  });
});

describe("parsePollInterval", () => {
  it("returns milliseconds and never less than 10 s — a value stored before 0.3.1 below that runs at 10 s", () => {
    expect(parsePollInterval(10)).toBe(10_000);
    expect(parsePollInterval(1)).toBe(10_000);
    expect(parsePollInterval(9)).toBe(10_000);
    expect(parsePollInterval(11)).toBe(11_000);
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
