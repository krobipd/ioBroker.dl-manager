vi.mock("./i18n", () => ({
  tName: (key: string, ...args: unknown[]) => (args.length ? { key, args } : { key }),
  tText: (key: string) => `plain:${key}`,
}));

import { programKey } from "./core/config";
import {
  applyRuleOf,
  dialogType,
  emptyForm,
  formFromData,
  formToRow,
  OFFERED,
  pickJdDeviceForm,
  pickProgramForm,
  programForm,
  programKeyExpression,
  rowToForm,
  storedType,
  type DialogType,
  type ProgramForm,
} from "./dm-forms";
import { catalogEntry, type ProgramType } from "./programs/catalog";

interface Item {
  type: string;
  hidden?: string;
  validator?: string;
  disabled?: string;
  options?: { value: string; label: unknown; icon?: string }[];
  placeholder?: string;
  label?: unknown;
  text?: unknown;
}
const itemsOf = (schema: unknown): Record<string, Item> => (schema as { items: Record<string, Item> }).items;
/**
 * Runs a field expression (`hidden`, `validator`, `disabled`) the way json-config does: an expression that contains
 * `return` is taken as a function body, any other gets `return ` in front (admin 8.0.x `ConfigGeneric.execute`).
 *
 * @param expr the expression
 * @param data the dialog data
 * @returns what the expression returns
 */
const run = (expr: string | undefined, data: Record<string, unknown>): unknown => {
  const body = expr ?? "false";
  return new Function("data", body.includes("return") ? body : `return ${body}`)(data);
};
/**
 * Runs a dialog's `applyDisabledRule` the way the device manager does (`Function('data', 'return ' + rule)`).
 *
 * @param rule the rule
 * @param data the dialog data
 * @returns true while OK is off
 */
const runRule = (rule: string, data: Record<string, unknown>): unknown => new Function("data", `return ${rule}`)(data);
const form = (over: Partial<ProgramForm> = {}): ProgramForm => ({ ...emptyForm("qbittorrent"), ...over });
const ctx = { takenKeys: [] as string[] };

describe("rows and dialog data", () => {
  it("offers every program but My.JDownloader, which is a switch of the JDownloader dialog", () => {
    expect(OFFERED.map(p => p.type)).not.toContain("jdownloader-cloud");
    expect(OFFERED).toHaveLength(8);
  });

  it("maps a stored row to the dialog it is edited in", () => {
    expect(dialogType({ type: "jdownloader-cloud" })).toBe("jdownloader");
    expect(dialogType({ type: "deluge" })).toBe("deluge");
    expect(dialogType({ type: "emule" })).toBeUndefined();
    expect(storedType("jdownloader", { mode: "cloud" })).toBe("jdownloader-cloud");
    expect(storedType("jdownloader", { mode: "local" })).toBe("jdownloader");
    expect(storedType("deluge", { mode: "cloud" })).toBe("deluge");
  });

  it("opens pyLoad on the API key and qBittorrent on user and password", () => {
    expect(emptyForm("pyload").login).toBe("key");
    expect(emptyForm("qbittorrent").login).toBe("user");
    expect(emptyForm("deluge")).toMatchObject({ enabled: true, advanced: false, mode: "local" });
  });

  it("reads a stored row into the dialog: login, advanced part, switch-off", () => {
    expect(
      rowToForm({
        type: "qbittorrent",
        host: "nas",
        port: 8081,
        https: true,
        path: "/qb",
        apiKey: "k",
        enabled: false,
      }),
    ).toMatchObject({
      host: "nas",
      port: "8081",
      login: "key",
      advanced: true,
      https: true,
      path: "/qb",
      enabled: false,
    });
    expect(rowToForm({ type: "qbittorrent", username: "admin", apiKey: "k" }).login).toBe("key"); // the client takes the key first
    expect(rowToForm({ type: "pyload", username: "admin" }).login).toBe("user");
    expect(rowToForm({ type: "pyload" }).login).toBe("key");
    expect(rowToForm({ type: "transmission", username: "u" })).toMatchObject({ needLogin: true, advanced: false });
    expect(rowToForm({ type: "jdownloader-cloud", username: "me@x" })).toMatchObject({ mode: "cloud", port: "" });
    expect(rowToForm({ port: "9" }).port).toBe(""); // like parsePrograms: a port is a number
    expect(rowToForm({})).toMatchObject({ name: "", enabled: true });
    expect(rowToForm({ key: "old" })).not.toHaveProperty("key");
  });

  it("takes what the dialog answered and keeps the opened value for a missing or foreign-typed field", () => {
    const opened = form({ name: "A", https: true, login: "key" });
    expect(formFromData({ name: "B", port: 8080, https: "yes", login: "nonsense", mode: "cloud" }, opened)).toEqual({
      ...opened,
      name: "B",
      port: "8080",
      mode: "cloud",
    });
    expect(formFromData({ mode: "x", needLogin: true }, opened)).toMatchObject({ mode: "local", needLogin: true });
  });
});

