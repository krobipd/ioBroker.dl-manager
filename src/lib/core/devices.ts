import { moveWithEnums, type EnumCarryAdapter } from "../enum-carry";
import { errText } from "../err-text";
import { programInfo } from "../programs/catalog";
import { addressOf, type ProgramRow } from "./config";
import { programId } from "./ids";
import type { AdapterLog } from "./model";

/**
 * The devices of the instance against the settings: which ones stay, which one a changed row takes over (with its
 * room and function assignments), which ones go — and the offline stamp before anything runs.
 */

/** What a device object keeps about its program. */
export interface DeviceNative {
  /** Program type. */
  type?: unknown;
  /** The program's address when the device was last written (`addressOf`). */
  address?: unknown;
}

/** The adapter methods the device handling needs. */
export interface DevicesAdapter {
  /** e.g. "dl-manager.0" */
  namespace: string;
  /** The adapter log. */
  log: AdapterLog;
  /** Reads an own object (id below the namespace). */
  getObject(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Reads objects by pattern and type. */
  getForeignObjects(pattern: string, type: ioBroker.ObjectType): Promise<Record<string, ioBroker.Object>>;
  /** Reads an object by its full id (enums). */
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Replaces an object completely — needed where a merge would keep stale list entries (enums, pause store). */
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<unknown>;
  /** Deletes an object (and with `recursive` its children and their values). */
  delObject(id: string, opts: { recursive: boolean }): Promise<unknown>;
  /** Writes a state only when it changes. */
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<unknown>;
}

/**
 * Whether a settings row continues a device no row names any more: the same program at the same address under a new
 * ID, or a JDownloader whose connection was switched between local and My.JDownloader under the same ID.
 *
 * @param row the candidate row
 * @param oldId the orphaned device id
 * @param native the orphaned device's `native`
 * @param native.type its program type
 * @param native.address its address (`addressOf`)
 * @returns whether the row takes over the device's room and function assignments
 */
export function continues(row: ProgramRow, oldId: string, native: DeviceNative): boolean {
  if (row.cfg.type === native.type) {
    return addressOf(row.cfg) === native.address;
  }
  const oldType = typeof native.type === "string" ? native.type : "";
  return (
    programInfo(oldType)?.family === "jdownloader" &&
    programInfo(row.cfg.type)?.family === "jdownloader" &&
    programId(oldType, row.cfg.key) === oldId
  );
}

/**
 * Which device a row takes over and which devices no row keeps — decided before anything is written.
 *
 * @param rows the settings rows
 * @param existing device id → its `native`, every device of the instance
 * @returns new device id → the device it continues, and the devices to delete
 */
export function planHandover(
  rows: readonly ProgramRow[],
  existing: ReadonlyMap<string, DeviceNative>,
): { carries: Map<string, string>; orphans: string[] } {
  const ids = new Set(rows.map(r => r.id));
  const carries = new Map<string, string>();
  const orphans: string[] = [];
  for (const [oldId, native] of existing) {
    if (ids.has(oldId)) {
      continue;
    }
    const heir = rows.find(
      r => r.enabled && !r.problem && !existing.has(r.id) && !carries.has(r.id) && continues(r, oldId, native),
    );
    if (heir) {
      carries.set(heir.id, oldId);
    } else {
      orphans.push(oldId);
    }
  }
  return { carries, orphans };
}

const NO_REACHABLE_STAMP: [string, ioBroker.StateValue][] = [
  ["info.connection", false],
  ["info.programsOnline", 0],
  ["info.programsAllOnline", false],
];

/**
 * @param a the adapter
 * @returns device id → its `native` for every device of this instance
 */
export async function readDevices(a: DevicesAdapter): Promise<Map<string, DeviceNative>> {
  const prefix = `${a.namespace}.`;
  const devices = await a.getForeignObjects(`${prefix}*`, "device");
  const out = new Map<string, DeviceNative>();
  for (const [id, obj] of Object.entries(devices)) {
    const rel = id.slice(prefix.length);
    if (!rel.includes(".")) {
      out.set(rel, (obj.native ?? {}) as DeviceNative);
    }
  }
  return out;
}

/**
 * Nothing is asked yet: every known program offline with the reason `Unknown`, the adapter unreachable.
 *
 * @param a the adapter
 * @param deviceIds the devices of the instance
 */
export async function stampOffline(a: DevicesAdapter, deviceIds: Iterable<string>): Promise<void> {
  for (const id of deviceIds) {
    if (await a.getObject(`${id}.online`)) {
      await a.setStateChanged(`${id}.online`, { val: false, ack: true });
      await a.setStateChanged(`${id}.error`, { val: "Unknown", ack: true });
    }
  }
  for (const [id, val] of NO_REACHABLE_STAMP) {
    await a.setStateChanged(id, { val, ack: true });
  }
}

/**
 * A row took over a device ({@link continues}): carry room and function assignments of the device and its datapoints
 * to the new device, then remove the old one. Download channels are not carried — they come back with the next poll
 * under the new device.
 *
 * @param a the adapter
 * @param oldId previous device id
 * @param newId new device id (already created)
 */
export async function carryAssignments(a: DevicesAdapter, oldId: string, newId: string): Promise<void> {
  const oldFull = `${a.namespace}.${oldId}`;
  const newFull = `${a.namespace}.${newId}`;
  const carrier: EnumCarryAdapter = {
    getForeignObjectsAsync: (pattern, type) => a.getForeignObjects(pattern, type),
    getForeignObjectAsync: id => a.getForeignObjectAsync(id),
    setForeignObject: (id, obj) => a.setForeignObject(id, obj as unknown as ioBroker.SettableObject),
    log: a.log,
  };
  const enums = await a.getForeignObjects("enum.*", "enum");
  const members = new Set<string>();
  for (const e of Object.values(enums)) {
    const list: unknown = (e.common as { members?: unknown }).members;
    if (Array.isArray(list)) {
      list.filter((m): m is string => typeof m === "string").forEach(m => members.add(m));
    }
  }
  const children = [...members].filter(m => m.startsWith(`${oldFull}.`)).sort((x, y) => y.length - x.length);
  for (const oldChild of children) {
    const newChild = newFull + oldChild.slice(oldFull.length);
    if (await a.getForeignObjectAsync(newChild)) {
      await moveWithEnums(carrier, oldChild, newChild, () => a.delObject(oldChild, { recursive: true }), errText);
    }
  }
  const removeOld = (): Promise<unknown> => a.delObject(oldFull, { recursive: true });
  if (members.has(oldFull)) {
    await moveWithEnums(carrier, oldFull, newFull, removeOld, errText);
  } else {
    await removeOld();
  }
  a.log.info(`${oldId} is now ${newId} — room and function assignments carried over`);
}
