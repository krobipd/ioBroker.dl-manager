// Fleet master (.consistency-master/src/lib/data-file.test.ts) — never edit the copy in an adapter.
import type * as NodeFs from "node:fs";
import {
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DataFileSecrets,
  listDataFiles,
  readDataFile,
  removeDataFile,
  setAsideDataFile,
  writeDataFile,
} from "./data-file";

// the real file system, watched: the order of the flush and the rename is what a power cut decides on
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof NodeFs>();
  return {
    ...fs,
    fsyncSync: vi.fn(fs.fsyncSync),
    readdirSync: vi.fn(fs.readdirSync),
    renameSync: vi.fn(fs.renameSync),
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "data-file-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readDataFile", () => {
  it("reads nothing while there is no file yet", () => {
    expect(readDataFile(dir, "state.json")).toEqual({});
  });

  it("reads the value a write stored", () => {
    writeDataFile(dir, "state.json", { highest: 7, names: ["a"] });
    expect(readDataFile(dir, "state.json")).toEqual({ value: { highest: 7, names: ["a"] } });
  });

  it("says why a file without JSON is unusable", () => {
    writeFileSync(join(dir, "state.json"), "{ half", "utf8");
    const read = readDataFile(dir, "state.json");
    expect(read.value).toBeUndefined();
    expect(read.error).toMatch(/^no JSON: /);
  });

  it("says why a file that cannot be read is unusable", () => {
    mkdirSync(join(dir, "state.json"));
    const read = readDataFile(dir, "state.json");
    expect(read.value).toBeUndefined();
    expect(read.error).toMatch(/EISDIR/);
  });
});

describe("writeDataFile", () => {
  it("creates the folder, writes JSON and leaves no temporary file", () => {
    const sub = join(dir, "cache");
    writeDataFile(sub, "a.json", { on: true });
    expect(readFileSync(join(sub, "a.json"), "utf8")).toBe('{\n  "on": true\n}\n');
    expect(listDataFiles(sub)).toEqual(["a.json"]);
  });

  it("is readable for the owner only", () => {
    writeDataFile(dir, "secret.json", "token");
    // Windows knows a file only as read-only (0o444) or writable (0o666) — Node.js docs fs, "File modes"
    expect(statSync(join(dir, "secret.json")).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o600);
  });

  it("writes the temporary file to the disk before it renames it", () => {
    // rename(2) orders the name only — without fsync a power cut can leave the new name on an empty or half file
    vi.mocked(fsyncSync).mockClear();
    vi.mocked(renameSync).mockClear();
    writeDataFile(dir, "state.json", { a: 1 });
    expect(vi.mocked(fsyncSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fsyncSync).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(renameSync).mock.invocationCallOrder[0],
    );
  });

  it("leaves the old file whole while the new one is not complete", () => {
    // a crash before the rename: what was stored before is still there, whole — never a file written in place
    writeDataFile(dir, "state.json", { a: 1 });
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("power cut");
    });
    expect(() => writeDataFile(dir, "state.json", { a: 2 })).toThrow("power cut");
    expect(readDataFile(dir, "state.json")).toEqual({ value: { a: 1 } });
  });

  it("replaces the old content as a whole", () => {
    writeDataFile(dir, "state.json", { a: 1, b: 2 });
    writeDataFile(dir, "state.json", { a: 3 });
    expect(readDataFile(dir, "state.json")).toEqual({ value: { a: 3 } });
  });
});

// a cipher like the platform's: what it makes of a text shows none of it, and another key gives other characters
const cipherOf = (key: number): DataFileSecrets["cipher"] => ({
  encrypt: value => Buffer.from(Buffer.from(value, "utf8").map(byte => byte ^ key)).toString("hex"),
  decrypt: value => Buffer.from(Buffer.from(value, "hex").map(byte => byte ^ key)).toString("utf8"),
});
const secrets: DataFileSecrets = { cipher: cipherOf(0x5a), fields: ["token", "cookie"] };
const paired = {
  server: "srv-1",
  displays: [
    { name: "hall", token: "tok-hall-9f3", cookie: "ck-hall-77", expires: 1700 },
    { name: "kitchen", token: "tok-kitchen-1a2", cookie: null, expires: 1800 },
  ],
  bridge: { token: "tok-bridge-c4" },
};