describe("formToRow", () => {
  const net = { host: " nas ", port: "8081", https: true, path: " /x ", advanced: true };

  it("keeps what the dialog does not show, and the switch-off", () => {
    const row = formToRow("deluge", form({ ...net, password: "pw", enabled: false }), "deluge-nas", {
      extra: 1,
      type: "deluge",
    });
    expect(row).toEqual({
      extra: 1,
      id: "deluge-nas",
      enabled: false,
      type: "deluge",
      name: "",
      host: "nas",
      port: 8081,
      https: true,
      path: "/x",
      username: "",
      password: "pw",
      apiKey: "",
      device: "",
      deviceId: "",
    });
  });

  it("stores a port only when it is one", () => {
    expect(formToRow("deluge", form({ port: "0" }), "").port).toBe(0);
    expect(formToRow("deluge", form({ port: "70000" }), "").port).toBe(0);
    expect(formToRow("deluge", form({ port: "abc" }), "").port).toBe(0);
    expect(formToRow("deluge", form({ port: "" }), "").port).toBe(0);
  });

  it("empties every credential the chosen login does not use", () => {
    const all = form({ username: "u", password: "p", apiKey: "k" });
    const creds = (type: ProgramType, f: ProgramForm): unknown[] => {
      const r = formToRow(type, f, "");
      return [r.username, r.password, r.apiKey];
    };
    expect(creds("jdownloader", all)).toEqual(["", "", ""]);
    expect(creds("deluge", all)).toEqual(["", "p", ""]);
    expect(creds("sabnzbd", all)).toEqual(["", "", "k"]);
    expect(creds("aria2", all)).toEqual(["", "", "k"]);
    expect(creds("nzbget", all)).toEqual(["u", "p", ""]);
    expect(creds("transmission", all)).toEqual(["", "", ""]);
    expect(creds("transmission", { ...all, needLogin: true })).toEqual(["u", "p", ""]);
    expect(creds("qbittorrent", { ...all, login: "user" })).toEqual(["u", "p", ""]);
    expect(creds("qbittorrent", { ...all, login: "key" })).toEqual(["", "", "k"]);
    expect(creds("pyload", { ...all, login: "key" })).toEqual(["", "", "k"]);
  });

  it("stores My.JDownloader as its own type, with account and instance and no address", () => {
    const row = formToRow(
      "jdownloader",
      form({ ...net, mode: "cloud", username: " me@x ", password: "p" }),
      "jdownloader-9f3a",
      {},
      { id: "abc9f3a", name: "PC" },
    );
    expect(row).toMatchObject({
      type: "jdownloader-cloud",
      host: "",
      port: 0,
      https: false,
      path: "",
      username: "me@x",
      password: "p",
      device: "PC",
      deviceId: "abc9f3a",
    });
    expect(
      formToRow("jdownloader", form({ ...net, mode: "local" }), "jdownloader-9f3a", {
        device: "PC",
        deviceId: "abc9f3a",
      }),
    ).toMatchObject({
      id: "jdownloader-9f3a",
      type: "jdownloader",
      host: "nas",
      device: "",
      deviceId: "",
    });
  });
});

