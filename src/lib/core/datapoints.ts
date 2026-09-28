import type { I18nKey } from "../i18n";
import type { Capability } from "./model";

/** One datapoint the core creates for a program or a download. */
export interface DatapointDef {
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
}

const r = (d: Omit<DatapointDef, "read" | "write"> & Partial<Pick<DatapointDef, "read" | "write">>): DatapointDef => ({
  read: true,
  write: false,
  ...d,
});

/** Datapoints directly below a program's device. */
export const PROGRAM_DATAPOINTS: readonly DatapointDef[] = [
  r({ id: "online", type: "boolean", role: "indicator.reachable", nameKey: "online", descKey: "descOnline" }),
  r({ id: "error", type: "string", role: "text", nameKey: "error", descKey: "descError" }),
  r({ id: "version", type: "string", role: "text", nameKey: "version" }),
  r({
    id: "downloading",
    type: "boolean",
    role: "indicator.working",
    nameKey: "downloading",
    descKey: "descDownloading",
  }),
  r({
    id: "paused",
    type: "boolean",
    role: "switch",
    write: true,
    capability: "globalPause",
    nameKey: "paused",
    descKey: "descPaused",
  }),
  r({ id: "downloadSpeed", type: "number", role: "value", unit: "MB/s", nameKey: "downloadSpeed" }),
  r({ id: "uploadSpeed", type: "number", role: "value", unit: "MB/s", capability: "upload", nameKey: "uploadSpeed" }),
  r({
    id: "speedLimit",
    type: "number",
    role: "level",
    unit: "MB/s",
    write: true,
    capability: "speedLimit",
    nameKey: "speedLimit",
    descKey: "descSpeedLimit",
  }),
  r({
    id: "uploadLimit",
    type: "number",
    role: "level",
    unit: "MB/s",
    write: true,
    capability: "uploadLimit",
    nameKey: "uploadLimit",
    descKey: "descUploadLimit",
  }),
  r({
    id: "altSpeed",
    type: "boolean",
    role: "switch",
    write: true,
    capability: "altSpeed",
    nameKey: "altSpeed",
    descKey: "descAltSpeed",
  }),
  r({
    id: "freeSpace",
    type: "number",
    role: "value",
    unit: "GB",
    capability: "freeSpace",
    nameKey: "freeSpace",
    descKey: "descFreeSpace",
  }),
  r({ id: "active", type: "number", role: "value", nameKey: "active" }),
  r({ id: "queued", type: "number", role: "value", nameKey: "queued" }),
  r({ id: "total", type: "number", role: "value", nameKey: "total" }),
  r({
    id: "add",
    type: "string",
    role: "text",
    read: false,
    write: true,
    capability: "add",
    nameKey: "add",
    descKey: "descAdd",
  }),
  r({ id: "lastFinished", type: "string", role: "text", nameKey: "lastFinished", descKey: "descLastFinished" }),
  r({ id: "lastFinishedTime", type: "number", role: "date", nameKey: "lastFinishedTime" }),
  r({ id: "lastFailed", type: "string", role: "text", nameKey: "lastFailed", descKey: "descLastFailed" }),
  r({ id: "lastFailedTime", type: "number", role: "date", nameKey: "lastFailedTime" }),
];

/** Datapoints in each download's channel. */
export const ITEM_DATAPOINTS: readonly DatapointDef[] = [
  r({ id: "status", type: "string", role: "text", nameKey: "status" }),
  r({ id: "progress", type: "number", role: "value", unit: "%", nameKey: "progress" }),
  r({ id: "size", type: "number", role: "value", unit: "GB", nameKey: "size" }),
  r({ id: "downloaded", type: "number", role: "value", unit: "GB", nameKey: "downloaded" }),
  r({ id: "speed", type: "number", role: "value", unit: "MB/s", capability: "itemSpeed", nameKey: "speed" }),
  r({ id: "uploadSpeed", type: "number", role: "value", unit: "MB/s", capability: "upload", nameKey: "uploadSpeed" }),
  r({ id: "ratio", type: "number", role: "value", capability: "upload", nameKey: "ratio", descKey: "descRatio" }),
  r({
    id: "eta",
    type: "number",
    role: "value.timer",
    unit: "s",
    capability: "itemEta",
    nameKey: "eta",
    descKey: "descEta",
  }),
  r({ id: "added", type: "number", role: "date", capability: "itemAdded", nameKey: "added" }),
  r({ id: "finished", type: "number", role: "date", capability: "itemFinished", nameKey: "finished" }),
  r({ id: "category", type: "string", role: "text", capability: "category", nameKey: "category" }),
  r({
    id: "error",
    type: "string",
    role: "text",
    capability: "itemError",
    nameKey: "itemError",
    descKey: "descItemError",
  }),
  r({
    id: "paused",
    type: "boolean",
    role: "switch",
    write: true,
    capability: "itemPause",
    nameKey: "itemPaused",
    descKey: "descItemPaused",
  }),
  r({
    id: "remove",
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
export function forCapabilities(defs: readonly DatapointDef[], caps: ReadonlySet<Capability>): DatapointDef[] {
  return defs.filter(d => d.capability === undefined || caps.has(d.capability));
}
