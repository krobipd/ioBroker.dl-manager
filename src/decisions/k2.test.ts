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

/**
 * A precondition of this guard — it throws when the guard cannot run, it asserts nothing of the rule.
 *
 * @param ok what has to hold for the guard to run
 * @param what what is missing otherwise
 */
function need(ok: unknown, what: string): asserts ok {
  if (!ok) {
    throw new Error(`the guard cannot run: ${what}`);
  }
}

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

type Mapper = (raw: string | number, debug: (msg: string) => void) => Status;

/** The raw statuses each program reports — what this guard hands each program's status mapping. */
const RAWS = {
  aria2: ["active", "active:seed", "active:0", "waiting", "paused", "complete", "error"],
  deluge: [
    "Downloading",
    "Downloading:idle",
    "Seeding",
    "Paused",
    "Paused:done",
    "Queued",
    "Checking",
    "Allocating",
    "Moving",
    "Error",
  ],
  downloadstation: [
    "waiting",
    "downloading",
    "paused",
    "paused:done",
    "finishing",
    "finished",
    "hash_checking",
    "seeding",
    "filehosting_waiting",
    "extracting",
    "error",
  ],
  flood: ["checking", "moving", "error", "stopped", "stopped:done", "seeding", "downloading", "downloading:inactive"],
  freebox: [
    "stopped",
    "stopping",
    "queued",
    "starting",
    "downloading",
    "checking",
    "checking:nzb",
    "repairing",
    "extracting",
    "seeding",
    "done",
    "error",
    "retry",
  ],
  hadouken: [
    "Status_Error",
    "Status_Checking",
    "Status_Paused",
    "Status_Paused:done",
    "Status_Up",
    "Status_Down",
    "Status_Queued_Up",
    "Status_Queued_Down",
  ],
  jdownloader: [
    "FinalLinkState:FINISHED",
    "FinalLinkState:FINISHED_MIRROR",
    "FinalLinkState:FINISHED_SHA256",
    "FinalLinkState:FAILED",
    "FinalLinkState:FAILED_CRC32",
    "FinalLinkState:OFFLINE",
    "FinalLinkState:PLUGIN_DEFECT",
    "ExtractionStatus:RUNNING",
    "ExtractionStatus:ERROR_PW",
    "ExtractionStatus:ERROR_CRC",
    "ExtractionStatus:SUCCESSFUL",
    "PluginProgress:DOWNLOAD",
    "PluginProgress:WAIT",
    "PluginProgress:CAPTCHA",
    "PluginProgress:HASH",
    "PluginProgress:EXTRACTION",
    "enabled:false",
    "skipped:true",
    "ConditionalSkipReason:WaitingSkipReason",
    "none",
    "status-text-only:Fertig",
  ],
  nzbget: [
    "q:QUEUED",
    "q:PAUSED",
    "q:DOWNLOADING",
    "q:FETCHING",
    "q:DOWNLOADING:globalPause",
    "q:PP_QUEUED",
    "q:LOADING_PARS",
    "q:VERIFYING_SOURCES",
    "q:REPAIRING",
    "q:VERIFYING_REPAIRED",
    "q:RENAMING",
    "q:UNPACKING",
    "q:MOVING",
    "q:POST_UNPACK_RENAMING",
    "q:POST_DOWNLOAD_RENAMING",
    "q:EXECUTING_SCRIPT",
    "q:PP_FINISHED",
    "q:QS_QUEUED",
    "q:QS_EXECUTING",
    "h:SUCCESS/ALL",
    "h:SUCCESS/UNPACK",
    "h:SUCCESS/PAR",
    "h:SUCCESS/HEALTH",
    "h:SUCCESS/GOOD",
    "h:SUCCESS/MARK",
    "h:WARNING/SCRIPT",
    "h:WARNING/SPACE",
    "h:WARNING/PASSWORD",
    "h:WARNING/DAMAGED",
    "h:WARNING/REPAIRABLE",
    "h:WARNING/HEALTH",
    "h:WARNING/SKIPPED",
    "h:FAILURE/PAR",
    "h:FAILURE/UNPACK",
    "h:FAILURE/MOVE",
    "h:FAILURE/SCAN",
    "h:FAILURE/BAD",
    "h:FAILURE/HEALTH",
    "h:FAILURE/FETCH",
    "h:FAILURE/INTERNAL_ERROR",
  ],
  nzbvortex: [
    "0", // Waiting
    "1", // Downloading
    "2", // Waiting for save
    "3", // Saving
    "4", // Saved
    "5", // Password request
    "6", // Queued for processing
    "7", // User wait for processing
    "8", // Checking
    "9", // Repairing
    "10", // Joining
    "11", // Wait for further processing
    "12", // Joining
    "13", // Wait for uncompress
    "14", // Uncompressing
    "15", // Wait for cleanup
    "16", // Cleaning up
    "17", // Cleaned up
    "18", // Moving to completed
    "19", // Move completed
    "20", // Done
    "21", // Uncompress failed
    "22", // Check failed, data corrupt
    "23", // Move failed
    "24", // Badly encoded download (uuencoded)
    "paused",
  ],
  pyload: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  qbittorrent: [
    "downloading",
    "forcedDL",
    "metaDL",
    "forcedMetaDL",
    "checkingDL",
    "checkingUP",
    "checkingResumeData",
    "allocating",
    "stalledDL",
    "queuedDL",
    "stoppedDL",
    "pausedDL",
    "uploading",
    "stalledUP",
    "forcedUP",
    "queuedUP",
    "stoppedUP",
    "pausedUP",
    "moving",
    "error",
    "missingFiles",
    "unknown",
  ],
  rqbit: [
    "initializing:left",
    "initializing:done",
    "live:left",
    "live:stalled",
    "live:done",
    "paused:left",
    "paused:done",
    "error:left",
    "error:done",
  ],
  rtorrent: [
    "checking",
    "hashing",
    "active:left",
    "active:stalled",
    "active:done",
    "paused:left",
    "paused:done",
    "stopped:left",
    "stopped:done",
    "stopped:error",
    "closed:left",
    "closed:done",
    "closed:error",
  ],
  sabnzbd: [
    "q:Downloading",
    "q:Fetching",
    "q:Grabbing",
    "q:Propagating",
    "q:Checking",
    "q:Queued",
    "q:Paused",
    "h:Queued",
    "h:QuickCheck",
    "h:Verifying",
    "h:Repairing",
    "h:Fetching",
    "h:Extracting",
    "h:Moving",
    "h:Running",
    "h:Completed",
    "h:Failed",
    "q:Idle",
  ],
  transmission: [
    "0:0:left",
    "0:0:done",
    "1:0:left",
    "2:0:left",
    "3:0:left",
    "4:0:left",
    "4:0:stalled",
    "5:0:done",
    "6:0:done",
    "4:1:left",
    "4:2:left",
    "6:2:done",
    "0:2:left",
    "4:3:left",
    "0:3:done",
  ],
  tribler: [
    "ALLOCATING_DISKSPACE",
    "WAITING_FOR_HASHCHECK",
    "HASHCHECKING",
    "METADATA",
    "DOWNLOADING",
    "DOWNLOADING:idle",
    "SEEDING",
    "STOPPED",
    "STOPPED:done",
    "STOPPED_ON_ERROR",
    "LOADING",
    "CIRCUITS",
    "EXIT_NODES",
    "MOVING",
    "QUEUED",
    "QUEUED:done",
  ],
  utorrent: [
    "Status_Paused",
    "Status_Paused:done",
    "Status_Up",
    "Status_Down",
    "Status_Checking",
    "Status_Error",
    "Status_Queued_Up",
    "Status_Queued_Down",
    "Status_Completed",
    "Status_Incomplete",
  ],
} as const satisfies Record<string, readonly (string | number)[]>;

