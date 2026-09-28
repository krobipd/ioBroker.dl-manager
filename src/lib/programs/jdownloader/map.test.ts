import { loadFixture } from "../../../../test/helpers/fixtures";
import { jdLinkFromRaw, mapJdStatus, packageStatus, statusTable, toSnapshot, type JdLink } from "./map";

const link = (over: Partial<JdLink> = {}): JdLink => ({ uuid: 1, packageUUID: 10, name: "a.bin", ...over });
const adv = (key: string, id: string): Partial<JdLink> => ({ advancedStatus: { [key]: { id } } });

describe("JDownloader status of a package", () => {
  it("maps every row of the status table", () => {
    for (const [raw, expected] of statusTable) {
      expect([raw, mapJdStatus(raw, () => undefined)]).toEqual([raw, expected]);
    }
  });

  it("reads missing booleans as false — JD leaves false fields out", () => {
    expect(packageStatus([link({ enabled: true })], () => undefined).status).toBe("queued");
    expect(packageStatus([link({})], () => undefined).status).toBe("paused");
  });

  it("is downloading while one of ten links loads and nine are done", () => {
    const links = [
      ...Array.from({ length: 9 }, (_, i) =>
        link({ uuid: i, enabled: true, finished: true, ...adv("FinalLinkState", "FINISHED") }),
      ),
      link({ uuid: 99, enabled: true, running: true, ...adv("PluginProgress", "DOWNLOAD") }),
    ];
    expect(packageStatus(links, () => undefined).status).toBe("downloading");
  });

  it("is postprocessing while an archive is extracted after all links finished", () => {
    const links = [
      link({
        enabled: true,
        finished: true,
        advancedStatus: { FinalLinkState: { id: "FINISHED" }, ExtractionStatus: { id: "RUNNING" } },
      }),
    ];
    expect(packageStatus(links, () => undefined).status).toBe("postprocessing");
  });

  it("never reads the localized status text", () => {
    expect(packageStatus([link({ enabled: true, status: "Fertig" })], () => undefined)).toEqual({
      status: "queued",
      error: "",
    });
  });

  it("hands the program's text on as the error of a failed package", () => {
    const r = packageStatus(
      [link({ enabled: true, status: "File not found", ...adv("FinalLinkState", "OFFLINE") })],
      () => undefined,
    );
    expect(r).toEqual({ status: "failed", error: "File not found" });
  });

  it("names an unknown state id in a debug line and does not guess", () => {
    const lines: string[] = [];
    expect(
      packageStatus([link({ enabled: true, ...adv("FinalLinkState", "SOMETHING_NEW") })], m => lines.push(m)).status,
    ).toBe("queued");
    expect(lines.join("\n")).toContain("SOMETHING_NEW");
  });

  it("builds a link from a raw table key", () => {
    expect(jdLinkFromRaw("enabled:false").enabled).toBeUndefined();
    expect(jdLinkFromRaw("PluginProgress:DOWNLOAD").running).toBe(true);
  });
});

describe("JDownloader snapshot from the recorded answers (build 48637)", () => {
  const read = (state: string, name: string): unknown =>
    (loadFixture("jdownloader", "48637", state, name).body as { data: unknown }).data;
  const snap = (state: string): ReturnType<typeof toSnapshot> =>
    toSnapshot(
      "48637",
      read(state, "toolbar-get-status"),
      read(state, "query-packages"),
      read(state, "query-links"),
      () => undefined,
    );

  it("maps the running snapshot: finished, failed, downloading, queued, paused", () => {
    const s = snap("running");
    expect(s.complete).toBe(true);
    expect(s.status).toMatchObject({ version: "48637", paused: false, downloadBps: 1024450, speedLimitBps: 0 });
    const byName = Object.fromEntries(s.items.map(i => [i.name, i]));
    expect(byName.small).toMatchObject({ status: "completed", sizeBytes: 2097152, doneBytes: 2097152, speedBps: 0 });
    expect(byName.missing).toMatchObject({ status: "failed", error: "File not found" });
    expect(byName.big).toMatchObject({ status: "downloading", speedBps: 1058202, etaSeconds: 1, sizeBytes: 33554432 });
    expect(byName.queued.status).toBe("queued");
    expect(byName.stopped.status).toBe("paused");
    expect(byName.big.key).toBe("1790633547449");
    expect(byName.small.addedMs).toBe(1790633485827);
    expect(byName.small.finishedMs).toBe(1790633503998);
  });

  it("shows the program paused after a pause and after a stop, and hides the pause throttle as a limit", () => {
    expect(snap("paused-global").status).toMatchObject({ paused: true, speedLimitBps: 0 });
    expect(snap("stopped").status.paused).toBe(true);
    expect(snap("limited").status).toMatchObject({ paused: false, speedLimitBps: 2000000 });
  });

  it("maps an extracted archive to completed", () => {
    expect(snap("extracted").items.find(i => i.name === "archive")?.status).toBe("completed");
  });

  it("keeps the packages but reports incomplete when the link list is missing", () => {
    const s = toSnapshot(
      "48637",
      read("running", "toolbar-get-status"),
      read("running", "query-packages"),
      null,
      () => undefined,
    );
    expect(s.complete).toBe(false);
    expect(s.items.find(i => i.name === "big")?.status).toBe("downloading");
    expect(s.items.find(i => i.name === "small")?.status).toBe("completed");
  });
});