describe("programKeyExpression — the dialog's copy of programKey", () => {
  const cases: [ProgramType, Record<string, unknown>][] = [
    ["qbittorrent", { host: "NAS", port: "", path: "" }],
    ["qbittorrent", { host: " nas ", port: "8081", path: "qb/" }],
    ["transmission", { host: "nas", port: "", path: "" }],
    ["transmission", { host: "nas", port: "9092", path: "/rpc/" }],
    ["aria2", { host: "10.0.0.2", port: "0", path: " " }],
    ["deluge", { host: "nas", port: "abc", path: "//" }],
    ["jdownloader", { host: "Host.Local", port: "3129", path: "/JD" }],
  ];
  for (const [type, data] of cases) {
    it(`builds what programKey builds for ${type} ${JSON.stringify(data)}`, () => {
      const port = Number(data.port);
      const cfg = {
        type,
        host: String(data.host).trim(),
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
        https: false,
        path: String(data.path).trim(),
        username: "",
        device: "",
      };
      expect(run(programKeyExpression(catalogEntry(type)), data)).toBe(programKey(cfg));
    });
  }
});

describe("pickProgramForm", () => {
  it("offers the eight programs as a list with their pictograms", () => {
    const items = itemsOf(pickProgramForm(t => `icon:${t}`));
    expect(items.type.type).toBe("select");
    expect(items.type.options?.map(o => o.value)).toEqual(OFFERED.map(p => p.type));
    expect(items.type.options?.[0]).toEqual({ value: "jdownloader", label: "JDownloader 2", icon: "icon:jdownloader" });
  });

  it("lists the JDownloader instances of an account", () => {
    expect(
      itemsOf(
        pickJdDeviceForm([
          { id: "id-a", name: "A" },
          { id: "id-b", name: "B" },
        ]),
      ).device.options,
    ).toEqual([
      { value: "id-a", label: "A" },
      { value: "id-b", label: "B" },
    ]);
  });
});

describe("radio groups — the admin renders their labels as they are", () => {
  it("gives every radio option a plain string label, never a translation object", () => {
    const radios: Item[] = [];
    for (const p of OFFERED) {
      for (const item of Object.values(itemsOf(programForm(p.type, ctx)))) {
        if (item.type === "select") {
          radios.push(item);
        }
      }
    }
    radios.push(
      itemsOf(pickProgramForm(() => undefined)).type,
      itemsOf(pickJdDeviceForm([{ id: "i", name: "A" }])).device,
    );
    expect(radios.length).toBeGreaterThan(3);
    for (const r of radios) {
      for (const o of r.options ?? []) {
        expect(typeof o.label).toBe("string");
      }
    }
  });
});

