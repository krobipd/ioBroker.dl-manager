import type { Capability, Command, ExtraDefinition } from "./model";
import { fromMBps } from "./units";

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

const programCommand = (dp: string, val: ioBroker.StateValue, caps: ReadonlySet<Capability>): Command | null => {
  switch (dp) {
    case "paused":
      return caps.has("globalPause") ? { kind: val === true ? "pauseAll" : "resumeAll" } : null;
    case "speedLimit":
      return caps.has("speedLimit") ? { kind: "setSpeedLimit", bps: fromMBps(val) } : null;
    case "uploadLimit":
      return caps.has("uploadLimit") ? { kind: "setUploadLimit", bps: fromMBps(val) } : null;
    case "altSpeed":
      return caps.has("altSpeed") ? { kind: "setAltSpeed", on: val === true } : null;
    default:
      return null;
  }
};

const itemCommand = (
  dp: string,
  val: ioBroker.StateValue,
  key: string,
  caps: ReadonlySet<Capability>,
): Command | null => {
  if (dp === "paused" && caps.has("itemPause")) {
    return { kind: val === true ? "pause" : "resume", key };
  }
  if (dp === "remove" && caps.has("itemRemove") && val === true) {
    return { kind: "remove", key };
  }
  return null;
};

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
    if (dp === "add") {
      const url = typeof val === "string" ? val.trim() : "";
      return url && t.capabilities.has("add") ? route({ kind: "add", url }, true) : IGNORE;
    }
    const cmd = programCommand(dp, val, t.capabilities);
    return cmd ? route(cmd, false) : extra("program", dp);
  }
  if (parts.length === 4 && parts[1] === "downloads") {
    const key = t.itemKey(parts[2]);
    if (key === undefined) {
      return IGNORE;
    }
    const dp = parts[3];
    const cmd = itemCommand(dp, val, key, t.capabilities);
    if (cmd) {
      return route(cmd, cmd.kind === "remove");
    }
    return dp === "paused" || dp === "remove" ? IGNORE : extra("item", dp, key);
  }
  return IGNORE;
}
