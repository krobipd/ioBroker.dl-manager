import { moveAllWithEnums, type EnumCarryAdapter } from "../enum-carry";
import { errText } from "../err-text";
import { ID_SCHEME } from "./device-id";
import type { AdapterLog } from "./model";

/**
 * Moves objects to new ids and keeps what belongs to them: every object below with its `native` (an emulated pause's
 * memory among them), each value with `ack`/`ts`/`lc`/`q`, a recording on the SAME datapoint (its history stays
 * reachable under the old id through `aliasId`), aliases that point at a moved datapoint, and the room and function
 * assignments (fleet master `enum-carry.ts`). Deleting goes children first and the root last: a device move keeps its
 * journal (`native.movingTo`) on the old root, and a recursive delete would remove the root first. Ported from the
 * device move of homeconnect and yamaha.
 */

/** The adapter methods a move needs. */
export interface MoveAdapter {
  /** e.g. "dl-manager.0" */
  namespace: string;
  /** The adapter log. */
  log: AdapterLog;
  /** Reads the objects between two ids. */
  getObjectList(params: { startkey: string; endkey: string }): Promise<{ rows: { id: string; value: unknown }[] }>;
  /** Reads objects by pattern and type (enums, aliases). */
  getForeignObjects(pattern: string, type: ioBroker.ObjectType): Promise<Record<string, ioBroker.Object>>;
  /** Reads an object by its full id. */
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Replaces an object completely. */
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<unknown>;
  /** Merges into an object. */
  extendForeignObject(id: string, patch: ioBroker.PartialObject): Promise<unknown>;
  /** Reads the states matching a pattern. */
  getForeignStates(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>>;
  /** Writes a state. */
  setForeignState(id: string, state: ioBroker.SettableState): Promise<unknown>;
  /** Deletes ONE object (its value with it) — never its children. */
  delForeignObject(id: string): Promise<unknown>;
}

/** What a move carried. */
export interface MoveResult {
  /** Objects moved. */
  objects: number;
  /** Room and function entries carried. */
  enums: number;
  /** Aliases pointed at the new ids. */
  aliases: number;
  /** Recordings that keep their history (`aliasId`). */
  recordings: number;
}

/**
 * A recording goes on with its datapoint; an active one without `aliasId` gets the old id, so its history stays
 * reachable.
 *
 * @param custom the datapoint's `common.custom`
 * @param oldId the datapoint's old id
 * @returns the custom to write, and how many recordings got the old id
 */
export function keepHistoryUnder(
  custom: Record<string, unknown>,
  oldId: string,
): { custom: Record<string, unknown>; kept: number } {
  let kept = 0;
  const out: Record<string, unknown> = {};
  for (const [key, cfg] of Object.entries(custom)) {
    if (
      cfg &&
      typeof cfg === "object" &&
      (cfg as { enabled?: unknown }).enabled &&
      !(cfg as { aliasId?: unknown }).aliasId
    ) {
      out[key] = { ...cfg, aliasId: oldId };
      kept++;
    } else {
      out[key] = cfg;
    }
  }
  return { custom: out, kept };
}

/**
 * @param alias an alias object's `common.alias`
 * @param moved old full id → new full id
 * @returns the alias with moved targets, undefined when it points at none of them
 */
function retarget(alias: unknown, moved: ReadonlyMap<string, string>): unknown {
  if (!alias || typeof alias !== "object") {
    return undefined;
  }
  const id: unknown = (alias as { id?: unknown }).id;
  if (typeof id === "string") {
    const next = moved.get(id);
    return next ? { ...alias, id: next } : undefined;
  }
  if (id && typeof id === "object") {
    const { read, write } = id as { read?: unknown; write?: unknown };
    const r = typeof read === "string" ? moved.get(read) : undefined;
    const w = typeof write === "string" ? moved.get(write) : undefined;
    if (!r && !w) {
      return undefined;
    }
    return { ...alias, id: { ...id, ...(r ? { read: r } : {}), ...(w ? { write: w } : {}) } };
  }
  return undefined;
}

/**
 * Moves each root (a device, or single datapoints) with everything below it.
 *
 * @param a the adapter
 * @param pairs old full id → new full id of each root
 * @param opts how to move
 * @param opts.device the roots are devices: keep a journal on the old root and mark the new one (`idScheme`)
 * @returns what was carried
 */
export async function moveObjects(
  a: MoveAdapter,
  pairs: ReadonlyArray<readonly [string, string]>,
  opts: { device?: boolean } = {},
): Promise<MoveResult> {
  const ns = `${a.namespace}.`;
  const list = await a.getObjectList({ startkey: ns, endkey: `${ns}香` });
  const all = new Map<string, ioBroker.Object>();
  for (const row of list.rows) {
    if (row.value && typeof row.value === "object") {
      all.set(row.id, row.value as ioBroker.Object);
    }
  }
  const moved = new Map<string, string>();
  for (const [from, to] of pairs) {
    for (const id of all.keys()) {
      if (id === from || id.startsWith(`${from}.`)) {
        moved.set(id, to + id.slice(from.length));
      }
    }
  }
  const result: MoveResult = { objects: 0, enums: 0, aliases: 0, recordings: 0 };
  if (!moved.size) {
    return result;
  }

  // the old root names its target until the move is through — a stop in between resumes it on the next start
  const done = new Set<string>();
  for (const [from, to] of pairs) {
    if (!opts.device || !all.has(from)) {
      continue;
    }
    if (all.get(to)?.native?.idScheme === ID_SCHEME) {
      done.add(from);
    } else if (all.get(from)?.native?.movingTo !== to) {
      await a.extendForeignObject(from, { native: { movingTo: to } });
    }
  }
  const rootOf = (id: string): string | undefined => pairs.find(([f]) => id === f || id.startsWith(`${f}.`))?.[0];

  for (const [oldId, newId] of [...moved].sort(([x], [y]) => x.length - y.length)) {
    const root = rootOf(oldId);
    if (root && done.has(root)) {
      continue;
    }
    const src = all.get(oldId);
    if (!src) {
      continue;
    }
    const custom = src.common && "custom" in src.common ? (src.common.custom as Record<string, unknown> | null) : null;
    const history = custom ? keepHistoryUnder(custom, oldId) : undefined;
    const dst = all.get(newId);
    if (dst) {
      // the target exists already (a manifest object, a resumed copy): it only takes a recording it lacks
      const has = dst.common && "custom" in dst.common && dst.common.custom;
      if (history && !has) {
        await a.extendForeignObject(newId, { common: { custom: history.custom } });
        result.recordings += history.kept;
      }
      continue;
    }
    const native: Record<string, unknown> = { ...(src.native ?? {}) };
    delete native.movingTo;
    delete native.idScheme;
    const common = { ...src.common, ...(history ? { custom: history.custom } : {}) };
    await a.setForeignObject(newId, { type: src.type, common, native } as ioBroker.SettableObject);
    result.objects++;
    result.recordings += history?.kept ?? 0;
  }

  const states: Record<string, ioBroker.State | null | undefined> = {};
  for (const [from] of pairs) {
    Object.assign(states, await a.getForeignStates(from), await a.getForeignStates(`${from}.*`));
  }
  const targets = await Promise.all(
    [...new Set(moved.values())].map(async id => [id, await a.getForeignStates(id)] as const),
  );
  const targetState = new Map(targets.map(([id, s]) => [id, s[id]]));
  for (const [oldId, st] of Object.entries(states)) {
    const newId = moved.get(oldId);
    const root = rootOf(oldId);
    if (!st || !newId || (root && done.has(root))) {
      continue;
    }
    const there = targetState.get(newId);
    if (there && there.ts > st.ts) {
      continue;
    }
    await a.setForeignState(newId, { val: st.val, ack: st.ack, ts: st.ts, lc: st.lc, q: st.q });
  }

  const aliases = await a.getForeignObjects("alias.*", "state");
  for (const [id, obj] of Object.entries(aliases)) {
    const next = retarget((obj.common as { alias?: unknown }).alias, moved);
    if (next) {
      await a.setForeignObject(id, { ...obj, common: { ...obj.common, alias: next } } as ioBroker.SettableObject);
      result.aliases++;
    }
  }

  for (const [from, to] of pairs) {
    if (opts.device && all.has(from) && !done.has(from)) {
      await a.extendForeignObject(to, { native: { idScheme: ID_SCHEME } });
    }
  }

  const carrier: EnumCarryAdapter = {
    getForeignObjectsAsync: (pattern, type) => a.getForeignObjects(pattern, type),
    getForeignObjectAsync: id => a.getForeignObjectAsync(id),
    setForeignObject: (id, obj) => a.setForeignObject(id, obj as unknown as ioBroker.SettableObject),
    log: a.log,
  };
  const carried = await moveAllWithEnums(
    carrier,
    id => {
      const next = moved.get(id);
      return next ? [next] : [];
    },
    async () => {
      // deepest first: a channel after its states, the root with its journal last
      for (const id of [...moved.keys()].sort((x, y) => y.length - x.length)) {
        await a.delForeignObject(id);
      }
    },
    errText,
  );
  result.enums = carried.reduce((n, e) => n + e.newIds.length, 0);
  return result;
}
