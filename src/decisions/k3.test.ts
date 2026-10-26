// Core decision K3 (accepted 2026-10-22, krobi: "alle soweit ok"): an unknown raw status becomes "queued" with a debug
// line — when a program update brings a new status, the download shows "queued" instead of an error, and the debug log
// names the raw value so it can be added.
import { describe, expect, it } from "vitest";
import type { Status } from "../lib/core/model";
import { mapAriaStatus } from "../lib/programs/aria2/map";
import { mapDlStatus } from "../lib/programs/deluge/map";
import { mapJdStatus } from "../lib/programs/jdownloader/map";
import { mapNzbStatus } from "../lib/programs/nzbget/map";
import { mapPyStatus } from "../lib/programs/pyload/map";
import { MaindataState, mapQbState, toSnapshot } from "../lib/programs/qbittorrent/map";
import { mapSabStatus } from "../lib/programs/sabnzbd/map";
import { mapTrStatus } from "../lib/programs/transmission/map";

type Mapper = (raw: string | number, debug: (msg: string) => void) => Status;
/** Per program: its status mapping and a raw status it does not know, written the way the program reports one. */
const UNKNOWN: Record<string, [Mapper, string | number]> = {
  aria2: [mapAriaStatus, "unknown"],
  deluge: [mapDlStatus, "Unknown"],
  jdownloader: [mapJdStatus, "FinalLinkState:SOMETHING_NEW"],
  nzbget: [mapNzbStatus, "q:SOMETHING_NEW"],
  pyload: [mapPyStatus, 99],
  qbittorrent: [mapQbState, "somethingNew"],
  sabnzbd: [mapSabStatus, "q:SomethingNew"],
  transmission: [mapTrStatus, "9:0:left"],
};

describe("K3 an unknown raw status becomes queued, with a debug line", () => {
  it("shows queued for a status the program never reported before, and names the raw value in a debug line", () => {
    for (const [program, [map, raw]] of Object.entries(UNKNOWN)) {
      const lines: string[] = [];
      expect(
        map(raw, m => lines.push(m)),
        program,
      ).toBe("queued");
      expect(lines.join("\n"), program).toContain(String(raw));
    }
  });

  it("writes queued into the download, not an error", () => {
    const lines: string[] = [];
    const m = new MaindataState();
    m.apply({ full_update: true, torrents: { abc: { name: "distro", state: "brandNewState" } } });
    const [item] = toSnapshot("v5.0.0", m, false, msg => lines.push(msg)).items;
    expect(item).toMatchObject({ status: "queued", error: "" });
    expect(lines.join("\n")).toContain("brandNewState");
  });
});
