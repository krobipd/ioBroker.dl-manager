import type { DataFileRead } from "../data-file";

/**
 * Where the programs live: `programs.json` in the instance's data folder (`iobroker-data/<ns>/`, declared as
 * `common.dataFolder`, so every ioBroker backup carries it). Not the instance object — every change there restarts
 * the instance, and the settings page writes its own (older) copy back when it saves — and not the object tree, where
 * the rows showed up in every object export. The file goes through the fleet master data-file.ts, which stores password
 * and API key sealed with the installation secret; the rest as typed.
 */

/** The store object of 0.3.0 and 0.3.1, below the namespace — the start moves it into the file once. */
export const STORE_ID = "programs";

/** The file in the instance's data folder. */
export const STORE_FILE = "programs.json";

/** The fields that hold a secret — data-file.ts seals each of them in the file. */
export const SECRET_FIELDS = ["password", "apiKey"] as const;

/** One stored settings row — fields the adapter does not know are kept. */
export type SettingsRow = Record<string, unknown>;

/** What the store needs from outside. */
export interface StoreAdapter {
  /** Reads the store file, its secrets decrypted: nothing (no file yet), the value, or why it is unusable. */
  read(): Promise<DataFileRead>;
  /** Replaces the store file as a whole, its secrets sealed, so a crash leaves either the old or the new file. */
  write(value: unknown): Promise<void>;
  /** The adapter's decrypt (installation secret) — for a secret 0.3.0 to 0.4.x encrypted in the row itself. */
  decrypt(value: string): string;
}

/**
 * @param r an entry of a stored or old program list
 * @returns whether it is a row (an object, not a list)
 */
export const isRow = (r: unknown): r is SettingsRow => !!r && typeof r === "object" && !Array.isArray(r);

/**
 * @param rows stored rows
 * @returns them as text, independent of the order of each row's fields
 */
const canonical = (rows: readonly SettingsRow[]): string =>
  JSON.stringify(rows.map(r => Object.fromEntries(Object.entries(r).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))));

/**
 * @param a a row
 * @param b another row
 * @returns whether both hold the same fields and values, whatever their order
 */
export const sameRow = (a: SettingsRow, b: SettingsRow): boolean => canonical([a]) === canonical([b]);

/**
 * @param row a row with readable secrets (`reveal` dropped the `encrypted` mark of 0.3.0 to 0.4.x)
 * @returns the row to store: every secret field a text, "" when there is none
 */
const plain = (row: SettingsRow): SettingsRow => {
  const out: SettingsRow = { ...row };
  for (const f of SECRET_FIELDS) {
    out[f] = typeof row[f] === "string" ? row[f] : "";
  }
  return out;
};

/** The program rows, read and written as a whole. */
export class ProgramStore {
  /** @param a the adapter */
  public constructor(private readonly a: StoreAdapter) {}

  /**
   * @returns the rows as the file holds them (a row of 0.3.0 to 0.4.x still with its own cipher and `encrypted`),
   *   undefined while the store file does not exist
   * @throws {Error} when the file cannot be read or holds no row list — the programs are never replaced by an empty
   *   list (the start would remove every program's device)
   */
  public async stored(): Promise<SettingsRow[] | undefined> {
    const read = await this.a.read();
    if (read.error !== undefined) {
      throw new Error(`${STORE_FILE} cannot be read — fix or remove it (${read.error})`);
    }
    if (read.value === undefined) {
      return undefined;
    }
    const rows: unknown = isRow(read.value) ? read.value.rows : undefined;
    if (!Array.isArray(rows)) {
      throw new Error(`${STORE_FILE} holds no list of programs — fix or remove it`);
    }
    return rows.filter(isRow);
  }

  /** @returns the rows with their secrets readable — what the adapter and the dialogs work with */
  public async read(): Promise<SettingsRow[]> {
    return ((await this.stored()) ?? []).map(r => this.reveal(r));
  }

  /**
   * Stores the rows. Rows that did not change write nothing; a row of 0.3.0 to 0.4.x always differs (its `encrypted`
   * mark), so the first write after an update stores it in the form of today.
   *
   * @param rows the rows with readable secrets
   * @returns whether the store was written
   */
  public async write(rows: readonly SettingsRow[]): Promise<boolean> {
    const before = await this.stored();
    const next = rows.map(plain);
    // nothing to store and no store yet: the file comes with the first program
    if (before ? canonical(before) === canonical(next) : !next.length) {
      return false;
    }
    await this.a.write({ rows: next });
    return true;
  }

  /**
   * Takes over the rows of the store object of 0.3.0/0.3.1 — their secrets decrypted, the file seals them.
   *
   * @param rows `native.rows` of the old object
   * @returns how many rows went into the file; undefined when the file already existed (a start that stopped between
   *   writing the file and deleting the object)
   */
  public async adopt(rows: unknown): Promise<number | undefined> {
    if ((await this.stored()) !== undefined) {
      return undefined;
    }
    const list = Array.isArray(rows) ? rows.filter(isRow) : [];
    if (list.length) {
      await this.a.write({ rows: list.map(r => plain(this.reveal(r))) });
    }
    return list.length;
  }

  /**
   * @param row a stored row
   * @returns it with readable secrets — a row of 0.3.0 to 0.4.x (`encrypted`) holds its own cipher, every other row
   *   holds them as data-file.ts read them
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
   * @param value a secret 0.3.0 to 0.4.x encrypted in the row
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
