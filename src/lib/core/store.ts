import { tName } from "../i18n";

/**
 * Where the programs live: `native.rows` of the adapter's own object `<ns>.programs`. Not the instance object — every
 * change there restarts the instance, and the settings page writes its own (older) copy back when it saves. Password
 * and API key are stored encrypted with the installation secret; the rest as typed.
 */

/** The store object, below the namespace. */
export const STORE_ID = "programs";

/** The fields that hold a secret. */
const SECRET_FIELDS = ["password", "apiKey"] as const;

/** One stored settings row — fields the adapter does not know are kept. */
export type SettingsRow = Record<string, unknown>;

/** The adapter methods the store needs. */
export interface StoreAdapter {
  /** e.g. "dl-manager.0" */
  namespace: string;
  /** Reads an object by its full id. */
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Replaces an object completely — a merge would keep the tail of a shorter list. */
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<unknown>;
  /** The adapter's encrypt (installation secret). */
  encrypt(value: string): string;
  /** The adapter's decrypt (installation secret). */
  decrypt(value: string): string;
}

const isRow = (r: unknown): r is SettingsRow => !!r && typeof r === "object" && !Array.isArray(r);

/**
 * @param rows stored rows
 * @returns them as text, independent of the order of each row's fields
 */
const canonical = (rows: readonly SettingsRow[]): string =>
  JSON.stringify(rows.map(r => Object.fromEntries(Object.entries(r).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))));

/** The program rows, read and written as a whole. */
export class ProgramStore {
  /** @param a the adapter */
  public constructor(private readonly a: StoreAdapter) {}

  private get fullId(): string {
    return `${this.a.namespace}.${STORE_ID}`;
  }

  /** @returns the rows as stored (secrets encrypted), undefined while the store object does not exist */
  public async stored(): Promise<SettingsRow[] | undefined> {
    const obj = await this.a.getForeignObjectAsync(this.fullId);
    if (!obj) {
      return undefined;
    }
    const rows: unknown = obj.native?.rows;
    return Array.isArray(rows) ? rows.filter(isRow) : [];
  }

  /** @returns the rows with their secrets readable — what the adapter and the dialogs work with */
  public async read(): Promise<SettingsRow[]> {
    return ((await this.stored()) ?? []).map(r => this.reveal(r));
  }

  /**
   * Stores the rows. A secret that did not change keeps its stored ciphertext (the cipher is new on every call), so
   * an edit that changed nothing writes nothing.
   *
   * @param rows the rows with readable secrets
   * @returns whether the store was written
   */
  public async write(rows: readonly SettingsRow[]): Promise<boolean> {
    const before = await this.stored();
    const byId = new Map((before ?? []).filter(r => typeof r.id === "string").map(r => [r.id as string, r]));
    const next = rows.map(r => this.seal(r, typeof r.id === "string" ? byId.get(r.id) : undefined));
    // nothing to store and no store yet: the object comes with the first program
    if (before ? canonical(before) === canonical(next) : !next.length) {
      return false;
    }
    await this.a.setForeignObject(this.fullId, {
      type: "meta",
      common: { name: tName("programStore"), type: "meta.folder" },
      native: { rows: next },
    });
    return true;
  }

  /**
   * @param row a stored row
   * @returns it with readable secrets; a row stored before 0.3.0 (`encrypted` missing) holds them as typed
   */
  public reveal(row: SettingsRow): SettingsRow {
    const out: SettingsRow = { ...row };
    delete out.encrypted;
    if (row.encrypted !== true) {
      return out;
    }
    for (const f of SECRET_FIELDS) {
      out[f] = this.open(row[f]);
    }
    return out;
  }

  /**
   * @param row a row with readable secrets
   * @param prev the stored row with the same id, if any
   * @returns the row to store
   */
  private seal(row: SettingsRow, prev: SettingsRow | undefined): SettingsRow {
    const out: SettingsRow = { ...row, encrypted: true };
    for (const f of SECRET_FIELDS) {
      const plain = typeof row[f] === "string" ? row[f] : "";
      const kept = prev?.encrypted === true ? prev[f] : undefined;
      if (!plain) {
        out[f] = "";
      } else if (typeof kept === "string" && kept && this.open(kept) === plain) {
        out[f] = kept;
      } else {
        out[f] = this.a.encrypt(plain);
      }
    }
    return out;
  }

  /**
   * @param value a stored secret
   * @returns it decrypted, "" when it cannot be (another installation's secret)
   */
  private open(value: unknown): string {
    if (typeof value !== "string" || !value) {
      return "";
    }
    try {
      return this.a.decrypt(value);
    } catch {
      return "";
    }
  }
}
