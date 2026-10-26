// Core decision D-07 (accepted 2026-10-22): programs are set up as device-manager cards like in the yamaha adapter, not
// in a table; each dialog shows only the fields of its program; the same program may be added any number of times, only
// never twice with the same configuration — the same address, or the same My.JDownloader account with the same instance.
// krobi 2026-09-29 18:14: "I don't like the admin at all … creating with a table is horrible" · 18:19: "the design should
// allow adding any number of services any number of times, as long as the config is not the same — you could have 2
// jdownloaders (e.g. one my.jdownloader somewhere at a friend's and a local one)" · 18:23: "for the card design I would
// rather take the yamaha adapter" · 18:35 on the clickable preview: "of course, really cool, please definitely build it".
import { describe, expect, it, vi } from "vitest";
import { parsePrograms, sameProgram } from "../lib/core/config";
import { DlDeviceManagement, type DmHost } from "../lib/device-management";
import { programForm } from "../lib/dm-forms";
import { findProgram } from "../lib/programs/registry";

// adapter-core's I18n needs a running adapter; a text is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

type Row = Record<string, unknown>;
const qb = (id: string, host: string, extra: Row = {}): Row => ({
  id,
  enabled: true,
  type: "qbittorrent",
  name: id,
  host,
  username: "admin",
  password: "pw",
  ...extra,
});
const cloud = (id: string, username: string, device: string, deviceId: string): Row => ({
  id,
  enabled: true,
  type: "jdownloader-cloud",
  name: id,
  username,
  password: "pw",
  device,
  deviceId,
});
const target = (row: Row): Parameters<typeof sameProgram>[0] => parsePrograms([row], findProgram)[0].cfg;

/**
 * @param rows the stored program rows
 * @returns the device manager on them, what it stored and what it said
 */
function manager(rows: Row[]): {
  dm: {
    loadDevices(ctx: { addDevice: (card: unknown) => void }): Promise<void>;
    getInstanceInfo(): { actions: { handler: (ctx: unknown) => Promise<unknown> }[] };
  };
  stored: () => Row[];
  writes: () => number;
} {
  let stored = structuredClone(rows);
  let writes = 0;
  const host: DmHost = {
    readRows: () => Promise.resolve(structuredClone(stored)),
    updateRows: change => {
      const next = change(structuredClone(stored));
      if (next) {
        writes++;
        stored = structuredClone(next);
      }
      return Promise.resolve();
    },
    hasObject: () => Promise.resolve(false),
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
  const dm = new DlDeviceManagement(adapter as never, host);
  return { dm: dm as unknown as ReturnType<typeof manager>["dm"], stored: () => stored, writes: () => writes };
}

describe("D-07 programs as device-manager cards, any number of them, twice only with another configuration", () => {
  it("shows every program as a card of the device manager, the same program as often as it is set up", async () => {
    const rows = [
      qb("qbittorrent-nas", "nas"),
      qb("qbittorrent-pc", "pc"),
      { id: "jdownloader-cellar", enabled: true, type: "jdownloader", name: "JD", host: "cellar" },
      cloud("jdownloader-1111", "me@example.com", "Friend", "aaaa1111"),
    ];
    const cards: { id: string }[] = [];
    await manager(rows).dm.loadDevices({ addDevice: card => cards.push(card as { id: string }) });
    expect(cards.map(c => c.id)).toEqual(rows.map(r => r.id));
  });

  it("asks in each dialog only the fields of its program", () => {
    const fields = (type: Parameters<typeof programForm>[0]): string[] =>
      Object.keys((programForm(type, { takenKeys: [] }) as unknown as { items: Row }).items);
    expect(fields("sabnzbd")).toContain("apiKey");
    expect(fields("sabnzbd")).not.toContain("username");
    expect(fields("deluge")).toContain("password");
    expect(fields("deluge")).not.toContain("username");
    expect(fields("deluge")).not.toContain("apiKey");
    expect(fields("transmission")).toContain("needLogin");
    expect(fields("qbittorrent")).toContain("login");
    expect(fields("nzbget")).not.toContain("apiKey");
    expect(fields("aria2")).not.toContain("username");
  });

  it("calls two entries the same program when the address or the My.JDownloader account and instance are the same", () => {
    expect(sameProgram(target(qb("a", "nas")), target(qb("b", "NAS", { https: true })))).toBe(true);
    expect(sameProgram(target(qb("a", "nas")), target(qb("b", "nas", { port: 8080 })))).toBe(true);
    expect(sameProgram(target(qb("a", "nas")), target(qb("b", "nas", { port: 9090 })))).toBe(false);
    expect(sameProgram(target(qb("a", "nas")), target(qb("b", "pc")))).toBe(false);
    const mine = target(cloud("a", "me@example.com", "Cellar", "aaaa1111"));
    expect(sameProgram(mine, target(cloud("b", "ME@example.com", "Cellar", "aaaa1111")))).toBe(true);
    expect(sameProgram(mine, target(cloud("b", "me@example.com", "Office", "bbbb2222")))).toBe(false);
    expect(sameProgram(mine, target(cloud("b", "friend@example.com", "Cellar", "cccc3333")))).toBe(false);
  });

  it("refuses a second entry for the same program in the dialog and never asks a stored twin", async () => {
    const m = manager([qb("qbittorrent-nas", "nas")]);
    const answers: Row[] = [{ type: "qbittorrent" }, { name: "again", host: "nas", login: "user", enabled: true }];
    const said: unknown[] = [];
    const ctx = {
      showForm: () => Promise.resolve(answers.shift()),
      showMessage: (text: unknown) => {
        said.push(text);
        return Promise.resolve();
      },
      openProgress: () => Promise.resolve({ update: () => Promise.resolve(), close: () => Promise.resolve() }),
    };
    await m.dm.getInstanceInfo().actions[0].handler(ctx);
    expect(m.writes()).toBe(0);
    expect(m.stored()).toHaveLength(1);
    expect(JSON.stringify(said)).toContain("dmDuplicate");

    const [first, twin] = parsePrograms([qb("qbittorrent-nas", "nas"), qb("qbittorrent-nas-2", "nas")], findProgram);
    expect(first.entry).toBeDefined();
    expect(twin.entry).toBeUndefined();
    expect(twin.problem).toBe("same program as qbittorrent-nas");
  });
});
