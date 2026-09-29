import type { I18nKey } from "../i18n";
import {
  ACTIVE,
  countActive,
  countQueued,
  type Capability,
  type Command,
  type DownloadItem,
  type ProgramSnapshot,
} from "./model";
import { fromMBps, percent, round2, toGB, toMBps } from "./units";

/**
 * One datapoint the core creates for a program or a download.
 *
 * @template S what the value is read from — the program's snapshot or one download
 */
export interface DatapointDef<S = unknown> {
  /** Id below the device or the download channel. */
  id: string;
  /** Value type. */
  type: ioBroker.CommonType;
  /** Role (checked against the repochecker whitelist by the fleet gate). */
  role: string;
  /** Unit. */
  unit?: string;
  /** Readable. */
  read: boolean;
  /** Writable. */
  write: boolean;
  /** Only created when the driver has this capability. */
  capability?: Capability;
  /** i18n key of the name. */
  nameKey: I18nKey;
  /** i18n key of the explanation. */
  descKey?: I18nKey;
  /** The value each poll writes; none for a button or a value written by an event (last finished, last failed). */
  value?(src: S): ioBroker.StateValue;
  /**
   * What a user write means for the program (writable datapoints); null when the value asks for nothing (a button
   * written false, an empty link). A datapoint that is only written is confirmed with ack right away — no poll ever
   * reads it back.
   *
   * @param val the written value
   * @param key the download's raw key (download datapoints only)
   */
  command?(val: ioBroker.StateValue, key: string): Command | null;
}

type Spec<S> = Omit<DatapointDef<S>, "read" | "write"> & Partial<Pick<DatapointDef<S>, "read" | "write">>;
const pr = (d: Spec<ProgramSnapshot>): DatapointDef<ProgramSnapshot> => ({ read: true, write: false, ...d });
const ir = (d: Spec<DownloadItem>): DatapointDef<DownloadItem> => ({ read: true, write: false, ...d });

/** Datapoints directly below a program's device. */
export const PROGRAM_DATAPOINTS: readonly DatapointDef<ProgramSnapshot>[] = [
  pr({
    id: "online",
    value: () => true,
    type: "boolean",
    role: "indicator.reachable",
    nameKey: "online",
    descKey: "descOnline",
  }),
  pr({ id: "error", value: () => "", type: "string", role: "text", nameKey: "error", descKey: "descError" }),
  pr({ id: "version", value: s => s.status.version, type: "string", role: "text", nameKey: "version" }),
  pr({
    id: "downloading",
    value: s => s.items.some(i => ACTIVE.has(i.status)),
    type: "boolean",
    role: "indicator.working",
    nameKey: "downloading",
    descKey: "descDownloading",
  }),
  pr({
    id: "paused",
    command: val => ({ kind: val === true ? "pauseAll" : "resumeAll" }),
    value: s => s.status.paused,
    type: "boolean",
    role: "switch",
    write: true,
    capability: "globalPause",
    nameKey: "paused",
    descKey: "descPaused",
  }),
  pr({
    id: "downloadSpeed",
    value: s => toMBps(s.status.downloadBps),
    type: "number",
    role: "value",
    unit: "MB/s",
    nameKey: "downloadSpeed",
  }),
  pr({
    id: "uploadSpeed",
    value: s => toMBps(s.status.uploadBps),
    type: "number",
    role: "value",
    unit: "MB/s",
    capability: "upload",
    nameKey: "uploadSpeed",
  }),
  pr({
    id: "speedLimit",
    command: val => ({ kind: "setSpeedLimit", bps: fromMBps(val) }),
    value: s => toMBps(s.status.speedLimitBps),
    type: "number",
    role: "level",
    unit: "MB/s",
    write: true,
    capability: "speedLimit",
    nameKey: "speedLimit",
    descKey: "descSpeedLimit",
  }),
  pr({
    id: "uploadLimit",
    command: val => ({ kind: "setUploadLimit", bps: fromMBps(val) }),
    value: s => toMBps(s.status.uploadLimitBps),
    type: "number",
    role: "level",
    unit: "MB/s",
    write: true,
    capability: "uploadLimit",
    nameKey: "uploadLimit",
    descKey: "descUploadLimit",
  }),
  pr({
    id: "altSpeed",
    command: val => ({ kind: "setAltSpeed", on: val === true }),
    value: s => s.status.altSpeed === true,
    type: "boolean",
    role: "switch",
    write: true,
    capability: "altSpeed",
    nameKey: "altSpeed",
    descKey: "descAltSpeed",
  }),
  pr({
    id: "freeSpace",
    value: s => toGB(s.status.freeSpaceBytes),
    type: "number",
    role: "value",
    unit: "GB",
    capability: "freeSpace",
    nameKey: "freeSpace",
    descKey: "descFreeSpace",
  }),
  pr({
    id: "active",
    value: s => countActive(s.items),
    type: "number",
    role: "value",
    nameKey: "active",
  }),
  pr({
    id: "queued",
    value: s => countQueued(s.items),
    type: "number",
    role: "value",
    nameKey: "queued",
  }),
  pr({ id: "total", value: s => s.items.length, type: "number", role: "value", nameKey: "total" }),
  pr({
    id: "add",
    command: val => {
      const url = typeof val === "string" ? val.trim() : "";
      return url ? { kind: "add", url } : null;
    },
    type: "string",
    role: "text",
    read: false,
    write: true,
    capability: "add",
    nameKey: "add",
    descKey: "descAdd",
  }),
  pr({ id: "last.finished", type: "string", role: "text", nameKey: "lastFinished", descKey: "descLastFinished" }),
  pr({ id: "last.finishedTime", type: "number", role: "date", nameKey: "lastFinishedTime" }),
  pr({ id: "last.failed", type: "string", role: "text", nameKey: "lastFailed", descKey: "descLastFailed" }),
  pr({ id: "last.failedTime", type: "number", role: "date", nameKey: "lastFailedTime" }),
];

