import type { Mock } from "vitest";

vi.mock("./i18n", () => ({
  tName: (key: string, ...args: unknown[]) => (args.length ? { key, args } : key),
  tText: (key: string) => `plain:${key}`,
}));

import type { TestResult } from "./core/connection-test";
import { DlDeviceManagement, testText, type DmHost } from "./device-management";
import { applyRuleOf } from "./dm-forms";

const NS = "dl-manager.0";

/** Answers a browser sends although the dialog's rule would hold OK back — the handler has to check again. */
const UNCHECKED = new WeakSet<object>();
const unchecked = <T extends object>(answer: T): T => (UNCHECKED.add(answer), answer);

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
    // an answer given as a function runs when the user answers — what other writers did meanwhile goes in there; the
    // dialog's applyDisabledRule runs on the data as the device manager does: while it holds, OK cannot be pressed
    showForm: vi.fn((_schema: unknown, opts?: { data?: Record<string, unknown>; applyDisabledRule?: string }) => {
      const given = forms.shift();
      const answer = typeof given === "function" ? (given as () => unknown)() : given;
      if (answer && typeof answer === "object" && !UNCHECKED.has(answer) && opts?.applyDisabledRule) {
        const data = { ...opts.data, ...(answer as Record<string, unknown>) };
        if (new Function("data", `return ${opts.applyDisabledRule}`)(data)) {
          return Promise.resolve(undefined);
        }
      }
      return Promise.resolve(answer);
    }),
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
  controls?: unknown;
  hasDetails?: boolean;
  actions: { id: string; confirmation?: unknown; handler: (id: string, ctx?: Ctx) => Promise<unknown> }[];
}
interface Internals {
  loadDevices(ctx: { addDevice: (c: unknown) => void }): Promise<void>;
  getDeviceDetails(id: string): Promise<{ id: string; schema: { items: Record<string, { text: unknown }> } }>;
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
  host: DmHost & {
    written: Record<string, unknown>[][];
    rows: () => Record<string, unknown>[];
    replace: (rows: Record<string, unknown>[]) => void;
  };
  timers: (() => void)[];
  errors: string[];
  devices: Mock;
  tested: Mock;
} {
  let stored = structuredClone(rows);
  const timers: (() => void)[] = [];
  const errors: string[] = [];
  const devices = vi.fn((): Promise<{ id: string; name: string }[]> =>
    Promise.resolve([
      { id: "aaaa1111", name: "Keller-NAS" },
      { id: "bbbb2222", name: "Tom-PC" },
    ]),
  );
  const tested = vi.fn((): Promise<TestResult> => Promise.resolve({ ok: true, version: "4.6", downloads: 2 }));
  const host = {
    written: [] as Record<string, unknown>[][],
    rows: () => structuredClone(stored),
    // another writer (a second admin tab, a learned My.JDownloader id) changes the store
    replace: (next: Record<string, unknown>[]) => {
      stored = structuredClone(next);
    },
    readRows: () => Promise.resolve(structuredClone(stored)),
    updateRows: (change: (rows: Record<string, unknown>[]) => Record<string, unknown>[] | undefined) => {
      const next = change(structuredClone(stored));
      if (next) {
        host.written.push(structuredClone(next));
        stored = structuredClone(next);
      }
      return Promise.resolve();
    },
    hasObject: (relId: string) => Promise.resolve(objects.includes(relId)),
    readState: (relId: string) => Promise.resolve(values[relId]),
    test: tested,
    listJdDevices: devices,
    icon: (type: string) => `icon:${type}`,
    iobHost: () => "iobhost",
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
  id: "qbittorrent-nas",
  enabled: true,
  type: "qbittorrent",
  name: "NAS",
  host: "h1",
  username: "admin",
  password: "pw",
};
const jdRow = { id: "jdownloader-keller", enabled: true, type: "jdownloader", name: "JD Keller", host: "h2" };
const cloudRow = {
  id: "jdownloader-2222",
  enabled: true,
  type: "jdownloader-cloud",
  name: "JD Tom",
  username: "me@x.de",
  password: "pw",
  device: "Tom-PC",
  deviceId: "bbbb2222",
};

describe("cards", () => {
  it("shows one card per row with address, program and live states", async () => {
    const { dm } = make([qbRow, jdRow, cloudRow, { ...qbRow, id: "qbittorrent-off", host: "h9", enabled: false }]);
    const out = await cards(dm);
    expect(out.map(c => [c.id, c.name, c.identifier, c.manufacturer, c.enabled])).toEqual([
      ["qbittorrent-nas", "NAS", "http://h1:8080", "qBittorrent", true],
      ["jdownloader-keller", "JD Keller", "http://h2:3128", { key: "dmLocal", args: ["JDownloader 2"] }, true],
      ["jdownloader-2222", "JD Tom", "me@x.de/Tom-PC", { key: "dmCloud", args: ["JDownloader 2"] }, true],
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
    const { dm } = make([qbRow, jdRow, cloudRow, { ...qbRow, id: "qbittorrent-off", host: "h9", enabled: false }], [], {
      "qbittorrent-nas.error": "login rejected (401)",
      "jdownloader-keller.error": "Unknown",
      "jdownloader-2222.error": "",
      "qbittorrent-off.error": "not reachable",
    });
    expect((await cards(dm)).map(c => c.status.warning)).toEqual([
      "login rejected (401)",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("warns with what is wrong with the card — its datapoint only says Unknown", async () => {
    const { dm } = make(
      [
        { ...qbRow, host: "" },
        { ...jdRow, host: "", enabled: false },
      ],
      [],
      {
        "qbittorrent-nas.error": "Unknown",
        "jdownloader-keller.error": "Unknown",
      },
    );
    const [broken, off] = await cards(dm);
    expect(broken.status.warning).toBe("host missing");
    expect(off.status.warning).toBeUndefined();
  });

  it("switches a program on and off from its card", async () => {
    const { dm, host } = make([qbRow, jdRow]);
    const [qb] = await cards(dm);
    expect(await action(qb, "enable/disable").handler("qbittorrent-nas", context())).toEqual({ refresh: "devices" });
    expect(host.written[0].map(r => r.enabled)).toEqual([false, true]);
    await action(qb, "enable/disable").handler("qbittorrent-nas", context());
    expect(host.written[1].map(r => r.enabled)).toEqual([true, true]);
    const gone = context();
    await action(qb, "enable/disable").handler("qbittorrent-gone", gone);
    expect(host.written).toHaveLength(2);
    expect(gone.showMessage).not.toHaveBeenCalled();
  });

  it("shows pause and free space only where the program has them — as states, never as a control", async () => {
    const { dm } = make([qbRow, jdRow], ["qbittorrent-nas.paused", "qbittorrent-nas.freeSpace"]);
    const [qb, jd] = await cards(dm);
    expect(qb.indicators.map(i => i.id)).toEqual(["downloading", "active", "paused", "freeSpace"]);
    expect(jd.indicators.map(i => i.id)).toEqual(["downloading", "active"]);
    expect(qb.controls).toBeUndefined();
    expect(jd.controls).toBeUndefined();
  });

  it("shows the object ID in the card's details, and the My.JDownloader instance", async () => {
    const { dm } = make([qbRow, cloudRow]);
    expect((await cards(dm)).map(c => c.hasDetails)).toEqual([true, true]);
    const qb = await dm.getDeviceDetails("qbittorrent-nas");
    expect(Object.values(qb.schema.items).map(i => i.text)).toEqual([
      { key: "dmDetailsId", args: [`${NS}.qbittorrent-nas`] },
    ]);
    const cloud = await dm.getDeviceDetails("jdownloader-2222");
    expect(Object.values(cloud.schema.items).map(i => i.text)).toEqual([
      { key: "dmDetailsId", args: [`${NS}.jdownloader-2222`] },
      { key: "dmDetailsDevice", args: ["Tom-PC"] },
    ]);
  });

  it("answers the details of a card whose settings cannot be read with its object ID, and logs why", async () => {
    const { dm, host, errors } = make([cloudRow]);
    host.readRows = () => Promise.reject(new Error("db down"));
    const details = await dm.getDeviceDetails("jdownloader-2222");
    expect(Object.values(details.schema.items).map(i => i.text)).toEqual([
      { key: "dmDetailsId", args: [`${NS}.jdownloader-2222`] },
    ]);
    expect(errors.join("\n")).toMatch(/db down/);
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
  it("chooses the program, then stores only its fields with an ID from the machine it runs on", async () => {
    const { dm, host } = make([qbRow]);
    const ctx = context(
      { type: "deluge" },
      { name: "Deluge", host: "10.0.0.5", port: "", password: "pw", enabled: true },
    );
    expect(await add(dm)(ctx)).toEqual({ refresh: true });
    expect(host.written).toHaveLength(1);
    expect(host.written[0][1]).toMatchObject({
      id: "deluge-10-0-0-5",
      type: "deluge",
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
    const ctx = context({ type: "qbittorrent" }, unchecked({ name: "Other", host: "H1", port: "8080", login: "user" }));
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

  it("hands the dialog the addresses of the other programs, so it refuses them itself", async () => {
    const { dm } = make([qbRow]);
    const ctx = context({ type: "qbittorrent" }, undefined);
    await add(dm)(ctx);
    const items = (ctx.showForm.mock.calls[1][0] as { items: Record<string, { validator?: string }> }).items;
    // the admin runs a validator as a function of the dialog data
    const run = (expr: string | undefined, data: object): unknown => new Function("data", `return (${expr});`)(data);
    expect(run(items.host.validator, { host: "h1" })).toBe(false);
    expect(run(items.host.validator, { host: "h1", port: "9000" })).toBe(true);
    expect(run(items.host.validator, { host: "h1", enabled: false })).toBe(true);
    expect(items.key).toBeUndefined();
  });

  it("hands the dialog no address of a switched-off program", async () => {
    const { dm } = make([{ ...qbRow, enabled: false }]);
    const ctx = context({ type: "qbittorrent" }, undefined);
    await add(dm)(ctx);
    const items = (ctx.showForm.mock.calls[1][0] as { items: Record<string, { validator?: string }> }).items;
    expect(new Function("data", `return (${items.host.validator});`)({ host: "h1" })).toBe(true);
  });

  it("gives a second program on the same machine the port, then a counter — never an id another row holds", async () => {
    const { dm, host } = make([{ ...qbRow, id: "qbittorrent-h5", host: "h5" }]);
    await add(dm)(context({ type: "qbittorrent" }, { name: "qBittorrent", host: "h5", port: "9000" }));
    expect(host.written[0][1]).toMatchObject({ id: "qbittorrent-h5-9000", name: "qBittorrent" });
    const busy = make([
      { ...qbRow, id: "qbittorrent-h5", host: "h5" },
      { ...qbRow, id: "qbittorrent-h5-9000", host: "h6" },
    ]);
    await add(busy.dm)(context({ type: "qbittorrent" }, { name: "Q", host: "h5.lan", port: "9000" }));
    expect(busy.host.written[0][2]).toMatchObject({ id: "qbittorrent-h5-9000-2" });
  });

  it("names a program on the ioBroker machine after the ioBroker host", async () => {
    const { dm, host } = make();
    await add(dm)(context({ type: "aria2" }, { name: "aria2", host: "localhost" }));
    expect(host.written[0][0]).toMatchObject({ id: "aria2-iobhost" });
  });
});

describe("adding a JDownloader over My.JDownloader", () => {
  const cloudForm = { name: "JD Freund", mode: "cloud", username: "me@x.de", password: "pw" };

  it("logs in, offers the instances no row asks yet and stores the chosen one", async () => {
    const { dm, host, devices } = make([cloudRow]);
    const ctx = context({ type: "jdownloader" }, cloudForm, { device: "aaaa1111" });
    expect(await add(dm)(ctx)).toEqual({ refresh: true });
    expect(devices).toHaveBeenCalledWith("me@x.de", "pw");
    expect(ctx.progressClosed()).toBe(1);
    const pick = ctx.showForm.mock.calls[2];
    expect((pick[0] as { items: { device: { options: { value: string }[] } } }).items.device.options).toEqual([
      { value: "aaaa1111", label: "Keller-NAS" },
    ]);
    expect(pick[1]).toMatchObject({ data: { device: "aaaa1111" }, applyDisabledRule: "!data.device" });
    expect(host.written[0][1]).toMatchObject({
      id: "jdownloader-1111",
      type: "jdownloader-cloud",
      username: "me@x.de",
      device: "Keller-NAS",
      deviceId: "aaaa1111",
      host: "",
    });
  });

  it("counts an instance a row from before 0.3.0 asks by its name as taken", async () => {
    const { dm, host } = make([{ ...cloudRow, deviceId: undefined, id: "jdownloader-cloud", idPending: true }]);
    await add(dm)(context({ type: "jdownloader" }, cloudForm, { device: "bbbb2222" }));
    expect(host.written).toEqual([]);
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
    devices.mockResolvedValueOnce([{ id: "bbbb2222", name: "Tom-PC" }]);
    const ctx = context({ type: "jdownloader" }, { ...cloudForm, username: "ME@X.DE" });
    await add(dm)(ctx);
    expect(ctx.showMessage).toHaveBeenCalledWith("dmNoDevices");
  });

  it("offers the instance of a switched-off My.JDownloader entry", async () => {
    const { dm, host } = make([{ ...cloudRow, enabled: false }]);
    await add(dm)(context({ type: "jdownloader" }, cloudForm, { device: "bbbb2222" }));
    expect(host.written).toHaveLength(1);
  });

  it("never takes an instance another row asks, even when that row still carries an older name of it", async () => {
    const { dm, host } = make([{ ...cloudRow, device: "Old-Name" }]);
    await add(dm)(context({ type: "jdownloader" }, cloudForm, { device: "bbbb2222" }));
    expect(host.written).toEqual([]);
  });

  it("stores nothing when the user leaves the instance list or answers with one it did not offer", async () => {
    for (const answer of [undefined, { device: "bbbb2222" }, { device: "Ghost-PC" }, { device: 3 }]) {
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
    const ctx = context({ name: "NAS 2", host: "h9", username: "admin", password: "pw", login: "user", key: "other" });
    expect(await action(qb, "edit").handler("qbittorrent-nas", ctx)).toEqual({ refresh: "devices" });
    expect(ctx.showForm.mock.calls[0][1]).toMatchObject({
      title: { key: "dmEditTitle", args: ["NAS"] },
      data: { name: "NAS", host: "h1", username: "admin", password: "pw", login: "user" },
    });
    expect(host.written[0][0]).toMatchObject({ id: "qbittorrent-nas", name: "NAS 2", host: "h9", password: "pw" });
    expect(host.written[0][0]).not.toHaveProperty("key");
  });

  it("keeps the ID when a JDownloader switches to My.JDownloader — the device stays where it is", async () => {
    const { dm, host } = make([jdRow]);
    const [jd] = await cards(dm);
    const ctx = context(
      { name: "JD Keller", mode: "cloud", username: "me@x.de", password: "pw" },
      { device: "bbbb2222" },
    );
    await action(jd, "edit").handler("jdownloader-keller", ctx);
    expect(host.written[0][0]).toMatchObject({
      id: "jdownloader-keller",
      type: "jdownloader-cloud",
      device: "Tom-PC",
      deviceId: "bbbb2222",
      host: "",
    });
  });

  it("changes nothing when the user cancels, and reloads for a card that is gone", async () => {
    const { dm, host } = make([qbRow]);
    const [qb] = await cards(dm);
    expect(await action(qb, "edit").handler("qbittorrent-nas", context(undefined))).toEqual({ refresh: "none" });
    expect(await action(qb, "edit").handler("qbittorrent-gone", context())).toEqual({ refresh: "devices" });
    expect(host.written).toEqual([]);
  });

  it("keeps a card another tab deleted while this dialog was open", async () => {
    const { dm, host } = make([qbRow, jdRow]);
    const [qb] = await cards(dm);
    const ctx = context(() => {
      host.replace([qbRow]);
      return { name: "NAS 2", host: "h1", username: "admin", password: "pw", login: "user" };
    });
    await action(qb, "edit").handler("qbittorrent-nas", ctx);
    expect(host.rows().map(r => r.id)).toEqual(["qbittorrent-nas"]);
    expect(host.rows()[0]).toMatchObject({ name: "NAS 2" });
  });

  it("writes nothing back over a row whose id changed while its dialog was open", async () => {
    const pending = { ...cloudRow, id: "jdownloader-tom", idPending: true, deviceId: "" };
    const { dm, host } = make([pending]);
    const [card] = await cards(dm);
    const ctx = context(
      () => {
        host.replace([cloudRow]);
        return { name: "JD Tom 2", mode: "cloud", username: "me@x.de", password: "pw" };
      },
      { device: "bbbb2222" },
    );
    expect(await action(card, "edit").handler("jdownloader-tom", ctx)).toEqual({ refresh: "devices" });
    expect(host.rows()).toEqual([cloudRow]);
    expect(ctx.showMessage).toHaveBeenCalledWith("dmChanged");
  });

  it("does not count the edited row as its own duplicate", async () => {
    const { dm, host } = make([qbRow]);
    const [qb] = await cards(dm);
    await action(qb, "edit").handler("qbittorrent-nas", context({ name: "NAS", host: "h1" }));
    expect(host.written).toHaveLength(1);
  });
});

describe("deleting and testing", () => {
  it("stores the rows without the program, then answers — nothing restarts", async () => {
    const { dm, host, timers } = make([qbRow, jdRow]);
    const [qb] = await cards(dm);
    expect(await action(qb, "delete").handler("qbittorrent-nas", context())).toEqual({ delete: "qbittorrent-nas" });
    expect(host.written).toEqual([[jdRow]]);
    expect(timers).toEqual([]);
  });

  it("writes nothing for a card whose row is gone already", async () => {
    const { dm, host } = make([qbRow]);
    const [qb] = await cards(dm);
    await action(qb, "delete").handler("qbittorrent-gone", context());
    expect(host.written).toEqual([]);
  });

  it("shows a delete the store could not read or take as a message", async () => {
    const { dm, host, errors } = make([qbRow]);
    host.updateRows = () => Promise.reject(new Error("db down"));
    const [qb] = await cards(dm);
    const ctx = context();
    expect(await action(qb, "delete").handler("qbittorrent-nas", ctx)).toEqual({ refresh: "devices" });
    expect(ctx.showMessage).toHaveBeenCalledWith({ key: "dmActionFailed", args: ["db down"] });
    expect(errors[0]).toMatch(/db down/);
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
