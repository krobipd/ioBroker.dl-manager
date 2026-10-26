import { ProtocolError } from "./errors";

/*
 * A program's answer that lost its shape — an update that renamed a field, a proxy, a broken reply — is refused whole:
 * read as "no downloads" it would delete every download channel (fleet suite C26b, drifted JSON). Optional parts stay
 * lenient (`asRecords`); these checks are for the lists a complete snapshot is built from and for the ids in them.
 */

/**
 * @param v the part of an answer that must be a list
 * @param what what it is, for the error text
 * @returns the list
 */
export function listIn(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new ProtocolError(`${what} is no list — answer refused`);
  }
  return v;
}

/**
 * @param v the part of an answer that must be an object
 * @param what what it is, for the error text
 * @returns the object
 */
export function recordIn(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ProtocolError(`${what} is no object — answer refused`);
  }
  return v as Record<string, unknown>;
}

/**
 * @param v a list whose every entry must be an object
 * @param what what it is, for the error text
 * @returns its entries
 */
export function recordsIn(v: unknown, what: string): Record<string, unknown>[] {
  return listIn(v, what).map(e => recordIn(e, `an entry of ${what}`));
}

/**
 * @param v a map (id → object) whose every value must be an object
 * @param what what it is, for the error text
 * @returns its entries
 */
export function recordMapIn(v: unknown, what: string): [string, Record<string, unknown>][] {
  return Object.entries(recordIn(v, what)).map(([k, e]) => [k, recordIn(e, `${what} ${k}`)]);
}

/**
 * @param entry one entry of a download list
 * @param field the field that names it
 * @param what the list, for the error text
 * @param kind what the program names its downloads with — a drifted answer turns a text into a number and back
 * @returns the id as text — a non-empty text, or a whole number for `kind` "number"
 */
export function idIn(entry: Record<string, unknown>, field: string, what: string, kind: "text" | "number"): string {
  const v = entry[field];
  if (kind === "text" && typeof v === "string" && v !== "") {
    return v;
  }
  if (kind === "number" && typeof v === "number" && Number.isInteger(v)) {
    return String(v);
  }
  throw new ProtocolError(`an entry of ${what} without its ${field} — answer refused`);
}
