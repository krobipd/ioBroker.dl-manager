import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";

/**
 * Every key `admin/i18n/en.json` carries. Exported so the metric registry can type its
 * `nameKey`/`descKey`/channel-key fields with it — a mistyped key is then a compile error
 * instead of a silent `{ en: <key> }` from adapter-core (which the state-role gate only
 * catches for LITERAL keys, never for one that is looked up in a table).
 */
export type I18nKey = keyof typeof translations;

/**
 * Translation object for the given i18n key.
 *
 * @param key Translation key from admin/i18n/en.json
 * @param args Values for the `%s` placeholders of that key, substituted in every language
 */
export function tName(key: I18nKey, ...args: (string | number)[]): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key, ...args);
}

/**
 * Translation object for a datapoint's `common.desc`. Same lookup as {@link tName} —
 * separate name so a reader sees at the call site that this is the EXPLANATION, which
 * the fleet standard treats differently from the label: one plain sentence, never an
 * identifier, and left out entirely where there is nothing to explain.
 *
 * @param key Translation key from admin/i18n/en.json (the `desc…` keys)
 */
export function tDesc(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}

/**
 * Translated PLAIN STRING for a `common.states` label.
 *
 * `common.states` values must not be translation objects — the admin renders them
 * directly as a React child, and an object there takes the whole GUI down with
 * React error #31 (fleet standard, `@iobroker/types` types the field as
 * `Record<string, string>` accordingly). The standard's other half is that the plain
 * string still follows the system language, so this resolves the key against the
 * language `I18n.init` picked up from `system.config`, falling back to English.
 *
 * @param key Translation key from admin/i18n/en.json
 */
export function tState(key: I18nKey): string {
  return I18n.translate(key);
}

/**
 * Translated PLAIN STRING for a message that reaches the user as text — the response of
 * the connection test in the admin dialog. Same rule as {@link tState}: user-facing text
 * follows the system language, and a response field is a string, not a translation
 * object.
 *
 * @param key Translation key from admin/i18n/en.json (the `msg…` keys)
 * @param args Values for the `%s` placeholders of that key
 */
export function tText(key: I18nKey, ...args: (string | number)[]): string {
  return I18n.translate(key, ...args);
}
