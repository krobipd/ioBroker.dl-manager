import type { DownloadItem, ProgramSnapshot, Status } from "../../core/model";
import { asText, eta, nonNegative } from "../../core/units";

/** One entry of `advancedStatus` — only the machine-readable id is read. */
interface JdStatusEntry {
  /** Enum name, e.g. `FINISHED`, `DOWNLOAD`, `RUNNING`. */
  id?: unknown;
}

/** A link of `downloadsV2/queryLinks`. JD leaves every false boolean out. */
export interface JdLink {
  /** Link id. */
  uuid: number;
  /** Package id. */
  packageUUID: number;
  /** File name. */
  name: string;
  /** Link is enabled (absent = false). */
  enabled?: boolean;
  /** A download controller works on it (absent = false). */
  running?: boolean;
  /** Finished (absent = false). */
  finished?: boolean;
  /** Skipped (absent = false). */
  skipped?: boolean;
  /** Localized text — shown as an error, never parsed. */
  status?: string;
  /** Machine-readable state (api-jdownloader.md § 3.3). */
  advancedStatus?: Partial<Record<string, JdStatusEntry>>;
  /** Added, ms since epoch. */
  addedDate?: number;
  /** Finished, ms since epoch. */
  finishedDate?: number;
}

const FINAL_OK = /^FINISHED/;
const FINAL_FAILED = /^FAILED|^OFFLINE$|^PLUGIN_DEFECT$/;
const PLUGIN_TASKS = new Set([
  "CAPTCHA",
  "DOWNLOAD",
  "EXTRACTION",
  "FFMPEG_INSTALLATION",
  "PHANTOMJS_INSTALLATION",
  "FFMPEG",
  "FLV_FIXER",
  "HASH",
  "WAIT",
  "DECRYPTING",
  "CONVERT",
  "PLUGIN",
  "USERIO",
  "MOVE_FILE",
]);
const POST_TASKS = new Set(["EXTRACTION", "FFMPEG", "FLV_FIXER", "CONVERT", "MOVE_FILE"]);
const WAIT_TASKS = new Set(["WAIT", "CAPTCHA", "USERIO"]);
const EXTRACTION = new Set([
  "NA",
  "IDLE",
  "RUNNING",
  "ERROR_PW",
  "ERROR",
  "SUCCESSFUL",
  "ERROR_CRC",
  "ERROR_NOT_ENOUGH_SPACE",
  "ERRROR_FILE_NOT_FOUND",
]);

const idOf = (l: JdLink, key: string): string => {
  const id = l.advancedStatus?.[key]?.id;
  return typeof id === "string" ? id : "";
};

/**
 * The status of a package from its links. The localized `status` text is only handed on as the error.
 *
 * @param links the package's links
 * @param debug debug log, names a state id the adapter does not know
 * @returns status and error text
 */
export function packageStatus(
  links: readonly JdLink[],
  debug: (msg: string) => void,
): { status: Status; error: string } {
  for (const l of links) {
    const final = idOf(l, "FinalLinkState");
    const task = idOf(l, "PluginProgress");
    const extraction = idOf(l, "ExtractionStatus");
    if (final && !FINAL_OK.test(final) && !FINAL_FAILED.test(final)) {
      debug(`jdownloader: unknown state FinalLinkState:${final} (${l.name}) — not mapped`);
    }
    if (task && !PLUGIN_TASKS.has(task)) {
      debug(`jdownloader: unknown state PluginProgress:${task} (${l.name}) — not mapped`);
    }
    if (extraction && !EXTRACTION.has(extraction)) {
      debug(`jdownloader: unknown state ExtractionStatus:${extraction} (${l.name}) — not mapped`);
    }
  }
  const running = links.some(l => l.running === true);
  const task = (ids: ReadonlySet<string>): boolean =>
    links.some(l => l.running === true && ids.has(idOf(l, "PluginProgress")));
  if (links.some(l => idOf(l, "ExtractionStatus") === "RUNNING") || task(POST_TASKS)) {
    return { status: "postprocessing", error: "" };
  }
  const extractError = links.find(l => idOf(l, "ExtractionStatus").startsWith("ERR"));
  if (extractError && !running) {
    return { status: "failed", error: asText(extractError.status) };
  }
  if (links.length > 0 && links.every(l => l.finished === true)) {
    return { status: "completed", error: "" };
  }
  const failed = links.find(l => FINAL_FAILED.test(idOf(l, "FinalLinkState")));
  if (failed && !running) {
    return { status: "failed", error: asText(failed.status) };
  }
  if (task(new Set(["DOWNLOAD"]))) {
    return { status: "downloading", error: "" };
  }
  if (task(WAIT_TASKS)) {
    return { status: "waiting", error: "" };
  }
  if (task(new Set(["HASH"]))) {
    return { status: "checking", error: "" };
  }
  if (links.length > 0 && links.every(l => l.enabled !== true || l.skipped === true)) {
    return { status: "paused", error: "" };
  }
  if (links.some(l => l.advancedStatus?.ConditionalSkipReason !== undefined)) {
    return { status: "waiting", error: "" };
  }
  return { status: running ? "downloading" : "queued", error: "" };
}

/**
 * A single-link package from a key of the status table (`<fact>:<value>`).
 *
 * @param raw e.g. `FinalLinkState:OFFLINE`, `enabled:false`, `none`
 * @returns the link
 */
