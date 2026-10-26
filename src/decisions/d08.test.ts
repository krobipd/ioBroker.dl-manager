// Core decision D-08 (accepted 2026-10-22): the card shows, it controls nothing — no switch on the card that pauses all
// downloads; pausing goes through the datapoint `paused`, which stays. krobi 2026-09-29 23:04: "on the cards you still
// have a small symbol, and when you click it you can pause all downloads — away with it. in the admin we don't need such
// a control".
import { describe, expect, it, vi } from "vitest";
import { PROGRAM_DATAPOINTS } from "../lib/core/datapoints";
import { DlDeviceManagement, type DmHost } from "../lib/device-management";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

interface Card {
  id: string;
  controls?: unknown;
  actions: { id: string }[];
  indicators: { id: string }[];
}

describe("D-08 the card shows, it controls nothing", () => {
  it("draws no control on the card of a program that can pause, only what it shows and how it is set up", async () => {
    const rows = [
      { id: "qbittorrent-nas", enabled: true, type: "qbittorrent", name: "NAS", host: "nas" },
      { id: "jdownloader-cellar", enabled: true, type: "jdownloader", name: "JD", host: "cellar" },
    ];
    const host: DmHost = {
      readRows: () => Promise.resolve(structuredClone(rows)),
      updateRows: () => Promise.resolve(),
      // both programs have every datapoint, `paused` included
      hasObject: () => Promise.resolve(true),
      readState: () => Promise.resolve(undefined),
      test: () => Promise.resolve({ ok: true, version: "1" }),
      listJdDevices: () => Promise.resolve([]),
      icon: () => undefined,
      iobHost: () => "iobhost",
    };
    const adapter = {
      namespace: "dl-manager.0",
      on: () => undefined,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
      setTimeout: () => undefined,
    };
    const dm = new DlDeviceManagement(adapter as never, host) as unknown as {
      loadDevices(ctx: { addDevice: (card: unknown) => void }): Promise<void>;
    };
    const cards: Card[] = [];
    await dm.loadDevices({ addDevice: card => cards.push(card as Card) });
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.controls, card.id).toBeUndefined();
      expect(
        card.indicators.map(i => i.id),
        card.id,
      ).toContain("paused");
      expect(
        card.actions.map(a => a.id).filter(id => /pause|resume|stop|start/i.test(id)),
        card.id,
      ).toEqual([]);
    }
  });

  it("keeps the datapoint paused, which pauses and resumes the whole program", () => {
    const paused = PROGRAM_DATAPOINTS.find(d => d.id === "paused");
    expect(paused).toMatchObject({ type: "boolean", role: "switch", write: true, capability: "globalPause" });
    expect(paused?.command?.(true, "")).toEqual({ kind: "pauseAll" });
    expect(paused?.command?.(false, "")).toEqual({ kind: "resumeAll" });
  });
});
