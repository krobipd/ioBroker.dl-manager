import { ownId } from "./ids";
/**
 * True when every field of `patch` already sits in `stored` — extendObject would change nothing. Objects are
 * compared field by field (extendObject merges them), arrays and values as a whole.
 *
 * @param patch what the adapter would write
 * @param stored the object as it is in the database
 * @returns whether the write can be skipped
 */
export function coveredBy(patch: unknown, stored: unknown): boolean {
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    return (
      !!stored &&
      typeof stored === "object" &&
      !Array.isArray(stored) &&
      Object.entries(patch).every(([k, v]) => coveredBy(v, (stored as Record<string, unknown>)[k]))
    );
  }
  return JSON.stringify(patch) === JSON.stringify(stored);
}

/** The adapter methods the object store needs. */
export interface KnownObjectsAdapter {
  /** e.g. "dl-manager.0" */
  namespace: string;
  /** Merges into an object (own namespace or full id). */
  extendObject(id: string, obj: ioBroker.PartialObject): Promise<unknown>;
  /** Replaces an object completely. */
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<unknown>;
  /** Deletes an object (and with `recursive` its children). */
  delObject(id: string, opts: { recursive: boolean }): Promise<unknown>;
  /** Reads the objects between two ids. */
  getObjectList(params: { startkey: string; endkey: string }): Promise<{ rows: { id: string; value: unknown }[] }>;
}

/**
 * Merges like js-controller's extendObject: objects field by field, arrays and values replaced.
 *
 * @param stored the object as known
 * @param patch the fields written
 * @returns the object after the write
 */
function merged(stored: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return structuredClone(patch);
  }
  const base: Record<string, unknown> =
    stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    base[k] = merged(base[k], v);
  }
  return base;
}

/**
 * The adapter's own object tree, read once at start: every object write goes through here and reaches the database
 * only when it changes something — an unchanged extendObject still stamps `ts` and notifies every subscriber.
 */
export class KnownObjects {
  private readonly objects = new Map<string, unknown>();

  /** @param a the adapter */
  public constructor(private readonly a: KnownObjectsAdapter) {}

  private full(id: string): string {
    return ownId(this.a.namespace, id);
  }

  /** Reads the whole own tree with one call. Before it only what this instance wrote itself is known. */
  public async load(): Promise<void> {
    const ns = `${this.a.namespace}.`;
    const list = await this.a.getObjectList({ startkey: ns, endkey: `${ns}香` });
    this.objects.clear();
    for (const row of list.rows) {
      if (row.value) {
        this.objects.set(row.id, row.value);
      }
    }
  }

  /**
   * @param id own or full id
   * @returns the object as last read or written, undefined when unknown
   */
  public get(id: string): unknown {
    return this.objects.get(this.full(id));
  }

  /**
   * extendObject, skipped when the stored object already carries the patch.
   *
   * @param id own or full id
   * @param patch the fields to merge
   */
  public async extend(id: string, patch: ioBroker.PartialObject): Promise<void> {
    const key = this.full(id);
    if (coveredBy(patch, this.objects.get(key))) {
      return;
    }
    await this.a.extendObject(id, patch);
    this.objects.set(key, merged(this.objects.get(key), patch));
  }

  /**
   * setForeignObject — the object is known as written.
   *
   * @param id full id
   * @param obj the whole object
   */
  public async replace(id: string, obj: ioBroker.SettableObject): Promise<void> {
    await this.a.setForeignObject(id, obj);
    this.objects.set(id, structuredClone(obj));
  }

  /**
   * delObject — the object (and with `recursive` its children) is forgotten, so an id used again is written anew.
   *
   * @param id own or full id
   * @param opts delete the children too
   * @param opts.recursive whether the children go as well
   */
  public async remove(id: string, opts: { recursive: boolean }): Promise<void> {
    await this.a.delObject(id, opts);
    const key = this.full(id);
    for (const k of [...this.objects.keys()]) {
      if (k === key || (opts.recursive && k.startsWith(`${key}.`))) {
        this.objects.delete(k);
      }
    }
  }
}
