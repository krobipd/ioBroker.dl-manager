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

describe("JDownloader package rules (written out, not taken from map.ts)", () => {
  const st = (links: JdLink[]): string => packageStatus(links, () => undefined).status;
  const running = (task: string): JdLink => link({ enabled: true, running: true, ...adv("PluginProgress", task) });

  it("maps every post-processing and waiting task of a running link", () => {
    for (const task of ["EXTRACTION", "FFMPEG", "FLV_FIXER", "CONVERT", "MOVE_FILE"]) {
      expect([task, st([running(task)])]).toEqual([task, "postprocessing"]);
    }
    for (const task of ["WAIT", "CAPTCHA", "USERIO"]) {
      expect([task, st([running(task)])]).toEqual([task, "waiting"]);
    }
  });

  it("ignores the task of a link that does not run", () => {
    expect(st([link({ enabled: true, ...adv("PluginProgress", "WAIT") })])).toBe("queued");
  });

  it("lets a running link win over an error or a skip reason of its siblings", () => {
    const extractErr = link({ enabled: true, finished: true, ...adv("ExtractionStatus", "ERROR_PW") });
    const failed = link({ enabled: true, ...adv("FinalLinkState", "FAILED") });
    const skipped = link({ enabled: true, ...adv("ConditionalSkipReason", "WaitingSkipReason") });
    expect(st([running("DOWNLOAD"), extractErr])).toBe("downloading");
    expect(st([running("DOWNLOAD"), failed])).toBe("downloading");
    expect(st([running("DOWNLOAD"), skipped])).toBe("downloading");
    expect(st([link({ enabled: true, running: true })])).toBe("downloading");
  });

  it("calls an empty package queued, never completed or paused", () => {
    expect(st([])).toBe("queued");
  });

  it("names an unknown plugin task and extraction state in a debug line", () => {
    const lines: string[] = [];
    packageStatus(
      [
        link({ enabled: true, running: true, ...adv("PluginProgress", "NEW_TASK") }),
        link({ enabled: true, ...adv("ExtractionStatus", "NEW_EXTRACT") }),
      ],
      m => lines.push(m),
    );
    expect(lines.join("\n")).toContain("PluginProgress:NEW_TASK");
    expect(lines.join("\n")).toContain("ExtractionStatus:NEW_EXTRACT");
  });
});

describe("JDownloader snapshot details", () => {
  it("reads packages without links, skips packages without uuid and keeps special values unknown", () => {
    const s = toSnapshot(
      "48637",
      { state: "STOPPING", limit: false, limitspeed: 5 },
      [
        { name: "no uuid" },
        { uuid: 1, name: "off", enabled: false, bytesTotal: -1, speed: 7 },
        { uuid: 2, name: "on", enabled: true },
      ],
      null,
      () => undefined,
    );
    expect(s.items.map(i => i.name)).toEqual(["off", "on"]);
    expect(s.items[0]).toMatchObject({ status: "paused", sizeBytes: null, speedBps: 0 });
    expect(s.status).toMatchObject({ paused: true, speedLimitBps: 0 });
  });

  it("takes the first link's added date and a finish time only for a completed package", () => {
    const links: JdLink[] = [
      link({ uuid: 1, packageUUID: 5, enabled: true, finished: true, addedDate: 300, finishedDate: 900 }),
      link({ uuid: 2, packageUUID: 5, enabled: true, finished: true, addedDate: 100, finishedDate: 800 }),
      link({ uuid: 3, packageUUID: 6, enabled: true, addedDate: 50, finishedDate: 700 }),
    ];
    const s = toSnapshot(
      "48637",
      {},
      [
        { uuid: 5, name: "done" },
        { uuid: 6, name: "open" },
      ],
      links,
      () => undefined,
    );
    expect(s.items[0]).toMatchObject({ addedMs: 100, finishedMs: 900 });
    expect(s.items[1].finishedMs).toBeNull();
  });
});
