import { FakeAdapter } from "../../../test/helpers/fake-adapter";
import { coveredBy, KnownObjects } from "./objects";

const NS = "dl-manager.0";

describe("coveredBy", () => {
  it("is true when every field of the patch already sits in the stored object", () => {
    expect(
      coveredBy({ common: { name: { en: "A" } } }, { type: "state", common: { name: { en: "A" }, role: "x" } }),
    ).toBe(true);
  });

  it("is false for a differing value, a missing object or a missing field", () => {
    expect(coveredBy({ common: { name: "A" } }, { common: { name: "B" } })).toBe(false);
    expect(coveredBy({ common: { name: "A" } }, undefined)).toBe(false);
    expect(coveredBy({ common: { desc: "A" } }, { common: { name: "A" } })).toBe(false);
  });

  it("compares arrays and values as a whole, and an object never against an array", () => {
    expect(coveredBy({ v: [1, 2] }, { v: [1, 2, 3] })).toBe(false);
    expect(coveredBy({ v: [1, 2] }, { v: [1, 2] })).toBe(true);
    expect(coveredBy({ v: {} }, { v: [] })).toBe(false);
  });
});

describe("KnownObjects", () => {
  async function loaded(a: FakeAdapter): Promise<KnownObjects> {
    const k = new KnownObjects(a);
    await k.load();
    return k;
  }

  it("writes nothing for an object the database already carries as asked", async () => {
    const a = new FakeAdapter(NS);
    await a.extendObject("dev.online", { type: "state", common: { name: "Online", role: "indicator" } });
    const k = await loaded(a);
    a.objectWrites = 0;
    await k.extend(`${NS}.dev.online`, { type: "state", common: { name: "Online" } });
    expect(a.objectWrites).toBe(0);
  });

  it("writes a differing object once and knows the result afterwards", async () => {
    const a = new FakeAdapter(NS);
    await a.extendObject("dev.online", { type: "state", common: { name: "Old", role: "indicator" } });
    const k = await loaded(a);
    a.objectWrites = 0;
    await k.extend("dev.online", { common: { name: "New" } });
    await k.extend("dev.online", { common: { name: "New" } });
    expect(a.objectWrites).toBe(1);
    expect(a.objects.get(`${NS}.dev.online`)?.common).toEqual({ name: "New", role: "indicator" });
    await k.extend("dev.online", { common: { role: "indicator" } });
    expect(a.objectWrites).toBe(1);
  });

  it("knows a shorter array as written, not merged into the old one", async () => {
    const a = new FakeAdapter(NS);
    await a.extendObject("dev.paused", { type: "state", common: { name: "P" }, native: { keys: ["a", "b"] } });
    const k = await loaded(a);
    a.objectWrites = 0;
    await k.extend("dev.paused", { native: { keys: ["a"] } });
    await k.extend("dev.paused", { native: { keys: ["a"] } });
    expect(a.objectWrites).toBe(1);
  });

  it("writes an object again after it was removed with its parent", async () => {
    const a = new FakeAdapter(NS);
    const k = await loaded(a);
    await k.extend("dev.downloads.1", { type: "channel", common: { name: "A" } });
    await k.extend("dev.downloads.1.status", { type: "state", common: { name: "Status" } });
    await k.remove(`${NS}.dev.downloads.1`, { recursive: true });
    a.objectWrites = 0;
    await k.extend("dev.downloads.1", { type: "channel", common: { name: "A" } });
    await k.extend("dev.downloads.1.status", { type: "state", common: { name: "Status" } });
    expect(a.objectWrites).toBe(2);
    expect(a.objects.has(`${NS}.dev.downloads.1.status`)).toBe(true);
  });

  it("keeps the children of an object removed without recursion", async () => {
    const a = new FakeAdapter(NS);
    const k = await loaded(a);
    await k.extend("dev", { type: "device", common: { name: "D" } });
    await k.extend("dev.online", { type: "state", common: { name: "Online" } });
    await k.remove("dev", { recursive: false });
    a.objectWrites = 0;
    await k.extend("dev.online", { type: "state", common: { name: "Online" } });
    expect(a.objectWrites).toBe(0);
  });

  it("knows an object written whole", async () => {
    const a = new FakeAdapter(NS);
    const k = await loaded(a);
    await k.replace(`${NS}.dev.paused`, {
      type: "state",
      common: { name: "Paused", type: "boolean", role: "switch", read: true, write: true },
      native: { emulatedPause: { paused: true, keys: [] } },
    });
    a.objectWrites = 0;
    await k.extend("dev.paused", { common: { name: "Paused" }, native: {} });
    expect(a.objectWrites).toBe(0);
  });

  it("writes everything before the tree was read", async () => {
    const a = new FakeAdapter(NS);
    await a.extendObject("dev.online", { type: "state", common: { name: "Online" } });
    const k = new KnownObjects(a);
    a.objectWrites = 0;
    await k.extend("dev.online", { type: "state", common: { name: "Online" } });
    expect(a.objectWrites).toBe(1);
  });
});
