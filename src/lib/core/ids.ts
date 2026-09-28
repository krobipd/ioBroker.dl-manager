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
 * Device id of a program: `<type>-<user key>`. The user key comes from the settings table.
 *
 * @param type program type from the registry
 * @param userKey the ID column of the settings table
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
  private readonly used: Set<string>;

  /** @param stored raw key → id, read back from the channels' `native.key` */
  public constructor(stored: ReadonlyMap<string, string>) {
    this.byKey = new Map(stored);
    this.used = new Set(stored.values());
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
    let id = [short, full].find(c => !this.used.has(c));
    for (let n = 2; id === undefined; n++) {
      if (!this.used.has(`${full}-${n}`)) {
        id = `${full}-${n}`;
      }
    }
    this.byKey.set(rawKey, id);
    this.used.add(id);
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
      this.used.delete(id);
    }
    this.byKey.delete(rawKey);
  }

  /** @returns a copy of raw key → id */
  public entries(): Map<string, string> {
    return new Map(this.byKey);
  }
}