/** Datapoints in each download's channel. */
export const ITEM_DATAPOINTS: readonly DatapointDef<DownloadItem>[] = [
  ir({ id: "status", value: i => i.status, type: "string", role: "text", nameKey: "status" }),
  ir({
    id: "progress",
    value: i => percent(i.doneBytes, i.sizeBytes),
    type: "number",
    role: "value",
    unit: "%",
    nameKey: "progress",
  }),
  ir({ id: "size", value: i => toGB(i.sizeBytes), type: "number", role: "value", unit: "GB", nameKey: "size" }),
  ir({
    id: "downloaded",
    value: i => toGB(i.doneBytes),
    type: "number",
    role: "value",
    unit: "GB",
    nameKey: "downloaded",
  }),
  ir({
    id: "speed",
    value: i => toMBps(i.speedBps),
    type: "number",
    role: "value",
    unit: "MB/s",
    capability: "itemSpeed",
    nameKey: "speed",
  }),
  ir({
    id: "uploadSpeed",
    value: i => toMBps(i.uploadBps),
    type: "number",
    role: "value",
    unit: "MB/s",
    capability: "upload",
    nameKey: "uploadSpeed",
  }),
  ir({
    id: "ratio",
    value: i => (typeof i.ratio === "number" ? round2(i.ratio) : null),
    type: "number",
    role: "value",
    capability: "upload",
    nameKey: "ratio",
    descKey: "descRatio",
  }),
  ir({
    id: "eta",
    value: i => i.etaSeconds,
    type: "number",
    role: "value.timer",
    unit: "s",
    capability: "itemEta",
    nameKey: "eta",
    descKey: "descEta",
  }),
  ir({
    id: "added",
    value: i => i.addedMs ?? null,
    type: "number",
    role: "date",
    capability: "itemAdded",
    nameKey: "added",
  }),
  ir({
    id: "finished",
    value: i => i.finishedMs ?? null,
    type: "number",
    role: "date",
    capability: "itemFinished",
    nameKey: "finished",
  }),
  ir({
    id: "category",
    value: i => i.category ?? "",
    type: "string",
    role: "text",
    capability: "category",
    nameKey: "category",
  }),
  ir({
    id: "error",
    value: i => i.error,
    type: "string",
    role: "text",
    capability: "itemError",
    nameKey: "itemError",
    descKey: "descItemError",
  }),
  ir({
    id: "paused",
    command: (val, key) => ({ kind: val === true ? "pause" : "resume", key }),
    value: i => i.status === "paused",
    type: "boolean",
    role: "switch",
    write: true,
    capability: "itemPause",
    nameKey: "itemPaused",
    descKey: "descItemPaused",
  }),
  ir({
    id: "remove",
    command: (val, key) => (val === true ? { kind: "remove", key } : null),
    type: "boolean",
    role: "button",
    read: false,
    write: true,
    capability: "itemRemove",
    nameKey: "remove",
    descKey: "descRemove",
  }),
];

/**
 * The definitions a driver with these capabilities gets.
 *
 * @param defs a datapoint table
 * @param caps the driver's capabilities
 * @returns the definitions without a capability or with one the driver has
 */
export function forCapabilities<S>(defs: readonly DatapointDef<S>[], caps: ReadonlySet<Capability>): DatapointDef<S>[] {
  return defs.filter(d => d.capability === undefined || caps.has(d.capability));
}
