import type { Mock } from "vitest";

vi.mock("./i18n", () => ({
  tName: (key: string, ...args: unknown[]) => (args.length ? { key, args } : key),
  tText: (key: string) => `plain:${key}`,
}));

import type { TestResult } from "./core/manager";
import { DlDeviceManagement, testText, type DmHost } from "./device-management";
import { applyRuleOf } from "./dm-forms";

const NS = "dl-manager.0";

interface Ctx {
  showForm: Mock;
  showMessage: Mock;
  showConfirmation: Mock;
  openProgress: Mock;
  progressClosed: () => number;
}
/**
 * @param forms what each showForm answers, in order
 * @returns a mock action context
 */
function context(...forms: unknown[]): Ctx {
  let closed = 0;
  return {
    showForm: vi.fn(() => Promise.resolve(forms.shift())),
    showMessage: vi.fn(() => Promise.resolve()),
    showConfirmation: vi.fn(() => Promise.resolve(true)),
    openProgress: vi.fn(() =>
      Promise.resolve({
        update: () => Promise.resolve(),
        close: () => {
          closed++;
          return Promise.resolve();
        },
      }),
    ),
    progressClosed: () => closed,
  };
}

interface Card {
  id: string;
  name: string;
  identifier: string;
  manufacturer: unknown;
  enabled: boolean;
  icon?: string;
  status: { connection: { stateId: string; mapping: unknown }; warning?: string };
  indicators: { id: string }[];
  controls: { id: string; stateId: string; handler: (d: string, c: string, v: unknown) => Promise<unknown> }[];
  actions: { id: string; confirmation?: unknown; handler: (id: string, ctx?: Ctx) => Promise<unknown> }[];
}
interface Internals {
  loadDevices(ctx: { addDevice: (c: unknown) => void }): Promise<void>;
  getInstanceInfo(): {
    apiVersion: string;
    identifierLabel: unknown;
    actions: { handler: (c: Ctx) => Promise<unknown> }[];
  };
}

/**
 * @param rows the stored settings rows
 * @param objects relative ids of the objects the instance has
 * @param values relative id → value of the states the instance has
 * @returns the manager, the fake host and the recorded writes
 */
function make(
  rows: Record<string, unknown>[] = [],
  objects: string[] = [],
  values: Record<string, ioBroker.StateValue> = {},
): {
  dm: Internals;
  host: DmHost & { written: Record<string, unknown>[][]; states: [string, unknown][] };
  timers: (() => void)[];
  errors: string[];
  devices: Mock;
  tested: Mock;
} {
  let stored = structuredClone(rows);
  const timers: (() => void)[] = [];
  const errors: string[] = [];
  const devices = vi.fn((): Promise<string[]> => Promise.resolve(["Keller-NAS", "Tom-PC"]));
  const tested = vi.fn((): Promise<TestResult> => Promise.resolve({ ok: true, version: "4.6", downloads: 2 }));
  const host = {
    written: [] as Record<string, unknown>[][],
    states: [] as [string, unknown][],
    readRows: () => Promise.resolve(structuredClone(stored)),
    writeRows: (next: Record<string, unknown>[]) => {
      host.written.push(structuredClone(next));
      stored = structuredClone(next);
      return Promise.resolve();
    },
    hasObject: (relId: string) => Promise.resolve(objects.includes(relId)),
    readState: (relId: string) => Promise.resolve(values[relId]),
    writeState: (relId: string, val: unknown) => {
      host.states.push([relId, val]);
      return Promise.resolve();
    },
    test: tested,
    listJdDevices: devices,
    icon: (type: string) => `icon:${type}`,
  };
  const adapter = {
    namespace: NS,
    on: () => undefined,
    log: { error: (m: string) => errors.push(m), warn: () => undefined, info: () => undefined, debug: () => undefined },
    setTimeout: (cb: () => void) => {
      timers.push(cb);
      return undefined;
    },
  };
  const dm = new DlDeviceManagement(adapter as never, host) as unknown as Internals;
  return { dm, host: host, timers, errors, devices, tested };
}

