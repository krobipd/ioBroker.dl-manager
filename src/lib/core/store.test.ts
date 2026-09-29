vi.mock("../i18n", () => ({ tName: (key: string) => ({ en: key }) }));

import { ProgramStore, STORE_ID, type StoreAdapter } from "./store";

const NS = "dl-manager.0";
const FULL = `${NS}.${STORE_ID}`;

function make(stored?: unknown): { store: ProgramStore; objects: Map<string, ioBroker.Object>; writes: () => number } {
  const objects = new Map<string, ioBroker.Object>();
  if (stored !== undefined) {
    objects.set(FULL, {
      _id: FULL,
      type: "meta",
      common: { name: "x", type: "meta.folder" },
      native: { rows: stored },
    } as never);
  }
  let writes = 0;
  let n = 0;
  const a: StoreAdapter = {
    namespace: NS,
    getForeignObjectAsync: id => Promise.resolve(objects.has(id) ? structuredClone(objects.get(id)) : null),
    setForeignObject: (id, obj) => {
      writes++;
      objects.set(id, structuredClone(obj) as ioBroker.Object);
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
  return { store: new ProgramStore(a), objects, writes: () => writes };
}

describe("ProgramStore", () => {
  it("has no rows while the store object does not exist, and skips what is no row", async () => {
    expect(await make().store.stored()).toBeUndefined();
    expect(await make().store.read()).toEqual([]);
    expect(await make([{ type: "a" }, null, "x", [1]]).store.stored()).toEqual([{ type: "a" }]);
    expect(await make("garbage").store.read()).toEqual([]);
  });

  it("stores password and API key encrypted, the rest as it is, as one meta object", async () => {
    const { store, objects } = make();
    await store.write([{ id: "qbittorrent-nas", host: "nas", password: "pw", apiKey: "" }]);
    const obj = objects.get(FULL);
    expect(obj?.type).toBe("meta");
    expect(obj?.common).toEqual({ name: { en: "programStore" }, type: "meta.folder" });
    expect(obj?.native.rows).toEqual([
      { id: "qbittorrent-nas", host: "nas", password: "enc1:pw", apiKey: "", encrypted: true },
    ]);
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
    const { store, objects, writes } = make();
    await store.write([{ id: "a", password: "pw", apiKey: "k" }]);
    const first = structuredClone(objects.get(FULL)?.native.rows);
    await store.write(await store.read());
    expect(writes()).toBe(1);
    await store.write([{ ...(await store.read())[0], name: "renamed" }]);
    expect(writes()).toBe(2);
    const rows = objects.get(FULL)?.native.rows as Record<string, unknown>[];
    expect([rows[0].password, rows[0].apiKey]).toEqual([
      (first as Record<string, unknown>[])[0].password,
      (first as Record<string, unknown>[])[0].apiKey,
    ]);
    await store.write([{ id: "a", password: "new", apiKey: "k", name: "renamed" }]);
    expect((objects.get(FULL)?.native.rows as Record<string, unknown>[])[0].password).toBe("enc3:new");
  });

  it("encrypts again when the row is another one, even with the same secret", async () => {
    const { store, objects } = make();
    await store.write([{ id: "a", password: "pw" }]);
    await store.write([{ id: "b", password: "pw" }]);
    expect((objects.get(FULL)?.native.rows as Record<string, unknown>[])[0].password).toBe("enc2:pw");
  });

  it("creates no store for no programs, and empties an existing one", async () => {
    const { store, objects, writes } = make();
    expect(await store.write([])).toBe(false);
    expect(objects.has(FULL)).toBe(false);
    await store.write([{ id: "a" }]);
    expect(await store.write([])).toBe(true);
    expect(objects.get(FULL)?.native.rows).toEqual([]);
    expect(writes()).toBe(2);
  });
});