/** Every program of the catalog with its status mapping and its raw statuses — a type without one fails the type check. */
const PROGRAMS: Record<ProgramType, { raws: readonly (string | number)[]; map: Mapper }> = {
  jdownloader: { raws: RAWS.jdownloader, map: jdownloader.mapJdStatus },
  "jdownloader-cloud": { raws: RAWS.jdownloader, map: jdownloader.mapJdStatus },
  qbittorrent: { raws: RAWS.qbittorrent, map: qbittorrent.mapQbState },
  transmission: { raws: RAWS.transmission, map: transmission.mapTrStatus },
  deluge: { raws: RAWS.deluge, map: deluge.mapDlStatus },
  sabnzbd: { raws: RAWS.sabnzbd, map: sabnzbd.mapSabStatus },
  nzbget: { raws: RAWS.nzbget, map: nzbget.mapNzbStatus },
  aria2: { raws: RAWS.aria2, map: aria2.mapAriaStatus },
  pyload: { raws: RAWS.pyload, map: pyload.mapPyStatus },
  rqbit: { raws: RAWS.rqbit, map: rqbit.mapRqStatus },
  rtorrent: { raws: RAWS.rtorrent, map: rtorrent.mapRtStatus },
  tribler: { raws: RAWS.tribler, map: tribler.mapTblStatus },
  flood: { raws: RAWS.flood, map: flood.mapFloodStatus },
  vuze: { raws: RAWS.transmission, map: transmission.mapTrStatus },
  utorrent: { raws: RAWS.utorrent, map: utorrent.mapUtStatus },
  hadouken: { raws: RAWS.hadouken, map: hadouken.mapHkStatus },
  downloadstation: { raws: RAWS.downloadstation, map: downloadstation.mapDsStatus },
  nzbvortex: { raws: RAWS.nzbvortex, map: nzbvortex.mapNvStatus },
  freebox: { raws: RAWS.freebox, map: freebox.mapFbxStatus },
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
    for (const { type } of CATALOG) {
      const { raws, map } = PROGRAMS[type];
      need(raws.length > 0, `no raw status of ${type}`);
      for (const raw of raws) {
        expect(STATUSES, `${type} ${raw}`).toContain(map(raw, quiet));
      }
    }
  });

  it("writes only statuses of the list into a download", () => {
    const raws = RAWS.qbittorrent.map(String);
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
