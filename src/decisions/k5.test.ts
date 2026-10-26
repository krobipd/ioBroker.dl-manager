// Core decision K5 (accepted 2026-10-22, krobi: "alle soweit ok"): after a rejected login the adapter asks the program
// no more until the user changes its card — some programs block an IP after several wrong logins, so the adapter does
// not try again every minute; one warning points at the card.
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "../lib/core/errors";
import { ProgramManager, type ManagerAdapter } from "../lib/core/manager";
import type { ProgramEntry, ProgramSnapshot } from "../lib/core/model";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

const quiet = (): void => undefined;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

/** An instance's object store that keeps nothing — the login lock is what this guard looks at. */
const adapter: ManagerAdapter = {
  namespace: "dl-manager.0",
  log: { debug: quiet, info: quiet, warn: quiet },
  extendObject: () => Promise.resolve(),
  delObject: () => Promise.resolve(),
  knownObject: () => undefined,
  getForeignObjects: () => Promise.resolve({}),
  knownValue: () => undefined,
  setState: () => Promise.resolve(),
  setStateChanged: () => Promise.resolve(),
  getForeignObjectAsync: () => Promise.resolve(null),
  setForeignObject: () => Promise.resolve(),
};

describe("K5 after a rejected login the program is not asked again until its card changes", () => {
  it("stops asking after a rejected login, warns once with a pointer to the card, and asks again after a card change", async () => {
    const polls: string[] = [];
    const timers: (() => void)[] = [];
    const reports: { key: string; title: string; action: string }[] = [];
    const entry: ProgramEntry = {
      type: "qbittorrent",
      needs: ["host"],
      create: cfg => ({
        type: "qbittorrent",
        capabilities: new Set(),
        extras: [],
        poll: (): Promise<ProgramSnapshot> => {
          polls.push(cfg.password);
          return cfg.password === "right"
            ? Promise.resolve({ status: { version: "5", paused: false, downloadBps: 0 }, items: [], complete: true })
            : Promise.reject(new AuthError("login rejected"));
        },
        command: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    };
    const manager = new ProgramManager(
      {
        adapter,
        timers: {
          setTimeout: cb => {
            timers.push(cb);
            return undefined;
          },
          clearTimeout: () => undefined,
        },
        find: () => entry,
        problems: { report: (key, title, action) => void reports.push({ key, title, action }), forget: quiet },
        moveDevice: () => Promise.resolve(),
      },
      { intervalMs: 60_000, scope: "all", limit: 100 },
    );
    const row = { id: "qbittorrent-nas", type: "qbittorrent", name: "NAS", host: "nas", username: "admin" };

    await manager.start([{ ...row, password: "wrong" }]);
    await settle();
    expect(polls).toEqual(["wrong"]);
    expect(reports).toHaveLength(1);
    expect(reports[0].title).toContain("not asked again until its card changes");
    expect(reports[0].action).toContain("card");

    // every timer the adapter holds runs out, and an unchanged card is taken over again — the program is not asked
    for (const fire of timers.splice(0)) {
      fire();
    }
    await manager.apply([{ ...row, password: "wrong" }]);
    await settle();
    expect(polls).toEqual(["wrong"]);
    expect(reports).toHaveLength(1);

    // the user corrects the card: the program is asked again
    await manager.apply([{ ...row, password: "right" }]);
    await settle();
    expect(polls).toEqual(["wrong", "right"]);
    await manager.stop();
  });
});