export function jdLinkFromRaw(raw: string): JdLink {
  const [fact, value = ""] = raw.split(/:(.*)/s);
  const base: JdLink = { uuid: 1, packageUUID: 10, name: "a.bin", enabled: true };
  switch (fact) {
    case "FinalLinkState":
      return {
        ...base,
        finished: FINAL_OK.test(value) || undefined,
        advancedStatus: { FinalLinkState: { id: value } },
      };
    case "ExtractionStatus":
      return {
        ...base,
        finished: true,
        advancedStatus: { FinalLinkState: { id: "FINISHED" }, ExtractionStatus: { id: value } },
      };
    case "PluginProgress":
      return { ...base, running: true, advancedStatus: { PluginProgress: { id: value } } };
    case "ConditionalSkipReason":
      return { ...base, advancedStatus: { ConditionalSkipReason: { id: value } } };
    case "enabled":
      return { uuid: 1, packageUUID: 10, name: "a.bin" };
    case "skipped":
      return { ...base, skipped: true };
    case "status-text-only":
      return { ...base, status: value };
    default:
      return base;
  }
}

/**
 * The map layer as the contract suite sees it: one raw fact → status.
 *
 * @param raw key of the status table
 * @param debug debug log
 * @returns the status
 */
export function mapJdStatus(raw: string | number, debug: (msg: string) => void): Status {
  return packageStatus([jdLinkFromRaw(String(raw))], debug).status;
}

/** Every researched fact (api-jdownloader.md § 3.3) and the status it maps to. */
export const statusTable = [
  ["FinalLinkState:FINISHED", "completed"],
  ["FinalLinkState:FINISHED_MIRROR", "completed"],
  ["FinalLinkState:FINISHED_SHA256", "completed"],
  ["FinalLinkState:FAILED", "failed"],
  ["FinalLinkState:FAILED_CRC32", "failed"],
  ["FinalLinkState:OFFLINE", "failed"],
  ["FinalLinkState:PLUGIN_DEFECT", "failed"],
  ["ExtractionStatus:RUNNING", "postprocessing"],
  ["ExtractionStatus:ERROR_PW", "failed"],
  ["ExtractionStatus:ERROR_CRC", "failed"],
  ["ExtractionStatus:SUCCESSFUL", "completed"],
  ["PluginProgress:DOWNLOAD", "downloading"],
  ["PluginProgress:WAIT", "waiting"],
  ["PluginProgress:CAPTCHA", "waiting"],
  ["PluginProgress:HASH", "checking"],
  ["PluginProgress:EXTRACTION", "postprocessing"],
  ["enabled:false", "paused"],
  ["skipped:true", "paused"],
  ["ConditionalSkipReason:WaitingSkipReason", "waiting"],
  ["none", "queued"],
  ["status-text-only:Fertig", "queued"],
] as const satisfies readonly (readonly [string, Status])[];

const PAUSED_STATES = new Set(["PAUSE", "STOPPING", "STOPPED_STATE"]);

/**
 * The coarse status from the package's own booleans — only when its link list is missing.
 *
 * @param p the package of `queryPackages`
 * @returns the status
 */
function fromPackage(p: Record<string, unknown>): Status {
  if (p.finished === true) {
    return "completed";
  }
  if (p.running === true) {
    return "downloading";
  }
  return p.enabled === true ? "queued" : "paused";
}

/**
 * One poll into the common model. A download is a JD package (design decision 3).
 *
 * @param version `jd/version`
 * @param toolbar `toolbar/getStatus`
 * @param packages `downloadsV2/queryPackages`
 * @param links `downloadsV2/queryLinks`, null when that list failed
 * @param debug debug log
 * @returns the snapshot
 */
export function toSnapshot(
  version: string,
  toolbar: unknown,
  packages: unknown,
  links: unknown,
  debug: (msg: string) => void,
): ProgramSnapshot {
  const t = toolbar && typeof toolbar === "object" ? (toolbar as Record<string, unknown>) : {};
  const state = asText(t.state);
  const linkList = Array.isArray(links) ? (links as JdLink[]).filter(l => l && typeof l === "object") : null;
  const items: DownloadItem[] = [];
  for (const raw of Array.isArray(packages) ? (packages as unknown[]) : []) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.uuid !== "number") {
      continue;
    }
    const own = linkList?.filter(l => l.packageUUID === p.uuid) ?? null;
    const { status, error } = own ? packageStatus(own, debug) : { status: fromPackage(p), error: "" };
    const added = (own ?? []).map(l => l.addedDate).filter((v): v is number => typeof v === "number" && v > 0);
    const done = (own ?? []).map(l => l.finishedDate).filter((v): v is number => typeof v === "number" && v > 0);
    items.push({
      key: String(p.uuid),
      name: asText(p.name),
      status,
      sizeBytes: nonNegative(p.bytesTotal),
      doneBytes: nonNegative(p.bytesLoaded),
      speedBps: p.running === true ? (nonNegative(p.speed) ?? 0) : 0,
      etaSeconds: eta(p.eta, [-1]),
      addedMs: added.length ? Math.min(...added) : null,
      finishedMs: status === "completed" && done.length ? Math.max(...done) : null,
      error,
    });
  }
  return {
    status: {
      version,
      paused: PAUSED_STATES.has(state),
      downloadBps: nonNegative(t.speed),
      speedLimitBps: state !== "PAUSE" && t.limit === true ? (nonNegative(t.limitspeed) ?? 0) : 0,
    },
    items,
    complete: linkList !== null,
  };
}
