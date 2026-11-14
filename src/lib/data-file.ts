// Fleet master (.consistency-master/src/lib/data-file.ts) — never edit the copy in an adapter.
//
// The files an adapter keeps in its instance data folder (`utils.getAbsoluteInstanceDataDir`, declared as
// `common.dataFolder`, so a backup carries them) — which values belong there says CLAUDE_PATTERNS.md, section native
// „Wohin“. This file is the one form of every access to them (round 173): a write goes to a temporary file, flushed to
// the disk (fsync) and then renamed over the old one, so neither a crash nor a power cut mid-write leaves half a file,
// readable for the owner only; a read says nothing (no file yet), the value, or why the file is unusable. What the
// adapter does with an unusable file — set it aside and start, or halt the start — is its own decision.
//
// A secret the adapter generates or receives (a token, a key, a cookie) lies in such a file and nowhere else, and never
// in clear text (round 174): the caller names the fields that hold one, a write stores each of them encrypted with the
// platform's own cipher (`adapter.encrypt`), a read gives the clear values back. A file from before, with a secret still
// in clear text, is read and written back encrypted at once; a secret that cannot be decrypted makes the file unusable
// — it never reads as a missing or an empty one.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { errText } from "./err-text";

/** The result of reading a data file: nothing there, its value, or why it is unusable. */
export interface DataFileRead {
  /** The parsed content, when the file is there and holds JSON. */
  value?: unknown;
  /** Set when the file exists but cannot be used. */
  error?: string;
}

/** What encrypts and decrypts a secret — the adapter instance itself (`adapter.encrypt`, `adapter.decrypt`). */
export interface DataFileCipher {
  /** Encrypt a text with the system secret. */
  encrypt(value: string): string;
  /** Decrypt what `encrypt` made. */
  decrypt(value: string): string;
}

/** The secrets of a data file: who encrypts them, and the names of the fields that hold one — at any depth. */
export interface DataFileSecrets {
  /** The adapter instance. */
  cipher: DataFileCipher;
  /** The names of the fields whose text is a secret. */
  fields: readonly string[];
}

/** The stored form of a secret field: an object with this one key, holding what the cipher made of the text. */
const SEALED = "$encrypted";

/**
 * Whether a value is an object with named fields.
 *
 * @param value any value
 * @returns true for an object that is no array
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A copy of a value with every secret field replaced — the given value stays as it is.
 *
 * @param node the value, or a part of it
 * @param fields the names of the secret fields
 * @param swap what becomes of the text or the stored form of one secret field; `undefined` leaves the field to the walk
 * @param path where the part lies, for the message of an unusable field
 * @returns the copy
 */
function mapSecrets(
  node: unknown,
  fields: readonly string[],
  swap: (value: unknown, path: string) => unknown,
  path = "",
): unknown {
  if (Array.isArray(node)) {
    return node.map((item, index) => mapSecrets(item, fields, swap, `${path}[${index}]`));
  }
  if (!isRecord(node)) {
    return node;
  }
  const copy: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node)) {
    const at = path ? `${path}.${name}` : name;
    const swapped = fields.includes(name) ? swap(value, at) : undefined;
    copy[name] = swapped === undefined ? mapSecrets(value, fields, swap, at) : swapped;
  }
  return copy;
}

/**
 * The text a stored secret field holds. The text was encrypted as JSON: under another system secret the platform's
 * cipher either throws or gives back other characters, and those are no JSON text — so a wrong key never passes as the
 * secret. The message names the field, never what the cipher gave back.
 *
 * @param cipher the adapter instance
 * @param sealed what the file holds for the field
 * @param path where the field lies
 * @returns the secret
 */
function unseal(cipher: DataFileCipher, sealed: string, path: string): string {
  let text: unknown;
  try {
    text = JSON.parse(cipher.decrypt(sealed));
  } catch {
    text = undefined;
  }
  if (typeof text !== "string") {
    throw new Error(`secret field ${path} cannot be decrypted`);
  }
  return text;
}

/**
 * Whether a file-system error says the path is not there.
 *
 * @param err what the file system threw
 * @returns true for ENOENT
 */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Read a data file.
 *
 * @param dir the folder in the instance data folder
 * @param file the file name in it
 * @param secrets the secret fields of the file, when it holds any
 * @returns the value, nothing (no file yet), or the reason the file is unusable
 */
export function readDataFile(dir: string, file: string, secrets?: DataFileSecrets): DataFileRead {
  let raw: string;
  try {
    raw = readFileSync(join(dir, file), "utf8");
  } catch (err) {
    return isMissing(err) ? {} : { error: errText(err) };
  }
  let stored: unknown;
  try {
    stored = JSON.parse(raw) as unknown;
  } catch (err) {
    return { error: `no JSON: ${errText(err)}` };
  }
  if (!secrets) {
    return { value: stored };
  }
  let clear = false;
  let value: unknown;
  try {
    value = mapSecrets(stored, secrets.fields, (field, path) => {
      if (typeof field === "string") {
        clear = true;
        return field;
      }
      const sealed = isRecord(field) && Object.keys(field).length === 1 ? field[SEALED] : undefined;
      return typeof sealed === "string" ? unseal(secrets.cipher, sealed, path) : undefined;
    });
  } catch (err) {
    return { error: errText(err) };
  }
  if (clear) {
    try {
      writeDataFile(dir, file, value, secrets);
    } catch {
      // the file stays as it was read — the adapter's next write of it fails with the same error, loudly
    }
  }
  return { value };
}

/**
 * Write a data file — a temporary file, flushed to the disk, renamed over the old one (rename orders the name only:
 * without the flush a power cut can leave the new name on an empty or half file).
 *
 * @param dir the folder in the instance data folder (created when missing)
 * @param file the file name in it
 * @param value what to store, as JSON
 * @param secrets the secret fields of the file, when it holds any — each text in one of them is stored encrypted
 */
export function writeDataFile(dir: string, file: string, value: unknown, secrets?: DataFileSecrets): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, file);
  const temp = `${target}.tmp`;
  const stored = secrets
    ? mapSecrets(value, secrets.fields, field =>
        typeof field === "string" ? { [SEALED]: secrets.cipher.encrypt(JSON.stringify(field)) } : undefined,
      )
    : value;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
}

/**
 * Move a data file aside under another name — a file that cannot be read is kept this way instead of being overwritten
 * by the next write. Nothing happens when the file is not there.
 *
 * @param dir the folder in the instance data folder
 * @param file the file name in it
 * @param aside the name it is kept under
 */
export function setAsideDataFile(dir: string, file: string, aside: string): void {
  try {
    renameSync(join(dir, file), join(dir, aside));
  } catch (err) {
    if (!isMissing(err)) {
      throw err;
    }
  }
}

/**
 * Remove a data file. Nothing happens when the file is not there.
 *
 * @param dir the folder in the instance data folder
 * @param file the file name in it
 */
export function removeDataFile(dir: string, file: string): void {
  try {
    unlinkSync(join(dir, file));
  } catch (err) {
    if (!isMissing(err)) {
      throw err;
    }
  }
}

/**
 * The files of a folder in the instance data folder, in order — its sub-folders not. Nothing while the folder is not
 * there.
 *
 * @param dir the folder in the instance data folder
 * @returns the file names, sorted
 */
export function listDataFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort();
  } catch (err) {
    if (isMissing(err)) {
      return [];
    }
    throw err;
  }
}
