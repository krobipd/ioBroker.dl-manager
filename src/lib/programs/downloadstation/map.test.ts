import { loadFixture } from "../../../../test/helpers/fixtures";
import { ProtocolError } from "../../core/errors";
import { infoOf, limitBps, rawStatus, taskOf, toSnapshot, uploadLimitFields } from "./map";

/** The live list of DSM 7.2.2: dbid_1 a magnet loading, dbid_2 a finished HTTP task. */
const live = (): Record<string, unknown>[] =>
  structuredClone(
    (
      loadFixture("downloadstation", "4.1-5012", "running", "list").body as {
        data: { tasks: Record<string, unknown>[] };
      }
    ).data.tasks,
  );
const config = (): Record<string, unknown> =>
  structuredClone(
    (loadFixture("downloadstation", "4.1-5012", "running", "config").body as { data: Record<string, unknown> }).data,
  );
const quiet = (): void => undefined;

/**
 * @param row a task of the live list
 * @param transfer the transfer block to give it
 * @returns the task with that block
 */
const withTransfer = (row: Record<string, unknown>, transfer: Record<string, unknown>): Record<string, unknown> => ({
  ...row,
  additional: { ...(row.additional as object), transfer },
});

describe("Download Station map", () => {
  it("reads a paused task that has every byte as completed", () => {
    const done = taskOf({ ...live()[1], status: "paused" });
    expect(rawStatus(done)).toBe("paused:done");
    const magnet = taskOf({ ...live()[0], status: "paused" });
    expect(rawStatus(magnet)).toBe("paused");
  });

  it("keeps a status that comes as a number as its raw key and refuses an entry without one", () => {
    expect(taskOf({ ...live()[0], status: 2 }).status).toBe("2");
    expect(() => taskOf({ ...live()[0], status: null })).toThrow(ProtocolError);
    expect(() => taskOf({ ...live()[0], id: "" })).toThrow(ProtocolError);
  });

  it("counts time left and ratio from the bytes, as Download Station sends neither", () => {
    const row = withTransfer(
      { ...live()[0], size: 1000 },
      { size_downloaded: 400, size_uploaded: 200, speed_download: 100, speed_upload: 7 },
    );
    const [item] = toSnapshot("4.1-5012", [taskOf(row)], config(), true, false, quiet).items;
    expect(item).toMatchObject({
      sizeBytes: 1000,
      doneBytes: 400,
      speedBps: 100,
      uploadBps: 7,
      etaSeconds: 6,
      ratio: 0.5,
    });
  });

  it("gives a task that does not load no rate, and an HTTP task no ratio", () => {
    const row = withTransfer(
      { ...live()[1], status: "paused", size: 1000 },
      {
        size_downloaded: 400,
        size_uploaded: 50,
        speed_download: 1394,
        speed_upload: 3,
      },
    );
    const [item] = toSnapshot("4.1-5012", [taskOf(row)], config(), true, false, quiet).items;
    expect(item).toMatchObject({ status: "paused", speedBps: 0, uploadBps: 0, etaSeconds: null, ratio: null });
  });

  it("reads numbers sent as text", () => {
    const row = withTransfer({ ...live()[0], size: "1000" }, { size_downloaded: "250", speed_download: "50" });
    const [item] = toSnapshot("4.1-5012", [taskOf(row)], config(), true, false, quiet).items;
    expect(item).toMatchObject({ sizeBytes: 1000, doneBytes: 250, speedBps: 50, etaSeconds: 15 });
  });

  it("names the error of a failed task, a code as its number", () => {
    const text = taskOf({ ...live()[0], status: "error", status_extra: { error_detail: "disk_full" } });
    const code = taskOf({ ...live()[0], status: "error", status_extra: { error_detail: 105 } });
    const loading = taskOf({ ...live()[0], status_extra: { error_detail: "broken_link" } });
    expect(toSnapshot("4.1-5012", [text, code, loading], config(), true, false, quiet).items.map(i => i.error)).toEqual(
      ["disk_full", "105", ""],
    );
  });

  it("reads the upload limit and no download limit — Download Station keeps that per protocol", () => {
    const c = config();
    const up = uploadLimitFields(c);
    expect(up).toEqual(["bt_max_upload"]);
    expect(limitBps(c, up, true)).toBe(20 * 1024);
    expect(limitBps(c, up, false)).toBeNull();
    // even with every protocol's download limit at one value the program gets none
    const same = { ...c, bt_max_download: 300, nzb_max_download: 300, http_max_download: 300, ftp_max_download: 300 };
    const { status } = toSnapshot("4.1-5012", [], same, true, false, quiet);
    expect(status).not.toHaveProperty("speedLimitBps");
    expect(status.uploadLimitBps).toBe(20 * 1024);
  });

  it("takes eMule's upload limit in only while eMule is switched on", () => {
    const c = { ...config(), emule_enabled: true };
    const up = uploadLimitFields(c);
    expect(up).toEqual(["bt_max_upload", "emule_max_upload"]);
    // bt_max_upload and emule_max_upload are both 20 in the live answer
    expect(limitBps(c, up, true)).toBe(20 * 1024);
    expect(limitBps({ ...c, emule_max_upload: 0 }, up, true)).toBeNull();
  });

  it("reads version and manager right, and refuses an answer without the version", () => {
    expect(infoOf({ is_manager: true, version: 5012, version_string: "4.1-5012" })).toEqual({
      version: "4.1-5012",
      manager: true,
    });
    expect(infoOf({ version_string: "4.1-5012" }).manager).toBe(false);
    expect(() => infoOf({ version: 5012 })).toThrow(ProtocolError);
  });
});