async function cards(dm: Internals): Promise<Card[]> {
  const out: Card[] = [];
  await dm.loadDevices({ addDevice: c => out.push(c as Card) });
  return out;
}
const action = (card: Card, id: string): Card["actions"][number] => card.actions.find(a => a.id === id)!;
const add = (dm: Internals): ((c: Ctx) => Promise<unknown>) => dm.getInstanceInfo().actions[0].handler;

const qbRow = {
  enabled: true,
  type: "qbittorrent",
  key: "nas",
  name: "NAS",
  host: "h1",
  username: "admin",
  password: "pw",
};
const jdRow = { enabled: true, type: "jdownloader", key: "keller", name: "JD Keller", host: "h2" };
const cloudRow = {
  enabled: true,
  type: "jdownloader-cloud",
  key: "tom",
  name: "JD Tom",
  username: "me@x.de",
  password: "pw",
  device: "Tom-PC",
};

describe("cards", () => {
  it("shows one card per row with address, program and live states", async () => {
    const { dm } = make([qbRow, jdRow, cloudRow, { ...qbRow, key: "off", host: "h9", enabled: false }]);
    const out = await cards(dm);
    expect(out.map(c => [c.id, c.name, c.identifier, c.manufacturer, c.enabled])).toEqual([
      ["qbittorrent-nas", "NAS", "http://h1:8080", "qBittorrent", true],
      ["jdownloader-keller", "JD Keller", "http://h2:3128", { key: "dmLocal", args: ["JDownloader 2"] }, true],
      ["jdownloader-cloud-tom", "JD Tom", "me@x.de/Tom-PC", { key: "dmCloud", args: ["JDownloader 2"] }, true],
      ["qbittorrent-off", "NAS", "http://h9:8080", "qBittorrent", false],
    ]);
    expect(out[0].icon).toBe("icon:qbittorrent");
    expect(out[0].status.connection).toEqual({
      stateId: `${NS}.qbittorrent-nas.online`,
      mapping: { true: "connected", false: "disconnected" },
    });
    expect(out[0].status.warning).toBeUndefined();
  });

  it("warns only about a real problem — not about Unknown, nothing, or a switched-off program", async () => {
    const { dm } = make([qbRow, jdRow, cloudRow, { ...qbRow, key: "off", host: "h9", enabled: false }], [], {
      "qbittorrent-nas.error": "login rejected (401)",
      "jdownloader-keller.error": "Unknown",
      "jdownloader-cloud-tom.error": "",
      "qbittorrent-off.error": "not reachable",
    });
    expect((await cards(dm)).map(c => c.status.warning)).toEqual([
      "login rejected (401)",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("switches a program on and off from its card", async () => {
    const { dm, host } = make([qbRow, jdRow]);
    const [qb] = await cards(dm);
    expect(await action(qb, "enable/disable").handler("qbittorrent-nas", context())).toEqual({ refresh: "devices" });
    expect(host.written[0].map(r => r.enabled)).toEqual([false, true]);
    await action(qb, "enable/disable").handler("qbittorrent-nas", context());
    expect(host.written[1].map(r => r.enabled)).toEqual([true, true]);
    await action(qb, "enable/disable").handler("qbittorrent-gone", context());
    expect(host.written).toHaveLength(2);
  });

  it("shows pause and free space only where the program has them", async () => {
    const { dm } = make([qbRow, jdRow], ["qbittorrent-nas.paused", "qbittorrent-nas.freeSpace"]);
    const [qb, jd] = await cards(dm);
    expect(qb.indicators.map(i => i.id)).toEqual(["downloading", "active", "paused", "freeSpace"]);
    expect(qb.controls.map(c => c.id)).toEqual(["paused"]);
    expect(jd.indicators.map(i => i.id)).toEqual(["downloading", "active"]);
    expect(jd.controls).toEqual([]);
  });

  it("answers a pause the database refused with an error instead of throwing", async () => {
    const { dm, host, errors } = make([qbRow], ["qbittorrent-nas.paused"]);
    host.writeState = () => Promise.reject(new Error("db down"));
    const [qb] = await cards(dm);
    expect(await qb.controls[0].handler("qbittorrent-nas", "paused", true)).toEqual({
      error: { code: 500, message: "db down" },
    });
    expect(errors[0]).toMatch(/could not be paused \(db down\)/);
  });

  it("pauses a program from its card the way a user write does", async () => {
    const { dm, host } = make([qbRow], ["qbittorrent-nas.paused"]);
    const [qb] = await cards(dm);
    expect(await qb.controls[0].handler("qbittorrent-nas", "paused", true)).toMatchObject({ val: true, ack: false });
    await qb.controls[0].handler("qbittorrent-nas", "paused", "yes");
    expect(host.states).toEqual([
      ["qbittorrent-nas.paused", true],
      ["qbittorrent-nas.paused", false],
    ]);
  });

  it("shows two rows with one device id as one card, and the name falls back to the id", async () => {
    const { dm } = make([
      { ...qbRow, name: "" },
      { ...qbRow, host: "h3" },
    ]);
    const out = await cards(dm);
    expect(out.map(c => [c.id, c.name])).toEqual([["qbittorrent-nas", "qbittorrent-nas"]]);
  });

  it("names the program in the delete question", async () => {
    const { dm } = make([qbRow]);
    const [qb] = await cards(dm);
    expect(action(qb, "delete").confirmation).toEqual({ key: "dmDeleteConfirm", args: ["NAS"] });
  });

  it("logs a list it cannot read and shows nothing", async () => {
    const { dm, host, errors } = make();
    host.readRows = () => Promise.reject(new Error("db down"));
    expect(await cards(dm)).toEqual([]);
    expect(errors[0]).toMatch(/could not read the programs \(db down\)/);
  });

  it("offers the add button and labels the address line", () => {
    const { dm } = make();
    const info = dm.getInstanceInfo();
    expect(info.apiVersion).toBe("v3");
    expect(info.identifierLabel).toBe("dmAddress");
  });
});

describe("adding a program", () => {
  it("chooses the program, then stores only its fields with an ID from the name", async () => {
    const { dm, host } = make([qbRow]);
    const ctx = context(
      { type: "deluge" },
      { name: "Deluge", host: "10.0.0.5", port: "", password: "pw", enabled: true },
    );
    expect(await add(dm)(ctx)).toEqual({ refresh: true });
    expect(host.written).toHaveLength(1);
    expect(host.written[0][1]).toMatchObject({
      type: "deluge",
      key: "",
      name: "Deluge",
      host: "10.0.0.5",
      port: 0,
      password: "pw",
      username: "",
      apiKey: "",
      enabled: true,
    });
    expect(ctx.showForm.mock.calls[1][1]).toMatchObject({ title: { key: "dmAddTitle", args: ["Deluge"] } });
    // OK waits for the dialog's own field checks
    const [schema, opts] = ctx.showForm.mock.calls[1] as [
      Parameters<typeof applyRuleOf>[0],
      { applyDisabledRule?: string },
    ];
    expect(opts.applyDisabledRule).toBe(applyRuleOf(schema));
    expect(opts.applyDisabledRule).not.toBe("false");
  });

  it("numbers the suggested name from the second program of a kind on, and counts both JDownloader connections", async () => {
    const { dm } = make([jdRow, cloudRow]);
    const ctx = context({ type: "jdownloader" }, undefined);
    await add(dm)(ctx);
    expect(ctx.showForm.mock.calls[1][1]).toMatchObject({ data: { name: "JDownloader 3" } });
    const first = make();
    const ctx2 = context({ type: "deluge" }, undefined);
    await add(first.dm)(ctx2);
    expect(ctx2.showForm.mock.calls[1][1]).toMatchObject({ data: { name: "Deluge" } });
  });

  it("stores nothing when the user stops at either step or picks nothing known", async () => {
    for (const answers of [[undefined], [{ type: "emule" }], [{ type: "deluge" }, undefined]]) {
      const { dm, host } = make();
      expect(await add(dm)(context(...answers))).toEqual({ refresh: false });
      expect(host.written).toEqual([]);
    }
  });

  it("refuses a second entry for the same program, whatever the dialog let through", async () => {
    const { dm, host } = make([qbRow]);
    const ctx = context({ type: "qbittorrent" }, { name: "Other", host: "H1", port: "8080", login: "user" });
    expect(await add(dm)(ctx)).toEqual({ refresh: false });
    expect(ctx.showMessage).toHaveBeenCalledWith({ key: "dmDuplicate", args: ["NAS", "http://h1:8080"] });
    expect(host.written).toEqual([]);
  });

  it("allows the same address once the other row is switched off, and a switched-off twin", async () => {
    const off = make([{ ...qbRow, enabled: false }]);
    await add(off.dm)(context({ type: "qbittorrent" }, { name: "Other", host: "h1" }));
    expect(off.host.written).toHaveLength(1);
    const twinOff = make([qbRow]);
    await add(twinOff.dm)(context({ type: "qbittorrent" }, { name: "Other", host: "h1", enabled: false }));
    expect(twinOff.host.written).toHaveLength(1);
  });

  it("hands the dialog the addresses and IDs of the other programs, so it refuses them itself", async () => {
    const { dm } = make([qbRow]);
    const ctx = context({ type: "qbittorrent" }, undefined);
    await add(dm)(ctx);
    const items = (ctx.showForm.mock.calls[1][0] as { items: Record<string, { validator?: string }> }).items;
    // the admin runs a validator as a function of the dialog data
    const run = (expr: string | undefined, data: object): unknown => new Function("data", `return (${expr});`)(data);
    expect(run(items.host.validator, { host: "h1" })).toBe(false);
    expect(run(items.host.validator, { host: "h1", port: "9000" })).toBe(true);
    expect(run(items.key.validator, { key: "nas" })).toBe(false);
  });

  it("refuses a typed ID that is taken", async () => {
    const { dm, host } = make([qbRow]);
    const ctx = context({ type: "qbittorrent" }, { name: "X", host: "h5", key: "nas" });
    await add(dm)(ctx);
    expect(ctx.showMessage).toHaveBeenCalledWith({ key: "dmIdTaken", args: ["qbittorrent-nas"] });
    expect(host.written).toEqual([]);
  });

  it("gives a second program of a kind its own ID", async () => {
    const { dm, host } = make([{ ...qbRow, key: "", name: "qBittorrent" }]);
    await add(dm)(context({ type: "qbittorrent" }, { name: "qBittorrent", host: "h5" }));
    expect(host.written[0][1]).toMatchObject({ key: "2" });
  });
});

describe("adding a JDownloader over My.JDownloader", () => {
  const cloudForm = { name: "JD Freund", mode: "cloud", username: "me@x.de", password: "pw" };

  it("logs in, offers the instances no row asks yet and stores the chosen one", async () => {
    const { dm, host, devices } = make([cloudRow]);
    const ctx = context({ type: "jdownloader" }, cloudForm, { device: "Keller-NAS" });
    expect(await add(dm)(ctx)).toEqual({ refresh: true });
    expect(devices).toHaveBeenCalledWith("me@x.de", "pw");
    expect(ctx.progressClosed()).toBe(1);
    const pick = ctx.showForm.mock.calls[2];
    expect((pick[0] as { items: { device: { options: { value: string }[] } } }).items.device.options).toEqual([
      { value: "Keller-NAS", label: "Keller-NAS" },
    ]);
    expect(pick[1]).toMatchObject({ data: { device: "Keller-NAS" }, applyDisabledRule: "!data.device" });
    expect(host.written[0][1]).toMatchObject({
      type: "jdownloader-cloud",
      key: "jd-freund",
      username: "me@x.de",
      device: "Keller-NAS",
      host: "",
    });
  });

  it("says why when the login fails, and stores nothing", async () => {
    const { dm, host, devices } = make();
    devices.mockRejectedValueOnce(new Error("AUTH_FAILED"));
    const ctx = context({ type: "jdownloader" }, cloudForm);
    expect(await add(dm)(ctx)).toEqual({ refresh: false });
    expect(ctx.showMessage).toHaveBeenCalledWith({ key: "dmLoginFailed", args: ["AUTH_FAILED"] });
    expect(ctx.progressClosed()).toBe(1);
    expect(host.written).toEqual([]);
  });

  it("says so when every instance of the account is set up already", async () => {
    const { dm, devices } = make([cloudRow]);
    devices.mockResolvedValueOnce(["Tom-PC"]);
    const ctx = context({ type: "jdownloader" }, { ...cloudForm, username: "ME@X.DE" });
    await add(dm)(ctx);
    expect(ctx.showMessage).toHaveBeenCalledWith("dmNoDevices");
  });

  it("stores nothing when the user leaves the instance list or answers with one it did not offer", async () => {
    for (const answer of [undefined, { device: "Tom-PC" }, { device: "Ghost-PC" }, { device: 3 }]) {
      const { dm, host } = make([cloudRow]);
      await add(dm)(context({ type: "jdownloader" }, cloudForm, answer));
      expect(host.written).toEqual([]);
    }
  });
});

describe("editing a program", () => {
  it("opens the stored values and keeps the ID", async () => {
    const { dm, host } = make([qbRow]);
    const [qb] = await cards(dm);
    const ctx = context({
      ...{ name: "NAS 2", host: "h1", username: "admin", password: "pw", login: "user" },
      key: "other",
    });
    expect(await action(qb, "edit").handler("qbittorrent-nas", ctx)).toEqual({ refresh: "devices" });
    expect(ctx.showForm.mock.calls[0][1]).toMatchObject({
      title: { key: "dmEditTitle", args: ["NAS"] },
      data: { name: "NAS", host: "h1", username: "admin", password: "pw", login: "user" },
    });
    expect(host.written[0][0]).toMatchObject({ key: "nas", name: "NAS 2", username: "admin", password: "pw" });
  });

  it("keeps the ID when a JDownloader switches to My.JDownloader — the next start carries its rooms", async () => {
    const { dm, host } = make([jdRow]);
    const [jd] = await cards(dm);
    const ctx = context(
      { name: "JD Keller", mode: "cloud", username: "me@x.de", password: "pw" },
      { device: "Tom-PC" },
    );
    await action(jd, "edit").handler("jdownloader-keller", ctx);
    expect(host.written[0][0]).toMatchObject({ type: "jdownloader-cloud", key: "keller", device: "Tom-PC", host: "" });
  });

  it("changes nothing when the user cancels, and reloads for a card that is gone", async () => {
    const { dm, host } = make([qbRow]);
    const [qb] = await cards(dm);
    expect(await action(qb, "edit").handler("qbittorrent-nas", context(undefined))).toEqual({ refresh: "none" });
    expect(await action(qb, "edit").handler("qbittorrent-gone", context())).toEqual({ refresh: "devices" });
    expect(host.written).toEqual([]);
  });

  it("does not count the edited row as its own duplicate", async () => {
    const { dm, host } = make([qbRow]);
    const [qb] = await cards(dm);
    await action(qb, "edit").handler("qbittorrent-nas", context({ name: "NAS", host: "h1" }));
    expect(host.written).toHaveLength(1);
  });
});

describe("deleting and testing", () => {
  it("answers first and stores the rows without the program right after", async () => {
    const { dm, host, timers } = make([qbRow, jdRow]);
    const [qb] = await cards(dm);
    expect(await action(qb, "delete").handler("qbittorrent-nas", context())).toEqual({ delete: "qbittorrent-nas" });
    expect(host.written).toEqual([]);
    timers.forEach(t => t());
    await new Promise(resolve => setImmediate(resolve));
    expect(host.written).toEqual([[jdRow]]);
  });

  it("writes nothing for a card whose row is gone already", async () => {
    const { dm, timers } = make([qbRow]);
    const [qb] = await cards(dm);
    await action(qb, "delete").handler("qbittorrent-gone", context());
    expect(timers).toEqual([]);
  });

  it("shows a delete whose settings cannot be read as a message", async () => {
    const { dm, host } = make([qbRow]);
    const [qb] = await cards(dm);
    host.readRows = () => Promise.reject(new Error("db down"));
    const ctx = context();
    expect(await action(qb, "delete").handler("qbittorrent-nas", ctx)).toEqual({ refresh: "devices" });
    expect(ctx.showMessage).toHaveBeenCalledWith({ key: "dmActionFailed", args: ["db down"] });
  });

  it("logs a delete the settings did not take", async () => {
    const { dm, host, timers, errors } = make([qbRow]);
    host.writeRows = () => Promise.reject(new Error("db down"));
    const [qb] = await cards(dm);
    await action(qb, "delete").handler("qbittorrent-nas", context());
    timers.forEach(t => t());
    await new Promise(resolve => setImmediate(resolve));
    expect(errors[0]).toMatch(/could not delete the program qbittorrent-nas.*db down/);
  });

  it("tests the stored row and says what the program answered", async () => {
    const { dm, tested } = make([qbRow]);
    const [qb] = await cards(dm);
    const ctx = context();
    expect(await action(qb, "test").handler("qbittorrent-nas", ctx)).toEqual({ refresh: "none" });
    expect(tested).toHaveBeenCalledWith(qbRow);
    expect(ctx.progressClosed()).toBe(1);
    expect(ctx.showMessage).toHaveBeenCalledWith({ key: "dmTestOkDownloads", args: ["NAS", "4.6", 2] });
  });

  it("shows a failing action as a message instead of leaving the dialog waiting", async () => {
    const { dm, tested, errors } = make([qbRow]);
    tested.mockRejectedValueOnce(new Error("boom"));
    const [qb] = await cards(dm);
    const ctx = context();
    expect(await action(qb, "test").handler("qbittorrent-nas", ctx)).toEqual({ refresh: "none" });
    expect(ctx.progressClosed()).toBe(1);
    expect(ctx.showMessage).toHaveBeenCalledWith({ key: "dmActionFailed", args: ["boom"] });
    expect(errors[0]).toMatch(/boom/);
  });
});

describe("testText", () => {
  it("words every kind of answer", () => {
    expect(testText("A", { ok: true, version: "1" })).toEqual({ key: "dmTestOk", args: ["A", "1"] });
    expect(testText("A", { ok: true, version: "1", downloads: 0 })).toEqual({
      key: "dmTestOkDownloads",
      args: ["A", "1", 0],
    });
    expect(testText("A", { ok: false, kind: "auth", text: "401" })).toEqual({ key: "dmTestAuth", args: ["A", "401"] });
    expect(testText("A", { ok: false, kind: "unreachable", text: "x" })).toEqual({
      key: "dmTestUnreachable",
      args: ["A", "x"],
    });
    expect(testText("A", { ok: false, kind: "setup", text: "host missing" })).toEqual({
      key: "dmTestOther",
      args: ["A", "host missing"],
    });
  });
});
