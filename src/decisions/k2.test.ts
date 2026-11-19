// Core decision K2 (accepted 2026-10-22, krobi: "alle soweit ok"): one status list for all programs — every download
// shows the same status whatever the program: queued, downloading, waiting, paused, checking, postprocessing, seeding,
// completed, failed; a Blockly script works the same for every program.
import { describe, expect, it, vi } from "vitest";
import { STATUSES, type Status } from "../lib/core/model";
import { ProgramTree, type TreeAdapter } from "../lib/core/tree";
import { CATALOG, type ProgramType } from "../lib/programs/catalog";
import * as aria2 from "../lib/programs/aria2/map";
import * as deluge from "../lib/programs/deluge/map";
import * as downloadstation from "../lib/programs/downloadstation/map";
import * as flood from "../lib/programs/flood/map";
import * as freebox from "../lib/programs/freebox/map";
import * as hadouken from "../lib/programs/hadouken/map";
import * as jdownloader from "../lib/programs/jdownloader/map";
import * as nzbget from "../lib/programs/nzbget/map";
import * as nzbvortex from "../lib/programs/nzbvortex/map";
import * as pyload from "../lib/programs/pyload/map";
import * as qbittorrent from "../lib/programs/qbittorrent/map";
import * as rqbit from "../lib/programs/rqbit/map";
import * as rtorrent from "../lib/programs/rtorrent/map";
import * as sabnzbd from "../lib/programs/sabnzbd/map";
import * as transmission from "../lib/programs/transmission/map";
import * as tribler from "../lib/programs/tribler/map";
import * as utorrent from "../lib/programs/utorrent/map";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

type Mapper = (raw: string | number, debug: (msg: string) => void) => Status;
type Row = readonly [string | number, Status];

