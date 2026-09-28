import { ItemIds, programId, sanitize } from "./ids";

describe("sanitize", () => {
  it("turns names into valid id segments", () => {
    expect(sanitize("Urlaub 2026 – Fotos (10 Teile)")).toBe("urlaub-2026-fotos-10-teile");
    expect(sanitize("a.b*c,d")).toBe("a-b-c-d");
    expect(sanitize("Grüße")).toBe("grusse");
    expect(sanitize("...")).toBe("");
  });
});

describe("programId", () => {
  it("joins program type and the user's key", () => {
    expect(programId("qbittorrent", "NAS")).toBe("qbittorrent-nas");
    expect(programId("jdownloader", "server 2")).toBe("jdownloader-server-2");
  });
  it("falls back to the type alone when the key is empty after cleaning", () => {
    expect(programId("aria2", "")).toBe("aria2");
    expect(programId("aria2", "***")).toBe("aria2");
  });
});

describe("ItemIds", () => {
  it("takes the LAST eight characters, so JD timestamps added together stay apart", () => {
    const ids = new ItemIds(new Map());
    expect(ids.idFor("1790000000123")).toBe("00000123");
    expect(ids.idFor("1790000000124")).toBe("00000124");
  });

  it("falls back to the whole key on a collision, then to a counter", () => {
    const ids = new ItemIds(new Map());
    expect(ids.idFor("aaaa12345678")).toBe("12345678");
    expect(ids.idFor("bbbb12345678")).toBe("bbbb12345678");
    const again = new ItemIds(
      new Map([
        ["x", "bbbb12345678"],
        ["y", "12345678"],
      ]),
    );
    expect(again.idFor("bbbb12345678")).toBe("bbbb12345678-2");
  });

  it("returns the same id for the same key", () => {
    const ids = new ItemIds(new Map());
    expect(ids.idFor("3c7e1f0a9b")).toBe(ids.idFor("3c7e1f0a9b"));
  });

  it("keeps an id across a restart via the stored map", () => {
    const first = new ItemIds(new Map());
    const id = first.idFor("3c7e1f0a9b");
    first.idFor("other-key-0001");
    expect(new ItemIds(first.entries()).idFor("3c7e1f0a9b")).toBe(id);
  });

  it("frees an id when the key disappears", () => {
    const ids = new ItemIds(new Map());
    ids.idFor("aaaa12345678");
    ids.release("aaaa12345678");
    expect(ids.idFor("cccc12345678")).toBe("12345678");
    expect(ids.entries().has("aaaa12345678")).toBe(false);
  });

  it("gives a key that cleans to nothing a usable id", () => {
    const ids = new ItemIds(new Map());
    expect(ids.idFor("###")).toBe("item");
    expect(ids.idFor("***")).toBe("item-2");
  });

  it("never starts an id with a hyphen when the cut lands on one", () => {
    const ids = new ItemIds(new Map());
    expect(ids.idFor("xxxx-abc1234")).toBe("abc1234");
  });

  it("makes ids valid ioBroker segments even from dotted keys", () => {
    const ids = new ItemIds(new Map());
    expect(ids.idFor("SABnzbd_nzo_a.b.c")).toBe("zo-a-b-c");
  });
});