describe("a data file with secrets", () => {
  it("stores no secret in clear text and every other value as it is", () => {
    writeDataFile(dir, "clients.json", paired, secrets);
    const raw = readFileSync(join(dir, "clients.json"), "utf8");
    for (const secret of ["tok-hall-9f3", "ck-hall-77", "tok-kitchen-1a2", "tok-bridge-c4"]) {
      expect(raw).not.toContain(secret);
    }
    const stored = JSON.parse(raw) as { server: string; displays: Record<string, unknown>[]; bridge: unknown };
    expect(stored.server).toBe("srv-1");
    expect(stored.displays[0].name).toBe("hall");
    expect(stored.displays[0].expires).toBe(1700);
    expect(Object.keys(stored.displays[0].token as object)).toEqual(["$encrypted"]);
    expect(Object.keys((stored.bridge as { token: object }).token)).toEqual(["$encrypted"]);
  });

  it("reads the clear values back, at any depth", () => {
    writeDataFile(dir, "clients.json", paired, secrets);
    expect(readDataFile(dir, "clients.json", secrets)).toEqual({ value: paired });
  });

  it("leaves a secret field without a text as it is", () => {
    writeDataFile(dir, "clients.json", paired, secrets);
    const stored = JSON.parse(readFileSync(join(dir, "clients.json"), "utf8")) as { displays: { cookie: unknown }[] };
    expect(stored.displays[1].cookie).toBeNull();
  });

  it("encrypts only the fields the caller names, by their whole name", () => {
    writeDataFile(dir, "clients.json", { token: "tok-1", tokenHint: "starts with t", name: "hall" }, secrets);
    const stored = JSON.parse(readFileSync(join(dir, "clients.json"), "utf8")) as Record<string, unknown>;
    expect(stored.tokenHint).toBe("starts with t");
    expect(stored.name).toBe("hall");
    expect(typeof stored.token).toBe("object");
  });

  it("does not change the value it is given", () => {
    const given = { token: "tok-1", list: [{ cookie: "ck-1" }] };
    writeDataFile(dir, "clients.json", given, secrets);
    expect(given).toEqual({ token: "tok-1", list: [{ cookie: "ck-1" }] });
  });

  it("reads a file from before, with its secrets in clear text, and writes it back encrypted at once", () => {
    writeDataFile(dir, "clients.json", paired);
    expect(readFileSync(join(dir, "clients.json"), "utf8")).toContain("tok-hall-9f3");
    expect(readDataFile(dir, "clients.json", secrets)).toEqual({ value: paired });
    const raw = readFileSync(join(dir, "clients.json"), "utf8");
    expect(raw).not.toContain("tok-hall-9f3");
    expect(raw).not.toContain("ck-hall-77");
    expect(readDataFile(dir, "clients.json", secrets)).toEqual({ value: paired });
  });

  it("does not write a file again whose secrets are all encrypted", () => {
    writeDataFile(dir, "clients.json", paired, secrets);
    vi.mocked(renameSync).mockClear();
    readDataFile(dir, "clients.json", secrets);
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });

  it("still gives the value when the file from before cannot be written back", () => {
    writeDataFile(dir, "clients.json", paired);
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("read-only disk");
    });
    expect(readDataFile(dir, "clients.json", secrets)).toEqual({ value: paired });
  });

  it("calls a file unusable whose secret was encrypted under another key — never missing, never empty", () => {
    writeDataFile(dir, "clients.json", paired, secrets);
    const read = readDataFile(dir, "clients.json", { cipher: cipherOf(0x21), fields: secrets.fields });
    expect(read.value).toBeUndefined();
    expect(read.error).toBe("secret field displays[0].token cannot be decrypted");
  });

  it("calls a file unusable whose cipher throws, and names the field only", () => {
    writeDataFile(dir, "clients.json", { bridge: { token: "tok-bridge-c4" } }, secrets);
    const broken: DataFileSecrets = {
      cipher: {
        encrypt: secrets.cipher.encrypt,
        decrypt: () => {
          throw new Error("bad decrypt of 7a6f");
        },
      },
      fields: secrets.fields,
    };
    expect(readDataFile(dir, "clients.json", broken)).toEqual({
      error: "secret field bridge.token cannot be decrypted",
    });
  });

  it("calls a file unusable whose secret decrypts to something that is no text", () => {
    const stored = { token: { $encrypted: secrets.cipher.encrypt("42") } };
    writeFileSync(join(dir, "clients.json"), JSON.stringify(stored), "utf8");
    expect(readDataFile(dir, "clients.json", secrets)).toEqual({ error: "secret field token cannot be decrypted" });
  });

  it("takes a secret field that holds a table for a table, not for a secret", () => {
    const table = { token: { hall: { token: "tok-hall-9f3" }, note: "per display" } };
    writeDataFile(dir, "clients.json", table, secrets);
    expect(readFileSync(join(dir, "clients.json"), "utf8")).not.toContain("tok-hall-9f3");
    expect(readDataFile(dir, "clients.json", secrets)).toEqual({ value: table });
  });

  it("takes for the stored form only an object with that one key and a text in it", () => {
    for (const table of [{ $encrypted: "7a6f", note: "per display" }, { $encrypted: 42 }]) {
      writeFileSync(join(dir, "clients.json"), JSON.stringify({ token: table }), "utf8");
      expect(readDataFile(dir, "clients.json", secrets)).toEqual({ value: { token: table } });
    }
  });

  it("reads a file without the secrets as it is stored", () => {
    writeDataFile(dir, "clients.json", { token: "tok-1" }, secrets);
    const read = readDataFile(dir, "clients.json");
    expect(Object.keys((read.value as { token: object }).token)).toEqual(["$encrypted"]);
  });
});

