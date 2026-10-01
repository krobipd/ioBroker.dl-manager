import { RESERVED_IDS } from "./device-id";

/** The devices of the instance and the offline stamp before anything runs. */

/** What a device object keeps about its program. */
export interface DeviceNative {
  /** Program type — every device the adapter wrote carries it. */
  type?: unknown;
  /** The program's address when the device was last written (`addressOf`). */
  address?: unknown;
  /** The id scheme the device id follows (`device-id.ts`). */
  idScheme?: unknown;
  /** A move to this device id is under way (`move.ts`). */
  movingTo?: unknown;
}

/** The adapter methods the device handling needs. */
export interface DevicesAdapter {
  /** e.g. "dl-manager.0" */
  namespace: string;
  /** An own object as the adapter holds it (read once at start) — no database read. */
  knownObject(id: string): unknown;
  /** Reads objects by pattern and type. */
  getForeignObjects(pattern: string, type: ioBroker.ObjectType): Promise<Record<string, ioBroker.Object>>;
  /** Writes a state only when it changes. */
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<unknown>;
}

const NO_REACHABLE_STAMP: [string, ioBroker.StateValue][] = [
  ["info.connection", false],
  ["info.programsOnline", 0],
  ["info.programsAllOnline", false],
];

/**
 * @param a the adapter
 * @returns device id → its `native` for every program device of this instance — a device object the adapter did not
 *   write (no program type) and the instance's own roots are none
 */
export async function readDevices(a: DevicesAdapter): Promise<Map<string, DeviceNative>> {
  const prefix = `${a.namespace}.`;
  const devices = await a.getForeignObjects(`${prefix}*`, "device");
  const out = new Map<string, DeviceNative>();
  for (const [id, obj] of Object.entries(devices)) {
    const rel = id.slice(prefix.length);
    const native = (obj.native ?? {}) as DeviceNative;
    if (!rel.includes(".") && !RESERVED_IDS.has(rel) && typeof native.type === "string") {
      out.set(rel, native);
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
    if (a.knownObject(`${id}.online`)) {
      await a.setStateChanged(`${id}.online`, { val: false, ack: true });
      await a.setStateChanged(`${id}.error`, { val: "Unknown", ack: true });
    }
  }
  for (const [id, val] of NO_REACHABLE_STAMP) {
    await a.setStateChanged(id, { val, ack: true });
  }
}
