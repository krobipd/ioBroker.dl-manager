import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDataFile, writeDataFile, type DataFileSecrets } from "../data-file";
import { ProgramStore, SECRET_FIELDS, STORE_FILE, type StoreAdapter } from "./store";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dl-manager-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A new cipher on every call, like the installation secret's AES with a random IV. */
function cipher(): DataFileSecrets["cipher"] {
  let n = 0;
  return {
    encrypt: v => `enc${++n}:${v}`,
    decrypt: v => {
      const m = /^enc\d+:(.*)$/s.exec(v);
      if (!m) {
        throw new Error("not ours");
      }
      return m[1];
    },
  };
}

/**
 * The store over `programs.json` in a fresh folder, read and written through the fleet master data-file.ts — as the
 * adapter does it.
 *
 * @param content what the file holds at the start, as JSON; absent: no file
 */
function make(content?: unknown): {
  store: ProgramStore;
  text: () => string;
  file: () => { rows: Record<string, unknown>[] };
  writes: () => number;
} {
  const secrets: DataFileSecrets = { cipher: cipher(), fields: SECRET_FIELDS };
  if (content !== undefined) {
    writeFileSync(join(dir, STORE_FILE), typeof content === "string" ? content : JSON.stringify(content));
  }
  let writes = 0;
  const a: StoreAdapter = {
    read: () => Promise.resolve(readDataFile(dir, STORE_FILE, secrets)),
    write: value => {
      writes++;
      writeDataFile(dir, STORE_FILE, value, secrets);
      return Promise.resolve();
    },
    decrypt: v => secrets.cipher.decrypt(v),
  };
  const text = (): string => readFileSync(join(dir, STORE_FILE), "utf8");
  return {
    store: new ProgramStore(a),
    text,
    file: () => JSON.parse(text()) as { rows: Record<string, unknown>[] },
    writes: () => writes,
  };
}

/**
 * The secret fields of a stored file that hold anything but the sealed form — the fleet suite "the whole run" calls each
 * of them a text the master did not seal.
 *
 * @param file the parsed file
 * @param file.rows its program rows
 * @returns the unsealed secret fields, as `row.field`
 */
function unsealed(file: { rows: Record<string, unknown>[] }): string[] {
  return file.rows.flatMap((row, i) =>
    SECRET_FIELDS.filter(f => {
      const v = row[f] as Record<string, unknown> | undefined;
      return f in row && !(v && Object.keys(v).length === 1 && typeof v.$encrypted === "string");
    }).map(f => `${i}.${f}`),
  );
}

describe("ProgramStore", () => {
  it("has no rows while the store file does not exist, and skips what is no row", async () => {
    expect(await make().store.stored()).toBeUndefined();
    expect(await make().store.read()).toEqual([]);
    expect(await make({ rows: [{ type: "a" }, null, "x", [1]] }).store.stored()).toEqual([{ type: "a" }]);
    expect(await make({ rows: [] }).store.read()).toEqual([]);
  });

  it("stops at a file without a row list like at unreadable JSON — the start never removes every program (review B8)", async () => {
    for (const text of ["[1, 2]", '{"other": true}', "null", '{"rows": "garbage"}']) {
      const { store, writes } = make(text);
      await expect(store.stored(), text).rejects.toThrow(`${STORE_FILE} holds no list of programs`);
      await expect(store.read(), text).rejects.toThrow(STORE_FILE);
      await expect(store.adopt([{ id: "a" }]), text).rejects.toThrow(STORE_FILE);
      expect(writes()).toBe(0);
    }
  });

  it("stops at a file that holds no readable JSON — the programs are never replaced by an empty list", async () => {
    const { store, text, writes } = make("{ broken");
    await expect(store.stored()).rejects.toThrow(`${STORE_FILE} cannot be read — fix or remove it (no JSON:`);
    await expect(store.write([{ id: "a" }])).rejects.toThrow(STORE_FILE);
    expect(writes()).toBe(0);
    expect(text()).toBe("{ broken");
  });

  it("stores password and API key sealed by data-file.ts, the rest as it is, as one file", async () => {
    const { store, file } = make();
    await store.write([{ id: "qbittorrent-nas", host: "nas", password: "pw", apiKey: "" }]);
    expect(file().rows).toEqual([
      { id: "qbittorrent-nas", host: "nas", password: { $encrypted: 'enc1:"pw"' }, apiKey: { $encrypted: 'enc2:""' } },
    ]);
    expect(await store.read()).toEqual([{ id: "qbittorrent-nas", host: "nas", password: "pw", apiKey: "" }]);
  });

  it("calls a file unusable whose sealed secret cannot be decrypted — the start halts instead of empty passwords", async () => {
    const content = { rows: [{ id: "a", password: { $encrypted: "another installation" } }] };
    const { store, text, writes } = make(content);
    await expect(store.read()).rejects.toThrow(
      `${STORE_FILE} cannot be read — fix or remove it (secret field rows[0].password cannot be decrypted)`,
    );
    await expect(store.write([{ id: "a", password: "pw" }])).rejects.toThrow(STORE_FILE);
    expect(writes()).toBe(0);
    expect(JSON.parse(text())).toEqual(content);
  });

  it("writes nothing when nothing changed, and seals the whole file anew when a row changed", async () => {
    const { store, file, text, writes } = make();
    await store.write([{ id: "a", password: "pw", apiKey: "k" }]);
    const first = text();
    expect(await store.write(await store.read())).toBe(false);
    expect([writes(), text()]).toEqual([1, first]);
    expect(await store.write([{ ...(await store.read())[0], name: "renamed" }])).toBe(true);
    expect(writes()).toBe(2);
    expect(unsealed(file())).toEqual([]);
    expect(await store.read()).toEqual([{ id: "a", password: "pw", apiKey: "k", name: "renamed" }]);
  });

  it("writes nothing for the same row with its fields in another order", async () => {
    const { store, writes } = make();
    await store.write([{ id: "a", name: "n", password: "pw", apiKey: "k" }]);
    const [row] = await store.read();
    await store.write([Object.fromEntries(Object.entries(row).reverse())]);
    expect(writes()).toBe(1);
  });

  it("creates no store for no programs, and empties an existing one", async () => {
    const { store, file, writes } = make();
    expect(await store.write([])).toBe(false);
    expect(existsSync(join(dir, STORE_FILE))).toBe(false);
    await store.write([{ id: "a" }]);
    expect(await store.write([])).toBe(true);
    expect(file().rows).toEqual([]);
    expect(writes()).toBe(2);
  });
});

