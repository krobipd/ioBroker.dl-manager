import type { DriverDeps, ProgramConfig, ProgramDriver, ProgramEntry } from "../core/model";
import { CATALOG, needsOf, type ProgramType } from "./catalog";
import { AriaDriver } from "./aria2/driver";
import { DlDriver } from "./deluge/driver";
import { JdDriver } from "./jdownloader/driver";
import { NzbDriver } from "./nzbget/driver";
import { PyDriver } from "./pyload/driver";
import { QbDriver } from "./qbittorrent/driver";
import { SabDriver } from "./sabnzbd/driver";
import { TrDriver } from "./transmission/driver";

/** The driver of each program type — the catalog says what else there is to know about it. */
const DRIVERS: Readonly<Record<ProgramType, (cfg: ProgramConfig, deps: DriverDeps) => ProgramDriver>> = {
  jdownloader: (cfg, deps) => new JdDriver(cfg, deps),
  "jdownloader-cloud": (cfg, deps) => new JdDriver(cfg, deps),
  qbittorrent: (cfg, deps) => new QbDriver(cfg, deps),
  transmission: (cfg, deps) => new TrDriver(cfg, deps),
  deluge: (cfg, deps) => new DlDriver(cfg, deps),
  sabnzbd: (cfg, deps) => new SabDriver(cfg, deps),
  nzbget: (cfg, deps) => new NzbDriver(cfg, deps),
  aria2: (cfg, deps) => new AriaDriver(cfg, deps),
  pyload: (cfg, deps) => new PyDriver(cfg, deps),
};

/** THE program list — one entry per catalog type. */
export const PROGRAMS: readonly ProgramEntry[] = CATALOG.map(info => ({
  type: info.type,
  needs: needsOf(info),
  create: DRIVERS[info.type],
}));

/**
 * @param type program type from a stored program row
 * @returns the registry entry, undefined for a type the adapter does not know
 */
export function findProgram(type: string): ProgramEntry | undefined {
  return PROGRAMS.find(p => p.type === type);
}
