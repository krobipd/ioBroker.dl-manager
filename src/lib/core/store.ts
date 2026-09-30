import { errText } from "../err-text";

/**
 * Where the programs live: `programs.json` in the instance's data folder (`iobroker-data/<ns>/`, declared as
 * `common.dataFolder`, so every ioBroker backup carries it). Not the instance object — every change there restarts
 * the instance, and the settings page writes its own (older) copy back when it saves — and not the object tree, where
 * the rows showed up in every object export. Password and API key are stored encrypted with the installation secret;
 * the rest as typed.
 */

/** The store object of 0.3.0 and 0.3.1, below the namespace — the start moves it into the file once. */
export const STORE_ID = "programs";

/** The file in the instance's data folder. */
export const STORE_FILE = "programs.json";

/** The fields that hold a secret. */
const SECRET_FIELDS = ["password", "apiKey"] as const;

/** One stored settings row — fields the adapter does not know are kept. */
export type SettingsRow = Record<string, unknown>;

/** What the store needs from outside. */
export interface StoreAdapter {
  /** Reads the store file — undefined while it does not exist. */
  readText(): Promise<string | undefined>;
  /** Replaces the store file as a whole, so a crash leaves either the old or the new file. */
  writeText(text: string): Promise<void>;
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

  /**
   * @returns the rows as stored (secrets encrypted), undefined while the store file does not exist
   * @throws {Error} when the file holds no readable JSON — the programs are never replaced by an empty list
   */
  public async stored(): Promise<SettingsRow[] | undefined> {
    const text = await this.a.readText();
    if (text === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      throw new Error(`${STORE_FILE} is no readable JSON — fix or remove it (${errText(err)})`);
    }
    const rows: unknown = isRow(parsed) ? parsed.rows : undefined;
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
    // nothing to store and no store yet: the file comes with the first program
    if (before ? canonical(before) === canonical(next) : !next.length) {
      return false;
    }
    await this.a.writeText(`${JSON.stringify({ rows: next }, null, 2)}\n`);
    return true;
  }

  /**
   * Takes over the rows of the store object of 0.3.0/0.3.1 exactly as they are stored — ciphertext and `encrypted`
   * included, nothing is decrypted and encrypted again.
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
      await this.a.writeText(`${JSON.stringify({ rows: list }, null, 2)}\n`);
    }
    return list.length;
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
