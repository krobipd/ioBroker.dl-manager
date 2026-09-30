import { ProgramStore, STORE_FILE, type StoreAdapter } from "./store";

/**
 * The store over an in-memory file — `file.text` undefined means the file does not exist.
 *
 * @param stored the rows the file holds at the start; absent: no file
 */
function make(stored?: unknown): {
  store: ProgramStore;
  file: { text: string | undefined };
  rows: () => Record<string, unknown>[];
  writes: () => number;
} {
  const file = { text: stored === undefined ? undefined : JSON.stringify({ rows: stored }) };
  let writes = 0;
  let n = 0;
  const a: StoreAdapter = {
    readText: () => Promise.resolve(file.text),
    writeText: text => {
      writes++;
      file.text = text;
      return Promise.resolve();
    },
    // a new cipher on every call, like the installation secret's AES with a random IV
    encrypt: v => `enc${++n}:${v}`,
    decrypt: v => {
      const m = /^enc\d+:(.*)$/.exec(v);
      if (!m) {
        throw new Error("not ours");
      }
      return m[1];
    },
  };
  const rows = (): Record<string, unknown>[] =>
    (JSON.parse(file.text ?? "{}") as { rows: Record<string, unknown>[] }).rows;
  return { store: new ProgramStore(a), file, rows, writes: () => writes };
}

describe("ProgramStore", () => {
  it("has no rows while the store file does not exist, and skips what is no row", async () => {
    expect(await make().store.stored()).toBeUndefined();
    expect(await make().store.read()).toEqual([]);
    expect(await make([{ type: "a" }, null, "x", [1]]).store.stored()).toEqual([{ type: "a" }]);
    expect(await make("garbage").store.read()).toEqual([]);
  });

  it("reads a file without a row list as empty", async () => {
    const { store, file } = make();
    file.text = "[1, 2]";
    expect(await store.stored()).toEqual([]);
    file.text = '{"other": true}';
    expect(await store.stored()).toEqual([]);
    file.text = "null";
    expect(await store.stored()).toEqual([]);
  });

  it("stops at a file that holds no readable JSON — the programs are never replaced by an empty list", async () => {
    const { store, file, writes } = make();
    file.text = "{ broken";
    await expect(store.stored()).rejects.toThrow(`${STORE_FILE} is no readable JSON`);
    await expect(store.write([{ id: "a" }])).rejects.toThrow(STORE_FILE);
    expect(writes()).toBe(0);
    expect(file.text).toBe("{ broken");
  });

  it("stores password and API key encrypted, the rest as it is, as one file", async () => {
    const { store, rows } = make();
    await store.write([{ id: "qbittorrent-nas", host: "nas", password: "pw", apiKey: "" }]);
    expect(rows()).toEqual([{ id: "qbittorrent-nas", host: "nas", password: "enc1:pw", apiKey: "", encrypted: true }]);
    expect(await store.read()).toEqual([{ id: "qbittorrent-nas", host: "nas", password: "pw", apiKey: "" }]);
  });

  it("reads a row from before 0.3.0 with its secrets as typed", async () => {
    const { store } = make([{ type: "deluge", password: "typed" }]);
    expect(await store.read()).toEqual([{ type: "deluge", password: "typed" }]);
  });

  it("reads a secret of another installation as empty", async () => {
    const { store } = make([{ id: "a", password: "foreign", apiKey: 5, encrypted: true }]);
    expect(await store.read()).toEqual([{ id: "a", password: "", apiKey: "" }]);
  });

  it("keeps the cipher of a secret that did not change, and writes nothing when nothing changed", async () => {
    const { store, rows, writes } = make();
    await store.write([{ id: "a", password: "pw", apiKey: "k" }]);
    const first = structuredClone(rows());
    await store.write(await store.read());
    expect(writes()).toBe(1);
    await store.write([{ ...(await store.read())[0], name: "renamed" }]);
    expect(writes()).toBe(2);
    expect([rows()[0].password, rows()[0].apiKey]).toEqual([first[0].password, first[0].apiKey]);
    await store.write([{ id: "a", password: "new", apiKey: "k", name: "renamed" }]);
    expect(rows()[0].password).toBe("enc3:new");
  });

  it("encrypts again when the row is another one, even with the same secret", async () => {
    const { store, rows } = make();
    await store.write([{ id: "a", password: "pw" }]);
    await store.write([{ id: "b", password: "pw" }]);
    expect(rows()[0].password).toBe("enc2:pw");
  });

  it("creates no store for no programs, and empties an existing one", async () => {
    const { store, file, rows, writes } = make();
    expect(await store.write([])).toBe(false);
    expect(file.text).toBeUndefined();
    await store.write([{ id: "a" }]);
    expect(await store.write([])).toBe(true);
    expect(rows()).toEqual([]);
    expect(writes()).toBe(2);
  });
});

describe("ProgramStore.adopt — the store object of 0.3.0/0.3.1 moves into the file", () => {
  const stored = [{ id: "a", password: "enc9:pw", encrypted: true }, { id: "b" }];

  it("takes the rows over as they are stored — nothing decrypted, nothing encrypted again", async () => {
    const { store, rows, writes } = make();
    expect(await store.adopt([...stored, null, "x"])).toBe(2);
    expect(rows()).toEqual(stored);
    expect(writes()).toBe(1);
    expect(await store.read()).toEqual([{ id: "a", password: "pw", apiKey: "" }, { id: "b" }]);
  });

  it("leaves an existing file alone — a start that stopped between file and object deletion", async () => {
    const { store, rows, writes } = make([{ id: "c" }]);
    expect(await store.adopt(stored)).toBeUndefined();
    expect(rows()).toEqual([{ id: "c" }]);
    expect(writes()).toBe(0);
  });

  it("writes no file for an object without rows", async () => {
    const { store, file } = make();
    expect(await store.adopt(undefined)).toBe(0);
    expect(await store.adopt("garbage")).toBe(0);
    expect(file.text).toBeUndefined();
  });
});