/** The status each raw status of each program shows — written here, never read from the program's own table. */
const EXPECTED = {
  aria2: [
    ["active", "downloading"],
    ["active:seed", "seeding"],
    ["active:0", "waiting"],
    ["waiting", "queued"],
    ["paused", "paused"],
    ["complete", "completed"],
    ["error", "failed"],
  ],
  deluge: [
    ["Downloading", "downloading"],
    ["Downloading:idle", "waiting"],
    ["Seeding", "seeding"],
    ["Paused", "paused"],
    ["Paused:done", "completed"],
    ["Queued", "queued"],
    ["Checking", "checking"],
    ["Allocating", "checking"],
    ["Moving", "postprocessing"],
    ["Error", "failed"],
  ],
  downloadstation: [
    ["waiting", "queued"],
    ["downloading", "downloading"],
    ["paused", "paused"],
    ["paused:done", "completed"],
    ["finishing", "postprocessing"],
    ["finished", "completed"],
    ["hash_checking", "checking"],
    ["seeding", "seeding"],
    ["filehosting_waiting", "waiting"],
    ["extracting", "postprocessing"],
    ["error", "failed"],
  ],
  flood: [
    ["checking", "checking"],
    ["moving", "postprocessing"],
    ["error", "failed"],
    ["stopped", "paused"],
    ["stopped:done", "completed"],
    ["seeding", "seeding"],
    ["downloading", "downloading"],
    ["downloading:inactive", "waiting"],
  ],
  freebox: [
    ["stopped", "paused"],
    ["stopping", "paused"],
    ["queued", "queued"],
    ["starting", "checking"],
    ["downloading", "downloading"],
    ["checking", "checking"],
    ["checking:nzb", "postprocessing"],
    ["repairing", "postprocessing"],
    ["extracting", "postprocessing"],
    ["seeding", "seeding"],
    ["done", "completed"],
    ["error", "failed"],
    ["retry", "queued"],
  ],
  hadouken: [
    ["Status_Error", "failed"],
    ["Status_Checking", "checking"],
    ["Status_Paused", "paused"],
    ["Status_Paused:done", "completed"],
    ["Status_Up", "seeding"],
    ["Status_Down", "downloading"],
    ["Status_Queued_Up", "seeding"],
    ["Status_Queued_Down", "queued"],
  ],
  jdownloader: [
    ["FinalLinkState:FINISHED", "completed"],
    ["FinalLinkState:FINISHED_MIRROR", "completed"],
    ["FinalLinkState:FINISHED_SHA256", "completed"],
    ["FinalLinkState:FAILED", "failed"],
    ["FinalLinkState:FAILED_CRC32", "failed"],
    ["FinalLinkState:OFFLINE", "failed"],
    ["FinalLinkState:PLUGIN_DEFECT", "failed"],
    ["ExtractionStatus:RUNNING", "postprocessing"],
    ["ExtractionStatus:ERROR_PW", "failed"],
    ["ExtractionStatus:ERROR_CRC", "failed"],
    ["ExtractionStatus:SUCCESSFUL", "completed"],
    ["PluginProgress:DOWNLOAD", "downloading"],
    ["PluginProgress:WAIT", "waiting"],
    ["PluginProgress:CAPTCHA", "waiting"],
    ["PluginProgress:HASH", "checking"],
    ["PluginProgress:EXTRACTION", "postprocessing"],
    ["enabled:false", "paused"],
    ["skipped:true", "paused"],
    ["ConditionalSkipReason:WaitingSkipReason", "waiting"],
    ["none", "queued"],
    ["status-text-only:Fertig", "queued"],
  ],
  nzbget: [
    ["q:QUEUED", "queued"],
    ["q:PAUSED", "paused"],
    ["q:DOWNLOADING", "downloading"],
    ["q:FETCHING", "downloading"],
    ["q:DOWNLOADING:globalPause", "paused"],
    ["q:PP_QUEUED", "postprocessing"],
    ["q:LOADING_PARS", "postprocessing"],
    ["q:VERIFYING_SOURCES", "postprocessing"],
    ["q:REPAIRING", "postprocessing"],
    ["q:VERIFYING_REPAIRED", "postprocessing"],
    ["q:RENAMING", "postprocessing"],
    ["q:UNPACKING", "postprocessing"],
    ["q:MOVING", "postprocessing"],
    ["q:POST_UNPACK_RENAMING", "postprocessing"],
    ["q:POST_DOWNLOAD_RENAMING", "postprocessing"],
    ["q:EXECUTING_SCRIPT", "postprocessing"],
    ["q:PP_FINISHED", "postprocessing"],
    ["q:QS_QUEUED", "postprocessing"],
    ["q:QS_EXECUTING", "postprocessing"],
    ["h:SUCCESS/ALL", "completed"],
    ["h:SUCCESS/UNPACK", "completed"],
    ["h:SUCCESS/PAR", "completed"],
    ["h:SUCCESS/HEALTH", "completed"],
    ["h:SUCCESS/GOOD", "completed"],
    ["h:SUCCESS/MARK", "completed"],
    ["h:WARNING/SCRIPT", "completed"],
    ["h:WARNING/SPACE", "failed"],
    ["h:WARNING/PASSWORD", "failed"],
    ["h:WARNING/DAMAGED", "failed"],
    ["h:WARNING/REPAIRABLE", "failed"],
    ["h:WARNING/HEALTH", "failed"],
    ["h:WARNING/SKIPPED", "failed"],
    ["h:FAILURE/PAR", "failed"],
    ["h:FAILURE/UNPACK", "failed"],
    ["h:FAILURE/MOVE", "failed"],
    ["h:FAILURE/SCAN", "failed"],
    ["h:FAILURE/BAD", "failed"],
    ["h:FAILURE/HEALTH", "failed"],
    ["h:FAILURE/FETCH", "failed"],
    ["h:FAILURE/INTERNAL_ERROR", "failed"],
  ],
  nzbvortex: [
    ["0", "queued"], // Waiting
    ["1", "downloading"], // Downloading
    ["2", "downloading"], // Waiting for save
    ["3", "downloading"], // Saving
    ["4", "postprocessing"], // Saved
    ["5", "waiting"], // Password request
    ["6", "postprocessing"], // Queued for processing
    ["7", "waiting"], // User wait for processing
    ["8", "postprocessing"], // Checking
    ["9", "postprocessing"], // Repairing
    ["10", "postprocessing"], // Joining
    ["11", "postprocessing"], // Wait for further processing
    ["12", "postprocessing"], // Joining
    ["13", "postprocessing"], // Wait for uncompress
    ["14", "postprocessing"], // Uncompressing
    ["15", "postprocessing"], // Wait for cleanup
    ["16", "postprocessing"], // Cleaning up
    ["17", "postprocessing"], // Cleaned up
    ["18", "postprocessing"], // Moving to completed
    ["19", "postprocessing"], // Move completed
    ["20", "completed"], // Done
    ["21", "failed"], // Uncompress failed
    ["22", "failed"], // Check failed, data corrupt
    ["23", "failed"], // Move failed
    ["24", "failed"], // Badly encoded download (uuencoded)
    ["paused", "paused"],
  ],
  pyload: [
    [0, "completed"],
    [1, "failed"],
    [2, "queued"],
    [3, "queued"],
    [4, "completed"],
    [5, "waiting"],
    [6, "waiting"],
    [7, "downloading"],
    [8, "failed"],
    [9, "paused"],
    [10, "queued"],
    [11, "queued"],
    [12, "downloading"],
    [13, "postprocessing"],
    [14, "queued"],
  ],
  qbittorrent: [
    ["downloading", "downloading"],
    ["forcedDL", "downloading"],
    ["metaDL", "checking"],
    ["forcedMetaDL", "checking"],
    ["checkingDL", "checking"],
    ["checkingUP", "checking"],
    ["checkingResumeData", "checking"],
    ["allocating", "checking"],
    ["stalledDL", "waiting"],
    ["queuedDL", "queued"],
    ["stoppedDL", "paused"],
    ["pausedDL", "paused"],
    ["uploading", "seeding"],
    ["stalledUP", "seeding"],
    ["forcedUP", "seeding"],
    ["queuedUP", "seeding"],
    ["stoppedUP", "completed"],
    ["pausedUP", "completed"],
    ["moving", "postprocessing"],
    ["error", "failed"],
    ["missingFiles", "failed"],
    ["unknown", "queued"],
  ],
  rqbit: [
    ["initializing:left", "checking"],
    ["initializing:done", "checking"],
    ["live:left", "downloading"],
    ["live:stalled", "waiting"],
    ["live:done", "seeding"],
    ["paused:left", "paused"],
    ["paused:done", "completed"],
    ["error:left", "failed"],
    ["error:done", "failed"],
  ],
  rtorrent: [
    ["checking", "checking"],
    ["hashing", "queued"],
    ["active:left", "downloading"],
    ["active:stalled", "waiting"],
    ["active:done", "seeding"],
    ["paused:left", "paused"],
    ["paused:done", "completed"],
    ["stopped:left", "paused"],
    ["stopped:done", "completed"],
    ["stopped:error", "failed"],
    ["closed:left", "paused"],
    ["closed:done", "completed"],
    ["closed:error", "failed"],
  ],
  sabnzbd: [
    ["q:Downloading", "downloading"],
    ["q:Fetching", "downloading"],
    ["q:Grabbing", "downloading"],
    ["q:Propagating", "waiting"],
    ["q:Checking", "checking"],
    ["q:Queued", "queued"],
    ["q:Paused", "paused"],
    ["h:Queued", "postprocessing"],
    ["h:QuickCheck", "postprocessing"],
    ["h:Verifying", "postprocessing"],
    ["h:Repairing", "postprocessing"],
    ["h:Fetching", "postprocessing"],
    ["h:Extracting", "postprocessing"],
    ["h:Moving", "postprocessing"],
    ["h:Running", "postprocessing"],
    ["h:Completed", "completed"],
    ["h:Failed", "failed"],
    ["q:Idle", "queued"],
  ],
  transmission: [
    ["0:0:left", "paused"],
    ["0:0:done", "completed"],
    ["1:0:left", "checking"],
    ["2:0:left", "checking"],
    ["3:0:left", "queued"],
    ["4:0:left", "downloading"],
    ["4:0:stalled", "waiting"],
    ["5:0:done", "seeding"],
    ["6:0:done", "seeding"],
    ["4:1:left", "downloading"],
    ["4:2:left", "downloading"],
    ["6:2:done", "seeding"],
    ["0:2:left", "failed"],
    ["4:3:left", "failed"],
    ["0:3:done", "failed"],
  ],
  tribler: [
    ["ALLOCATING_DISKSPACE", "checking"],
    ["WAITING_FOR_HASHCHECK", "checking"],
    ["HASHCHECKING", "checking"],
    ["METADATA", "checking"],
    ["DOWNLOADING", "downloading"],
    ["DOWNLOADING:idle", "waiting"],
    ["SEEDING", "seeding"],
    ["STOPPED", "paused"],
    ["STOPPED:done", "completed"],
    ["STOPPED_ON_ERROR", "failed"],
    ["LOADING", "waiting"],
    ["CIRCUITS", "waiting"],
    ["EXIT_NODES", "waiting"],
    ["MOVING", "postprocessing"],
    ["QUEUED", "queued"],
    ["QUEUED:done", "seeding"],
  ],
  utorrent: [
    ["Status_Paused", "paused"],
    ["Status_Paused:done", "completed"],
    ["Status_Up", "seeding"],
    ["Status_Down", "downloading"],
    ["Status_Checking", "checking"],
    ["Status_Error", "failed"],
    ["Status_Queued_Up", "seeding"],
    ["Status_Queued_Down", "queued"],
    ["Status_Completed", "completed"],
    ["Status_Incomplete", "paused"],
  ],
} as const satisfies Record<string, readonly Row[]>;

