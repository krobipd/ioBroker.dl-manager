// The file stays in src/ and ships from there (package.json `files`): the build compiles TypeScript only, and this path
// reaches it from src/lib and from build/lib alike.
import limits from "../../src/lib/api-limits.json";

/** One limit: at most `max` calls in `seconds`, per host or for the whole account, and where the number comes from. */
export interface ApiLimit {
  /** Calls allowed in the window. */
  max: number;
  /** The window in seconds. */
  seconds: number;
  /** Whether each host has its own window or all calls share one. */
  per: "host" | "account";
  /** The documentation, a measurement with its date, or the adapter's own cap. */
  source: string;
}

/** One counterpart and its limits — the inventory run counts every call against them. */
export interface ApiCounterpart {
  /** What it is. */
  name: string;
  /** Which calls belong to it — every field given must fit; `network: "private"` is every address of the user's network. */
  match: { host?: string; network?: "private"; port?: number; kind?: "http" | "tcp" | "udp" };
  /** Its limits. */
  limits: ApiLimit[];
}

/** The counterpart of every download program the user runs — each program's host has its own window. */
export const LOCAL_PROGRAMS = "Download program in the user's network";
/** The counterpart of the My.JDownloader cloud — every account's calls share its window. */
export const MY_JDOWNLOADER = "My.JDownloader";

/** Every counterpart the adapter calls, defined in ONE place: `api-limits.json`. */
export const API_COUNTERPARTS: readonly ApiCounterpart[] = limits.counterparts as ApiCounterpart[];

/**
 * @param name the counterpart's name in `api-limits.json`
 * @param seconds the window of the limit
 * @returns the limit of that counterpart in that window
 */
export function apiLimit(name: string, seconds: number): ApiLimit {
  const limit = API_COUNTERPARTS.find(c => c.name === name)?.limits.find(l => l.seconds === seconds);
  if (!limit) {
    throw new Error(`api-limits.json declares no ${seconds}-second limit for '${name}'`);
  }
  return limit;
}
