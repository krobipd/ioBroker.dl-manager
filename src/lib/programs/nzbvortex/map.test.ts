import { loadFixture } from "../../../../test/helpers/fixtures";
import { ProtocolError } from "../../core/errors";
import { entryOf, fieldOf, isRunning, limitOf, rawStatus, toSnapshot, versionOf } from "./map";

/** The fixture queue: 11 loading, 12 waiting, 13 paused, 14 unpacking, 15 done, 16 failed. */
const rows = (): Record<string, unknown>[] =>
  structuredClone(
    (loadFixture("nzbvortex", "doc-1.7", "queue", "list").body as { nzbs: Record<string, unknown>[] }).nzbs,
  );
const quiet = (): void => undefined;

describe("NZBVortex map", () => {
  it("lets isPaused go before every state but done and failed, also as 1", () => {
    const [loading, , , unpacking, done, failed] = rows();
    expect(rawStatus(entryOf({ ...loading, isPaused: 1 }))).toBe("paused");
    expect(rawStatus(entryOf({ ...unpacking, isPaused: true }))).toBe("paused");
    expect(rawStatus(entryOf({ ...done, isPaused: true }))).toBe("20");
    expect(rawStatus(entryOf({ ...failed, isPaused: true }))).toBe("22");
    expect(rawStatus(entryOf({ ...failed, state: 23, isPaused: true }))).toBe("23");
    expect(rawStatus(entryOf({ ...loading, isPaused: false }))).toBe("1");
  });

  it("refuses an entry without a numeric id or a state", () => {
    const [loading] = rows();
    expect(() => entryOf({ ...loading, id: "11" })).toThrow(ProtocolError);
    expect(() => entryOf({ ...loading, state: null })).toThrow(ProtocolError);
    expect(() => entryOf({ ...loading, state: "1" })).toThrow(ProtocolError);
  });

  it("halts only what waits for its turn or loads (states 0–3), never what the user paused", () => {
    const [loading, waiting, paused, unpacking] = rows().map(entryOf);
    expect([loading, waiting, paused, unpacking].map(isRunning)).toEqual([true, true, false, false]);
    expect(isRunning(entryOf({ ...rows()[0], state: 3 }))).toBe(true);
    expect(isRunning(entryOf({ ...rows()[0], state: 5 }))).toBe(false);
  });

  it("names the error by statusText, else by the documentation's name of the state", () => {
    const failed = rows()[5];
    const items = toSnapshot(
      "3.4.3",
      [entryOf({ ...failed, statusText: "Disk full" }), entryOf({ ...failed, state: 24 }), entryOf(rows()[0])],
      0,
      false,
      quiet,
    ).items;
    expect(items.map(i => i.error)).toEqual(["Disk full", "Badly encoded download (uuencoded)", ""]);
  });

  it("gives no rate where the entry has none, and no time left without one", () => {
    const [loading] = rows();
    const items = toSnapshot(
      "3.4.3",
      [
        entryOf({ ...loading, transferedSpeed: undefined }),
        entryOf({ ...loading, id: 20, transferedSpeed: 0 }),
        // a paused entry may keep its last rate
        entryOf({ ...loading, id: 23, isPaused: true, transferedSpeed: 900 }),
      ],
      0,
      false,
      quiet,
    ).items;
    expect(items.map(i => [i.speedBps, i.etaSeconds])).toEqual([
      [null, null],
      [0, null],
      [0, null],
    ]);
  });

  it("keeps the bytes done within the size and reads a size of 0 as unknown", () => {
    const [loading] = rows();
    const [over, unknown] = toSnapshot(
      "3.4.3",
      [
        entryOf({ ...loading, downloadedSize: 2_000_000_000 }),
        entryOf({ ...loading, id: 21, totalDownloadSize: 0, downloadedSize: 5 }),
      ],
      0,
      false,
      quiet,
    ).items;
    expect([over.doneBytes, over.etaSeconds]).toEqual([1_000_000_000, null]);
    expect([unknown.sizeBytes, unknown.doneBytes]).toEqual([null, 5]);
  });

  it("reads the limit switch as 0/1 or a boolean, the limit in KB/s", () => {
    expect(limitOf({ speedlimit_enabled: 1, speedlimit: 512 })).toBe(512 * 1024);
    expect(limitOf({ speedlimit_enabled: true, speedlimit: "100" })).toBe(100 * 1024);
    expect(limitOf({ speedlimit_enabled: false, speedlimit: 512 })).toBe(0);
    expect(limitOf({ speedlimit_enabled: 0 })).toBe(0);
    expect(limitOf({ speedlimit_enabled: true })).toBeNull();
    expect(limitOf({ speedlimit: 512 })).toBeNull();
  });

  it("reads the group as category whatever the case of its key, the exact key first", () => {
    const { groupName, ...loading } = rows()[0];
    expect(groupName).toBeTypeOf("string");
    const items = toSnapshot(
      "3.4.3",
      [entryOf({ ...loading, GroupName: "Movies" }), entryOf({ ...loading, id: 22, groupname: "TV" })],
      0,
      false,
      quiet,
    ).items;
    expect(items.map(i => i.category)).toEqual(["Movies", "TV"]);
    expect(fieldOf({ GroupName: "b", groupName: "a" }, "groupName")).toBe("a");
    expect(fieldOf({ other: 1 }, "groupName")).toBeUndefined();
  });

  it("refuses an answer without the version", () => {
    expect(versionOf({ result: "ok", appversion: "3.4.3" })).toBe("3.4.3");
    expect(() => versionOf({ result: "ok", appversion: "" })).toThrow(ProtocolError);
    expect(() => versionOf({ result: "ok" })).toThrow(ProtocolError);
  });
});
