// Core decision K2 (accepted 2026-10-22, krobi: "alle soweit ok"): one status list for all programs — every download
// shows the same status whatever the program: queued, downloading, waiting, paused, checking, postprocessing, seeding,
// completed, failed; a Blockly script works the same for every program.
import { describe, expect, it, vi } from "vitest";
import { STATUSES, type Status } from "../lib/core/model";
import { ProgramTree, type TreeAdapter } from "../lib/core/tree";
import * as aria2 from "../lib/programs/aria2/map";
import * as deluge from "../lib/programs/deluge/map";
import * as jdownloader from "../lib/programs/jdownloader/map";
import * as nzbget from "../lib/programs/nzbget/map";
import * as pyload from "../lib/programs/pyload/map";
import * as qbittorrent from "../lib/programs/qbittorrent/map";
import * as sabnzbd from "../lib/programs/sabnzbd/map";
import * as transmission from "../lib/programs/transmission/map";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

type Mapper = (raw: string | number, debug: (msg: string) => void) => Status;
const PROGRAMS: Record<string, { table: readonly (readonly [string | number, Status])[]; map: Mapper }> = {
  aria2: { table: aria2.statusTable, map: aria2.mapAriaStatus },
  deluge: { table: deluge.statusTable, map: deluge.mapDlStatus },
  jdownloader: { table: jdownloader.statusTable, map: jdownloader.mapJdStatus },
  nzbget: { table: nzbget.statusTable, map: nzbget.mapNzbStatus },
  pyload: { table: pyload.statusTable, map: pyload.mapPyStatus },
  qbittorrent: { table: qbittorrent.statusTable, map: qbittorrent.mapQbState },
  sabnzbd: { table: sabnzbd.statusTable, map: sabnzbd.mapSabStatus },
  transmission: { table: transmission.statusTable, map: transmission.mapTrStatus },
};
const quiet = (): void => undefined;

describe("K2 one status list for all programs", () => {
  it("is the one list of nine statuses", () => {
    expect([...STATUSES].sort()).toEqual(
      [
        "queued",
        "downloading",
        "waiting",
        "paused",
        "checking",
        "postprocessing",
        "seeding",
        "completed",
        "failed",
      ].sort(),
    );
  });

  it("maps every raw status of every program onto that list", () => {
    for (const [program, { table, map }] of Object.entries(PROGRAMS)) {
      expect(table.length, program).toBeGreaterThan(0);
      for (const [raw, status] of table) {
        expect(STATUSES, `${program} ${raw}`).toContain(status);
        expect(map(raw, quiet), `${program} ${raw}`).toBe(status);
      }
    }
  });

  it("writes only statuses of the list into a download, whatever the program reports", () => {
    const m = new qbittorrent.MaindataState();
    m.apply({
      full_update: true,
      torrents: Object.fromEntries(qbittorrent.statusTable.map(([raw]) => [`h-${raw}`, { name: raw, state: raw }])),
    });
    const items = qbittorrent.toSnapshot("v5.0.0", m, false, quiet).items;
    expect(items).toHaveLength(qbittorrent.statusTable.length);
    for (const i of items) {
      expect(STATUSES, i.name).toContain(i.status);
    }
  });

  it("offers exactly that list on the status datapoint of every download", async () => {
    const objects = new Map<string, ioBroker.PartialObject>();
    const a: TreeAdapter = {
      namespace: "dl-manager.0",
      log: { debug: quiet, info: quiet, warn: quiet },
      extendObject: (id, obj) => Promise.resolve(void objects.set(id, obj)),
      delObject: () => Promise.resolve(),
      knownObject: () => undefined,
      getForeignObjects: () => Promise.resolve({}),
      knownValue: () => undefined,
      setState: () => Promise.resolve(),
      setStateChanged: () => Promise.resolve(),
    };
    const tree = new ProgramTree(
      a,
      "p",
      "P",
      { type: "qbittorrent", capabilities: new Set(), extras: [] },
      {
        scope: "all",
        limit: 0,
      },
    );
    await tree.sync({
      status: { version: "1", paused: false, downloadBps: 0 },
      items: [
        { key: "k", name: "k", status: "queued", sizeBytes: 1, doneBytes: 0, speedBps: 0, etaSeconds: null, error: "" },
      ],
      complete: true,
    });
    const status = [...objects].find(([id]) => id.endsWith(".status"))?.[1];
    expect(Object.keys((status?.common as { states?: object } | undefined)?.states ?? {})).toEqual([...STATUSES]);
  });
});
