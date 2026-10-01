/**
 * A valid ioBroker id segment: lower case, `a-z0-9-` only (adapter-core forbids `.`, `*`, `,`, `;`, quotes,
 * brackets and whitespace in an id).
 *
 * @param raw any text
 * @returns the cleaned segment, possibly empty
 */
export function sanitize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * @param namespace the instance, e.g. `dl-manager.0`
 * @param id an id below it or already full
 * @returns the full id
 */
export function ownId(namespace: string, id: string): string {
  return id.startsWith(`${namespace}.`) ? id : `${namespace}.${id}`;
}

/**
 * The device id a program had up to 0.2.0: `<type>-<user key>` — only `legacyId` still builds it, to find the device a
 * row from then moves away from.
 *
 * @param type program type from the registry
 * @param userKey the key of the program row
 * @returns the device id
 */
export function programId(type: string, userKey: string): string {
  const key = sanitize(userKey);
  return key ? `${type}-${key}` : type;
}

/**
 * Download ids: the LAST eight characters of the cleaned raw key (JD package uuids are millisecond timestamps —
 * the leading digits are equal for packages added together), the whole key on a collision, then a counter. An id,
 * once given, stays with its raw key until the key disappears.
 */
export class ItemIds {
  private readonly byKey: Map<string, string>;
  /** The other direction: id → raw key (the ids in use). */
  private readonly byId: Map<string, string>;

  /** @param stored raw key → id, read back from the channels' `native.key` */
  public constructor(stored: ReadonlyMap<string, string>) {
    this.byKey = new Map(stored);
    this.byId = new Map([...stored].map(([key, id]) => [id, key]));
  }

  /**
   * The id for a raw key; assigns one on first sight.
   *
   * @param rawKey the program's stable key
   * @returns the id segment
   */
  public idFor(rawKey: string): string {
    const known = this.byKey.get(rawKey);
    if (known !== undefined) {
      return known;
    }
    const full = sanitize(rawKey) || "item";
    const short = full.slice(-8).replace(/^-+/, "") || full;
    let id = [short, full].find(c => !this.byId.has(c));
    for (let n = 2; id === undefined; n++) {
      if (!this.byId.has(`${full}-${n}`)) {
        id = `${full}-${n}`;
      }
    }
    this.byKey.set(rawKey, id);
    this.byId.set(id, rawKey);
    return id;
  }

  /**
   * Frees the id of a key that is gone.
   *
   * @param rawKey the program's key
   */
  public release(rawKey: string): void {
    const id = this.byKey.get(rawKey);
    if (id !== undefined) {
      this.byId.delete(id);
    }
    this.byKey.delete(rawKey);
  }

  /**
   * @param id the id segment of a download channel
   * @returns the program's raw key it belongs to, undefined for an id not in use
   */
  public keyOf(id: string): string | undefined {
    return this.byId.get(id);
  }
}
