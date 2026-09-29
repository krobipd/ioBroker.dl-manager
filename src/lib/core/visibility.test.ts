import type { DownloadItem, Status } from "./model";
import { shownKeys } from "./visibility";

const item = (key: string, status: Status, addedMs?: number, finishedMs?: number): DownloadItem => ({
  key,
  name: key,
  status,
  sizeBytes: null,
  doneBytes: null,
  speedBps: null,
  etaSeconds: null,
  error: "",
  ...(addedMs !== undefined ? { addedMs } : {}),
  ...(finishedMs !== undefined ? { finishedMs } : {}),
});
const keys = (s: Set<string>): string[] => [...s].sort();

describe("shownKeys", () => {
  const all = [item("run", "downloading"), item("seed", "seeding"), item("done", "completed"), item("bad", "failed")];

  it("admits what the scope admits — a failed download always", () => {
    expect(keys(shownKeys(all, { scope: "all", limit: 0 }))).toEqual(["bad", "done", "run", "seed"]);
    expect(keys(shownKeys(all, { scope: "withoutCompleted", limit: 0 }))).toEqual(["bad", "run", "seed"]);
    expect(keys(shownKeys(all, { scope: "unfinished", limit: 0 }))).toEqual(["bad", "run"]);
  });

  it("keeps the best ranked above the limit: running, failed, paused/waiting, queued, seeding, completed", () => {
    const many = [
      item("c", "completed"),
      item("s", "seeding"),
      item("q", "queued"),
      item("p", "paused"),
      item("f", "failed"),
      item("d", "downloading"),
    ];
    expect(keys(shownKeys(many, { scope: "all", limit: 2 }))).toEqual(["d", "f"]);
    expect(keys(shownKeys(many, { scope: "all", limit: 4 }))).toEqual(["d", "f", "p", "q"]);
  });

  it("takes the newest first within a rank — finished ones by their finish", () => {
    const done = [item("old", "completed", 1, 10), item("new", "completed", 2, 30), item("mid", "completed", 3, 20)];
    expect(keys(shownKeys(done, { scope: "all", limit: 2 }))).toEqual(["mid", "new"]);
    const queued = [item("a", "queued", 5), item("b", "queued", 9), item("c", "queued")];
    expect(keys(shownKeys(queued, { scope: "all", limit: 1 }))).toEqual(["b"]);
  });

  it("shows everything the scope admits while the limit is 0 or not reached", () => {
    expect(shownKeys(all, { scope: "all", limit: 0 }).size).toBe(4);
    expect(shownKeys(all, { scope: "all", limit: 4 }).size).toBe(4);
  });
});
