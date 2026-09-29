import { forCapabilities, ITEM_DATAPOINTS, PROGRAM_DATAPOINTS, type DatapointDef } from "./datapoints";
import type { Capability, Command, ExtraDefinition } from "./model";

/** What the router needs to know about one program. */
export interface RouteTarget {
  /** The driver's capabilities. */
  readonly capabilities: ReadonlySet<Capability>;
  /** The driver's extras. */
  readonly extras: readonly ExtraDefinition[];
  /** Raw key of a download channel (`ProgramTree.itemKey`). */
  itemKey(channel: string): string | undefined;
}

/** Where a user write goes. */
export type Route =
  | { kind: "pauseAll"; on: boolean }
  | {
      kind: "command";
      program: string;
      cmd: Command;
      /** Buttons and `add` are confirmed with ack after the command; switches and limits wait for the next poll. */
      confirm: boolean;
    }
  | { kind: "ignore" };

const IGNORE: Route = { kind: "ignore" };

/**
 * @param defs the datapoints the program has
 * @param dp the written datapoint
 * @param val the written value
 * @param key the download's raw key ("" on program level)
 * @returns the command and whether it is confirmed at once, null when the write asks for nothing
 */
function fromTable<S>(
  defs: readonly DatapointDef<S>[],
  dp: string,
  val: ioBroker.StateValue,
  key: string,
): { cmd: Command; confirm: boolean } | null {
  const d = defs.find(x => x.id === dp);
  const cmd = d?.command?.(val, key) ?? null;
  return d && cmd ? { cmd, confirm: !d.read } : null;
}

/**
 * Turns a user write (`ack: false`) into a command.
 *
 * @param relId the state id below the instance, e.g. `qbittorrent-nas.downloads.11112222.remove`
 * @param val the written value
 * @param find the program's routing facts by device id
 * @returns the route, `ignore` for anything that is not a command
 */
export function routeState(
  relId: string,
  val: ioBroker.StateValue,
  find: (program: string) => RouteTarget | undefined,
): Route {
  if (relId === "summary.pauseAll") {
    return { kind: "pauseAll", on: val === true };
  }
  const parts = relId.split(".");
  const program = parts[0];
  const t = find(program);
  if (!t) {
    return IGNORE;
  }
  const route = (cmd: Command | null, confirm: boolean): Route =>
    cmd ? { kind: "command", program, cmd, confirm } : IGNORE;
  const extra = (level: ExtraDefinition["level"], dp: string, key?: string): Route => {
    const e = t.extras.find(x => x.level === level && x.id === dp && x.write);
    if (!e) {
      return IGNORE;
    }
    const button = e.role === "button";
    if (button && val !== true) {
      return IGNORE;
    }
    const cmd: Command = { kind: "extra", name: e.id, ...(key ? { key } : {}), ...(button ? {} : { value: val }) };
    return route(cmd, button);
  };

  if (parts.length === 2) {
    const dp = parts[1];
    const hit = fromTable(forCapabilities(PROGRAM_DATAPOINTS, t.capabilities), dp, val, "");
    return hit ? route(hit.cmd, hit.confirm) : extra("program", dp);
  }
  if (parts.length === 4 && parts[1] === "downloads") {
    const key = t.itemKey(parts[2]);
    if (key === undefined) {
      return IGNORE;
    }
    const dp = parts[3];
    const hit = fromTable(forCapabilities(ITEM_DATAPOINTS, t.capabilities), dp, val, key);
    return hit ? route(hit.cmd, hit.confirm) : extra("item", dp, key);
  }
  return IGNORE;
}
