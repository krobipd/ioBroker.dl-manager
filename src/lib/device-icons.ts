import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Program type → pictogram file; the torrent programs share one, the usenet programs another. */
export const ICON_BY_TYPE: Readonly<Record<string, string>> = {
  jdownloader: "jdownloader.svg",
  "jdownloader-cloud": "jdownloader.svg",
  qbittorrent: "torrent.svg",
  transmission: "torrent.svg",
  deluge: "torrent.svg",
  sabnzbd: "usenet.svg",
  nzbget: "usenet.svg",
  aria2: "aria2.svg",
  pyload: "pyload.svg",
};

/** The admin inlines only a data URI — a path lands in a plain `<img>` and keeps its colour in every theme. */
export const ICON_URI_PREFIX = "data:image/svg+xml;base64,";

// build/lib and src/lib both sit two levels below the adapter root
const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");
const cache = new Map<string, string | undefined>();

/**
 * @param svg file content
 * @returns the content with LF line endings (a CRLF checkout on Windows gives the same URI)
 */
export function normaliseLineEndings(svg: string): string {
  return svg.replace(/\r\n/g, "\n");
}

/**
 * @param type program type
 * @returns inline data URI of the program's pictogram, undefined for an unknown type or an unreadable file
 */
export function deviceIcon(type: string | undefined): string | undefined {
  // API boundary: "constructor" and friends are inherited, not entries of the map
  if (type === undefined || !Object.hasOwn(ICON_BY_TYPE, type)) {
    return undefined;
  }
  if (cache.has(type)) {
    return cache.get(type);
  }
  let uri: string | undefined;
  try {
    const svg = readFileSync(join(ICON_DIR, ICON_BY_TYPE[type]), "utf8");
    uri = `${ICON_URI_PREFIX}${Buffer.from(normaliseLineEndings(svg)).toString("base64")}`;
  } catch {
    uri = undefined;
  }
  cache.set(type, uri);
  return uri;
}