describe("programForm — only the fields of the program", () => {
  const fields = (type: DialogType): string[] => Object.keys(itemsOf(programForm(type, ctx))).sort();
  const common = ["advanced", "enabled", "hint", "host", "https", "name", "path", "port", "taken"];

  it("gives every program exactly its login fields", () => {
    expect(fields("deluge")).toEqual([...common, "password"].sort());
    expect(fields("sabnzbd")).toEqual([...common, "apiKey"].sort());
    expect(fields("aria2")).toEqual([...common, "apiKey"].sort());
    expect(fields("nzbget")).toEqual([...common, "password", "username"].sort());
    expect(fields("transmission")).toEqual([...common, "needLogin", "password", "username"].sort());
    expect(fields("qbittorrent")).toEqual([...common, "apiKey", "login", "password", "username"].sort());
    expect(fields("pyload")).toEqual([...common, "apiKey", "login", "password", "username"].sort());
    expect(fields("jdownloader")).toEqual([...common, "hintCloud", "mode", "password", "username"].sort());
  });

  it("shows the default port and path as placeholders", () => {
    const items = itemsOf(programForm("transmission", ctx));
    expect(items.port.placeholder).toBe("9091");
    expect(items.path.placeholder).toBe("/transmission/rpc");
    expect(itemsOf(programForm("deluge", ctx)).path.placeholder).toBe("/");
  });

  it("switches the JDownloader dialog between the local address and the account", () => {
    const items = itemsOf(programForm("jdownloader", ctx));
    for (const [mode, localShown] of [
      ["local", true],
      ["cloud", false],
    ] as const) {
      const data = { mode, advanced: true };
      expect([mode, run(items.host.hidden, data)]).toEqual([mode, !localShown]);
      expect([mode, run(items.port.hidden, data)]).toEqual([mode, !localShown]);
      expect([mode, run(items.https.hidden, data)]).toEqual([mode, !localShown]);
      expect([mode, run(items.username.hidden, data)]).toEqual([mode, localShown]);
      expect([mode, run(items.password.hidden, data)]).toEqual([mode, localShown]);
      expect([mode, run(items.hint.hidden, data)]).toEqual([mode, !localShown]);
      expect([mode, run(items.hintCloud.hidden, data)]).toEqual([mode, localShown]);
    }
  });

  it("requires the address only for a local program and refuses one already set up", () => {
    const items = itemsOf(
      programForm("jdownloader", {
        ...ctx,
        takenKeys: [
          programKey({ type: "jdownloader", host: "nas", port: 0, https: false, path: "", username: "", device: "" }),
        ],
      }),
    );
    expect(run(items.host.validator, { mode: "local", host: "" })).toBe(false);
    expect(run(items.host.validator, { mode: "local", host: "http://nas" })).toBe(false);
    expect(run(items.host.validator, { mode: "local", host: "NAS" })).toBe(false);
    expect(run(items.host.validator, { mode: "local", host: "NAS", port: "3129" })).toBe(true);
    expect(run(items.host.validator, { mode: "cloud", host: "" })).toBe(true);
  });

  it("checks e-mail and password only for My.JDownloader", () => {
    const items = itemsOf(programForm("jdownloader", ctx));
    expect(run(items.username.validator, { mode: "cloud", username: "me@x" })).toBe(false);
    expect(run(items.username.validator, { mode: "cloud", username: "me@x.de" })).toBe(true);
    expect(run(items.username.validator, { mode: "local", username: "" })).toBe(true);
    expect(run(items.password.validator, { mode: "cloud", password: "" })).toBe(false);
    expect(run(items.password.validator, { mode: "local", password: "" })).toBe(true);
  });

  it("takes an empty port or a real one", () => {
    const items = itemsOf(programForm("deluge", ctx));
    expect(run(items.port.validator, { port: "" })).toBe(true);
    expect(run(items.port.validator, { port: "8112" })).toBe(true);
    for (const port of ["0", "65536", "80a", "-1"]) {
      expect([port, run(items.port.validator, { port })]).toEqual([port, false]);
    }
  });

  it("requires the credential a login needs, only while it is chosen", () => {
    const qb = itemsOf(programForm("qbittorrent", ctx));
    expect(run(qb.apiKey.validator, { login: "key", apiKey: "" })).toBe(false);
    expect(run(qb.apiKey.validator, { login: "user", apiKey: "" })).toBe(true);
    expect(run(qb.username.hidden, { login: "key" })).toBe(true);
    expect(run(qb.apiKey.hidden, { login: "user" })).toBe(true);
    const tr = itemsOf(programForm("transmission", ctx));
    expect(run(tr.username.validator, { needLogin: true, username: "" })).toBe(false);
    expect(run(tr.username.validator, { needLogin: false, username: "" })).toBe(true);
    expect(run(itemsOf(programForm("sabnzbd", ctx)).apiKey.validator, { apiKey: " " })).toBe(false);
    expect(run(itemsOf(programForm("deluge", ctx)).password.validator, { password: "" })).toBe(false);
    expect(itemsOf(programForm("aria2", ctx)).apiKey.validator).toBeUndefined();
  });

  it("has no ID field — the adapter gives the device id, the name is only a label", () => {
    for (const p of OFFERED) {
      expect(itemsOf(programForm(p.type, ctx))).not.toHaveProperty("key");
    }
    expect(itemsOf(programForm("deluge", ctx)).name).toMatchObject({ help: { key: "dmNameHelp" } });
  });

  it("requires a name", () => {
    const items = itemsOf(programForm("deluge", ctx));
    expect(run(items.name.validator, { name: " " })).toBe(false);
    expect(run(items.name.validator, { name: "NAS" })).toBe(true);
  });
});