/** Every program of the catalog with its status mapping and what it must show — a type without one fails the type check. */
const PROGRAMS: Record<ProgramType, { expected: readonly Row[]; map: Mapper }> = {
  jdownloader: { expected: EXPECTED.jdownloader, map: jdownloader.mapJdStatus },
  "jdownloader-cloud": { expected: EXPECTED.jdownloader, map: jdownloader.mapJdStatus },
  qbittorrent: { expected: EXPECTED.qbittorrent, map: qbittorrent.mapQbState },
  transmission: { expected: EXPECTED.transmission, map: transmission.mapTrStatus },
  deluge: { expected: EXPECTED.deluge, map: deluge.mapDlStatus },
  sabnzbd: { expected: EXPECTED.sabnzbd, map: sabnzbd.mapSabStatus },
  nzbget: { expected: EXPECTED.nzbget, map: nzbget.mapNzbStatus },
  aria2: { expected: EXPECTED.aria2, map: aria2.mapAriaStatus },
  pyload: { expected: EXPECTED.pyload, map: pyload.mapPyStatus },
  rqbit: { expected: EXPECTED.rqbit, map: rqbit.mapRqStatus },
  rtorrent: { expected: EXPECTED.rtorrent, map: rtorrent.mapRtStatus },
  tribler: { expected: EXPECTED.tribler, map: tribler.mapTblStatus },
  flood: { expected: EXPECTED.flood, map: flood.mapFloodStatus },
  vuze: { expected: EXPECTED.transmission, map: transmission.mapTrStatus },
  utorrent: { expected: EXPECTED.utorrent, map: utorrent.mapUtStatus },
  hadouken: { expected: EXPECTED.hadouken, map: hadouken.mapHkStatus },
  downloadstation: { expected: EXPECTED.downloadstation, map: downloadstation.mapDsStatus },
  nzbvortex: { expected: EXPECTED.nzbvortex, map: nzbvortex.mapNvStatus },
  freebox: { expected: EXPECTED.freebox, map: freebox.mapFbxStatus },
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
    expect(Object.keys(PROGRAMS).sort()).toEqual(CATALOG.map(p => p.type).sort());
    for (const { type } of CATALOG) {
      const { expected, map } = PROGRAMS[type];
      expect(expected.length, type).toBeGreaterThan(0);
      for (const [raw, status] of expected) {
        expect(STATUSES, `${type} ${raw}`).toContain(status);
        expect(map(raw, quiet), `${type} ${raw}`).toBe(status);
      }
    }
  });

  it("writes only statuses of the list into a download, whatever the program reports", () => {
    // the raw statuses of every program, and one no program knows
    const raws = [
      ...new Set([...Object.values(EXPECTED).flatMap(t => t.map(([raw]) => String(raw))), "no-such-state"]),
    ];
    const m = new qbittorrent.MaindataState();
    m.apply({
      full_update: true,
      torrents: Object.fromEntries(raws.map(raw => [`h-${raw}`, { name: raw, state: raw }])),
    });
    const items = qbittorrent.toSnapshot("v5.0.0", m, false, quiet).items;
    expect(items).toHaveLength(raws.length);
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
      removeObject: () => Promise.resolve(),
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