describe("ProgramStore — the files earlier versions left", () => {
  it("reads a row from before 0.3.0 with its secrets as typed, and the file holds them sealed at once", async () => {
    const { store, file, writes } = make({ rows: [{ type: "deluge", password: "typed" }] });
    expect(await store.read()).toEqual([{ type: "deluge", password: "typed" }]);
    expect(unsealed(file())).toEqual([]);
    expect(writes()).toBe(0);
  });

  it("reads a file of 0.3.2 to 0.4.x — secrets encrypted in the row — and the next write stores the form of today", async () => {
    const { store, file, writes } = make({
      rows: [{ id: "a", host: "nas", password: "enc7:pw", apiKey: "", encrypted: true }],
    });
    expect(await store.read()).toEqual([{ id: "a", host: "nas", password: "pw", apiKey: "" }]);
    // data-file.ts sealed the old cipher text at the read; the row still carries its mark
    expect(unsealed(file())).toEqual([]);
    expect(file().rows[0].encrypted).toBe(true);
    expect(await store.write(await store.read())).toBe(true);
    expect(file().rows).toEqual([
      {
        id: "a",
        host: "nas",
        password: { $encrypted: expect.stringMatching(/^enc\d+:"pw"$/) as unknown },
        apiKey: { $encrypted: expect.stringMatching(/^enc\d+:""$/) as unknown },
      },
    ]);
    expect(await store.write(await store.read())).toBe(false);
    expect(writes()).toBe(1);
  });

  it("reads the file a read of 0.4.x left half-way — the old cipher text sealed, the mark still there", async () => {
    const seal = cipher();
    const { store } = make({
      rows: [
        {
          id: "a",
          password: { $encrypted: seal.encrypt(JSON.stringify("enc7:pw")) },
          apiKey: { $encrypted: seal.encrypt(JSON.stringify("")) },
          encrypted: true,
        },
      ],
    });
    expect(await store.read()).toEqual([{ id: "a", password: "pw", apiKey: "" }]);
  });

  it("reads a secret 0.4.x encrypted under another installation as empty", async () => {
    const { store } = make({ rows: [{ id: "a", password: "foreign", apiKey: 5, encrypted: true }] });
    expect(await store.read()).toEqual([{ id: "a", password: "", apiKey: "" }]);
  });
});

describe("ProgramStore.adopt — the store object of 0.3.0/0.3.1 moves into the file", () => {
  const stored = [{ id: "a", password: "enc9:pw", encrypted: true }, { id: "b" }];

  it("takes the rows over with their secrets decrypted, and the file seals them", async () => {
    const { store, file, writes } = make();
    expect(await store.adopt([...stored, null, "x"])).toBe(2);
    expect(writes()).toBe(1);
    expect(unsealed(file())).toEqual([]);
    expect(file().rows.map(r => r.encrypted)).toEqual([undefined, undefined]);
    expect(await store.read()).toEqual([
      { id: "a", password: "pw", apiKey: "" },
      { id: "b", password: "", apiKey: "" },
    ]);
  });

  it("leaves an existing file alone — a start that stopped between file and object deletion", async () => {
    const { store, file, writes } = make({ rows: [{ id: "c" }] });
    expect(await store.adopt(stored)).toBeUndefined();
    expect(file().rows).toEqual([{ id: "c" }]);
    expect(writes()).toBe(0);
  });

  it("writes no file for an object without rows", async () => {
    const { store } = make();
    expect(await store.adopt(undefined)).toBe(0);
    expect(await store.adopt("garbage")).toBe(0);
    expect(existsSync(join(dir, STORE_FILE))).toBe(false);
  });
});
