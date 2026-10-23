import type { ProgramRow } from "./config";
import type { Command } from "./model";
import { redact } from "./redact";
import { toMBps } from "./units";

/**
 * @param rows the program rows at the start
 * @returns the one info line of the start: which programs run, which are switched off
 */
export function startLine(rows: readonly ProgramRow[]): string {
  if (!rows.length) {
    return "no program configured — add one on the settings page of the instance";
  }
  const on = rows.filter(r => r.enabled).map(r => r.id);
  const off = rows.filter(r => !r.enabled).map(r => r.id);
  const tail = off.length ? ` — switched off: ${off.join(", ")}` : "";
  return `${on.length} program(s) asked${on.length ? `: ${on.join(", ")}` : ""}${tail}`;
}

/**
 * @param cmd a user's command
 * @param name the download's name for its key — the key itself while the program has not listed it
 * @returns what the command did, for the info line after it (a link without its credentials)
 */
export function commandLine(cmd: Command, name: (key: string) => string): string {
  const limit = (bps: number): string => (bps > 0 ? `${toMBps(bps)} MB/s` : "off");
  switch (cmd.kind) {
    case "pauseAll":
      return "paused";
    case "resumeAll":
      return "resumed";
    case "pause":
      return `paused "${name(cmd.key)}"`;
    case "resume":
      return `resumed "${name(cmd.key)}"`;
    case "remove":
      return `removed "${name(cmd.key)}" from the program's list`;
    case "add":
      return `added ${redact(cmd.url)}`;
    case "setSpeedLimit":
      return `download limit ${limit(cmd.bps)}`;
    case "setUploadLimit":
      return `upload limit ${limit(cmd.bps)}`;
    case "setAltSpeed":
      return `alternative speed limits ${cmd.on ? "on" : "off"}`;
    case "extra":
      return cmd.key ? `${cmd.name} for "${name(cmd.key)}"` : cmd.name;
  }
}