describe("applyRuleOf — OK stays off until every field passes", () => {
  it("holds OK for a missing address and a missing password, and releases it once all is filled", () => {
    const schema = programForm("deluge", ctx);
    const rule = applyRuleOf(schema);
    expect(runRule(rule, { name: "Deluge", host: "", password: "pw", port: "" })).toBe(true);
    expect(runRule(rule, { name: "Deluge", host: "nas", password: "", port: "" })).toBe(true);
    expect(runRule(rule, { name: "Deluge", host: "nas", password: "pw", port: "" })).toBe(false);
  });

  it("does not hold OK for a field the dialog hides", () => {
    const rule = applyRuleOf(programForm("jdownloader", ctx));
    expect(runRule(rule, { name: "JD", mode: "cloud", host: "", username: "me@x.de", password: "pw" })).toBe(false);
    expect(runRule(rule, { name: "JD", mode: "local", host: "nas", username: "", password: "" })).toBe(false);
  });

  it("holds OK for an address another program uses, and shows why", () => {
    const takenKeys = [
      programKey({ type: "deluge", host: "nas", port: 0, https: false, path: "", username: "", device: "" }),
    ];
    const schema = programForm("deluge", { ...ctx, takenKeys });
    const data = { name: "Deluge", host: "nas", password: "pw" };
    expect(runRule(applyRuleOf(schema), data)).toBe(true);
    expect(run(itemsOf(schema).taken.hidden, data)).toBe(false);
    expect(run(itemsOf(schema).taken.hidden, { ...data, host: "nas2" })).toBe(true);
  });

  it("never holds a dialog without checks", () => {
    expect(applyRuleOf(pickJdDeviceForm([{ id: "i", name: "A" }]))).toBe("false");
  });
});

describe("dialog expressions — json-config runs them", () => {
  it("never spells `return`, so json-config puts its own in front", () => {
    const hostile = { takenKeys: ["return.lan:3128/"] };
    for (const p of OFFERED) {
      for (const item of Object.values(itemsOf(programForm(p.type, hostile)))) {
        for (const expr of [item.hidden, item.validator, item.disabled]) {
          expect(expr ?? "").not.toContain("return");
        }
      }
    }
  });

  it("still finds a taken host that carries the word", () => {
    const hostile = {
      takenKeys: [
        programKey({
          type: "jdownloader",
          host: "return.lan",
          port: 0,
          https: false,
          path: "",
          username: "",
          device: "",
        }),
      ],
    };
    const items = itemsOf(programForm("jdownloader", hostile));
    const data = { name: "JD", mode: "local", host: "return.lan" };
    expect(run(items.host.validator, data)).toBe(false);
    expect(run(items.taken.hidden, data)).toBe(false);
    expect(run(items.host.validator, { ...data, host: "nas" })).toBe(true);
    expect(run(items.taken.hidden, { ...data, host: "nas" })).toBe(true);
  });
});