describe("setAsideDataFile", () => {
  it("keeps an unreadable file under another name instead of losing it to the next write", () => {
    writeFileSync(join(dir, "clients.json"), "{ half", "utf8");
    setAsideDataFile(dir, "clients.json", "clients.json.unreadable");
    expect(readDataFile(dir, "clients.json")).toEqual({});
    expect(readFileSync(join(dir, "clients.json.unreadable"), "utf8")).toBe("{ half");
  });

  it("does nothing when the file is not there", () => {
    expect(() => setAsideDataFile(dir, "clients.json", "clients.json.unreadable")).not.toThrow();
    expect(listDataFiles(dir)).toEqual([]);
  });

  it("throws every other error", () => {
    writeFileSync(join(dir, "clients.json"), "{}", "utf8");
    mkdirSync(join(dir, "aside"));
    writeFileSync(join(dir, "aside", "keep"), "x", "utf8");
    expect(() => setAsideDataFile(dir, "clients.json", "aside")).toThrow();
  });
});

describe("removeDataFile", () => {
  it("removes a file", () => {
    writeDataFile(dir, "login.json", "token");
    removeDataFile(dir, "login.json");
    expect(readDataFile(dir, "login.json")).toEqual({});
  });

  it("does nothing when the file is not there", () => {
    expect(() => removeDataFile(dir, "login.json")).not.toThrow();
  });

  it("throws every other error", () => {
    mkdirSync(join(dir, "login.json"));
    expect(() => removeDataFile(dir, "login.json")).toThrow();
  });
});

describe("listDataFiles", () => {
  it("lists the files of a folder in order, without its folders", () => {
    writeDataFile(dir, "b.json", 2);
    writeDataFile(dir, "a.json", 1);
    mkdirSync(join(dir, "sub"));
    expect(listDataFiles(dir)).toEqual(["a.json", "b.json"]);
  });

  it("lists the files in order whatever order the disk gives them in", () => {
    writeDataFile(dir, "a.json", 1);
    writeDataFile(dir, "b.json", 2);
    const entries = readdirSync(dir, { withFileTypes: true });
    const backwards = [...entries].sort((x, y) => y.name.localeCompare(x.name));
    vi.mocked(readdirSync).mockReturnValueOnce(backwards as never);
    expect(listDataFiles(dir)).toEqual(["a.json", "b.json"]);
  });

  it("lists nothing while the folder is not there", () => {
    expect(listDataFiles(join(dir, "missing"))).toEqual([]);
  });

  it("throws every other error", () => {
    writeFileSync(join(dir, "plain"), "x", "utf8");
    expect(() => listDataFiles(join(dir, "plain"))).toThrow();
  });
});
