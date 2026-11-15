import {
  aliasPlan,
  carryPlan,
  enumsHolding,
  moveAllWithEnums,
  moveWithEnums,
  type EnumCarryAdapter,
} from "./enum-carry";

type Store = Record<string, { type?: string; common: Record<string, unknown> }>;
type Enums = Record<string, { common: { members: string[]; name?: string } }>;

/**
 * A fake object store that records every call in order, so a test can prove the delete comes before the carry.
 *
 * @param enums the enum objects by id
 * @param opts failure switches and the alias objects
 * @param opts.listFails reject the enum listing
 * @param opts.writeFails reject every enum write
 * @param opts.aliases the alias objects by id
 * @param opts.aliasListFails reject the alias listing
 * @param opts.aliasWriteFails reject every alias write
 */
function fakeStore(
  enums: Enums,
  opts: {
    listFails?: boolean;
    writeFails?: boolean;
    aliases?: Store;
    aliasListFails?: boolean;
    aliasWriteFails?: boolean;
  } = {},
): {
  adapter: EnumCarryAdapter;
  order: string[];
  store: Enums;
  aliases: Store;
  warn: ReturnType<typeof vi.fn>;
} {
  const order: string[] = [];
  const warn = vi.fn();
  const aliases: Store = opts.aliases ?? {};
  const isAlias = (id: string): boolean => id.startsWith("alias.");
  const adapter: EnumCarryAdapter = {
    getForeignObjectsAsync: (pattern: string, type: "enum" | "state"): Promise<Record<string, unknown>> => {
      order.push(`list ${pattern}`);
      if (pattern === "alias.*") {
        expect(type).toBe("state");
        return opts.aliasListFails ? Promise.reject(new Error("db down")) : Promise.resolve(structuredClone(aliases));
      }
      expect([pattern, type]).toEqual(["enum.*", "enum"]);
      return opts.listFails ? Promise.reject(new Error("db down")) : Promise.resolve(structuredClone(enums));
    },
    getForeignObjectAsync: (id: string): Promise<unknown> => {
      order.push(`read ${id}`);
      return Promise.resolve(structuredClone((isAlias(id) ? aliases[id] : enums[id]) ?? null));
    },
    setForeignObject: (id: string, obj: Record<string, unknown>): Promise<unknown> => {
      order.push(`write ${id}`);
      if (isAlias(id) ? opts.aliasWriteFails : opts.writeFails) {
        return Promise.reject(new Error("write refused"));
      }
      if (isAlias(id)) {
        aliases[id] = obj as Store[string];
      } else {
        enums[id] = obj as Enums[string];
      }
      return Promise.resolve({});
    },
    log: { warn },
  };
  return { adapter, order, store: enums, aliases, warn };
}

const errText = (e: unknown): string => `[via helper] ${e instanceof Error ? e.message : String(e)}`;

/**
 * One user alias in the object store: a state under `alias.*` whose `common.alias.id` names its target.
 *
 * @param id the target — one id, or `{ read, write }`
 * @param extra further `common` fields of the alias
 */
const userAlias = (id: unknown, extra: Record<string, unknown> = {}): Store[string] => ({
  type: "state",
  common: { name: "Lamp of the user", role: "switch", type: "boolean", ...extra, alias: { id, read: "val" } },
});

describe("enumsHolding", () => {
  it("lists the enums whose members contain the id, sorted", () => {
    const enums = {
      "enum.rooms.living": { common: { members: ["a.0.old", "a.0.x"] } },
      "enum.functions.light": { common: { members: ["a.0.old"] } },
      "enum.rooms.kitchen": { common: { members: ["a.0.x"] } },
      "enum.broken": { common: {} },
    };
    expect(enumsHolding(enums, "a.0.old")).toEqual(["enum.functions.light", "enum.rooms.living"]);
    expect(enumsHolding(undefined, "a.0.old")).toEqual([]);
  });
});

describe("moveWithEnums", () => {
  it("reads first, deletes second, writes the new id last — into exactly the enums that held the old id", async () => {
    const { adapter, order, store } = fakeStore({
      "enum.rooms.living": { common: { members: ["a.0.old", "a.0.x"], name: "Living" } },
      "enum.rooms.kitchen": { common: { members: ["a.0.x"] } },
    });
    const remove = vi.fn(() => {
      order.push("delete a.0.old");
      // The controller's removeIdFromAllEnums: the old id leaves every enum.
      store["enum.rooms.living"].common.members = store["enum.rooms.living"].common.members.filter(
        m => m !== "a.0.old",
      );
      return Promise.resolve();
    });
    await expect(moveWithEnums(adapter, "a.0.old", "a.0.new", remove, errText)).resolves.toEqual(["enum.rooms.living"]);
    expect(order).toEqual([
      "list enum.*",
      "list alias.*",
      "delete a.0.old",
      "read enum.rooms.living",
      "write enum.rooms.living",
    ]);
    expect(store["enum.rooms.living"]).toEqual({ common: { members: ["a.0.x", "a.0.new"], name: "Living" } });
    expect(store["enum.rooms.kitchen"].common.members).toEqual(["a.0.x"]);
  });

  it("does not add the new id twice", async () => {
    const { adapter, store } = fakeStore({ "enum.rooms.living": { common: { members: ["a.0.old", "a.0.new"] } } });
    await moveWithEnums(adapter, "a.0.old", "a.0.new", () => Promise.resolve(), errText);
    expect(store["enum.rooms.living"].common.members).toEqual(["a.0.new"]);
  });

  it("still deletes and warns through the caller's helper when the enums cannot be read", async () => {
    const { adapter, warn } = fakeStore({}, { listFails: true });
    const remove = vi.fn(() => Promise.resolve());
    await expect(moveWithEnums(adapter, "a.0.old", "a.0.new", remove, errText)).resolves.toEqual([]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "Room and function assignments of a.0.old could not be read: [via helper] db down",
    );
  });

  it("warns per enum when a write fails and reports only what was carried", async () => {
    const { adapter, warn } = fakeStore(
      { "enum.rooms.living": { common: { members: ["a.0.old"] } } },
      { writeFails: true },
    );
    await expect(moveWithEnums(adapter, "a.0.old", "a.0.new", () => Promise.resolve(), errText)).resolves.toEqual([]);
    expect(warn.mock.calls[0][0]).toBe(
      "Assignment enum.rooms.living could not be carried to a.0.new: [via helper] write refused",
    );
  });

  it("skips an enum that is gone by the time of the write — no warning, no write", async () => {
    const { adapter, order, store, warn } = fakeStore({
      "enum.rooms.gone": { common: { members: ["a.0.old"] } },
      "enum.rooms.living": { common: { members: ["a.0.old"] } },
    });
    const remove = vi.fn(() => {
      delete store["enum.rooms.gone"];
      return Promise.resolve();
    });
    await expect(moveWithEnums(adapter, "a.0.old", "a.0.new", remove, errText)).resolves.toEqual(["enum.rooms.living"]);
    expect(warn).not.toHaveBeenCalled();
    expect(order).not.toContain("write enum.rooms.gone");
    expect(store["enum.rooms.gone"]).toBeUndefined();
  });

  it("lets a failed delete surface to the caller", async () => {
    const { adapter } = fakeStore({ "enum.rooms.living": { common: { members: ["a.0.old"] } } });
    await expect(
      moveWithEnums(adapter, "a.0.old", "a.0.new", () => Promise.reject(new Error("gone")), errText),
    ).rejects.toThrow("gone");
  });

  it("points the user's aliases at the new id after the delete and the enums — plain and split, the rest kept", async () => {
    const { adapter, order, aliases, warn } = fakeStore(
      { "enum.rooms.living": { common: { members: ["a.0.old"] } } },
      {
        aliases: {
          "alias.0.lamp": userAlias("a.0.old", { custom: { "history.0": { enabled: true } } }),
          "alias.0.split": userAlias({ read: "a.0.old", write: "a.0.other" }),
          "alias.0.stays": userAlias({ read: "a.0.other", write: "a.0.other" }),
          "alias.0.room": { type: "channel", common: { name: "Living room" } },
        },
      },
    );
    const before = structuredClone(aliases);
    const remove = vi.fn(() => {
      order.push("delete a.0.old");
      return Promise.resolve();
    });
    await expect(moveWithEnums(adapter, "a.0.old", "a.0.new", remove, errText)).resolves.toEqual(["enum.rooms.living"]);
    expect(order).toEqual([
      "list enum.*",
      "list alias.*",
      "delete a.0.old",
      "read enum.rooms.living",
      "write enum.rooms.living",
      "read alias.0.lamp",
      "write alias.0.lamp",
      "read alias.0.split",
      "write alias.0.split",
    ]);
    expect(aliases["alias.0.lamp"]).toEqual(userAlias("a.0.new", { custom: { "history.0": { enabled: true } } }));
    expect(aliases["alias.0.split"]).toEqual(userAlias({ read: "a.0.new", write: "a.0.other" }));
    expect(aliases["alias.0.stays"]).toEqual(before["alias.0.stays"]);
    expect(aliases["alias.0.room"]).toEqual(before["alias.0.room"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("writes no alias the adapter already pointed at the new id, and none that is gone", async () => {
    const { adapter, order, aliases, warn } = fakeStore(
      {},
      { aliases: { "alias.0.lamp": userAlias("a.0.old"), "alias.0.gone": userAlias("a.0.old") } },
    );
    const remove = vi.fn(() => {
      aliases["alias.0.lamp"] = userAlias("a.0.new");
      delete aliases["alias.0.gone"];
      return Promise.resolve();
    });
    await moveWithEnums(adapter, "a.0.old", "a.0.new", remove, errText);
    expect(order).toEqual(["list enum.*", "list alias.*", "read alias.0.gone", "read alias.0.lamp"]);
    expect(aliases["alias.0.lamp"]).toEqual(userAlias("a.0.new"));
    expect(aliases["alias.0.gone"]).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("still deletes and carries the enums, with one warning, when the aliases cannot be read", async () => {
    const { adapter, store, warn } = fakeStore(
      { "enum.rooms.living": { common: { members: ["a.0.old"] } } },
      { aliasListFails: true },
    );
    const remove = vi.fn(() => Promise.resolve());
    await expect(moveWithEnums(adapter, "a.0.old", "a.0.new", remove, errText)).resolves.toEqual(["enum.rooms.living"]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(store["enum.rooms.living"].common.members).toEqual(["a.0.new"]);
    expect(warn.mock.calls).toEqual([["Aliases of a.0.old could not be read: [via helper] db down"]]);
  });

  it("warns per alias whose write fails and still points the others", async () => {
    const { adapter, aliases, warn } = fakeStore(
      {},
      {
        aliases: { "alias.0.lamp": userAlias("a.0.old"), "alias.0.split": userAlias({ read: "a.0.old" }) },
        aliasWriteFails: true,
      },
    );
    await expect(moveWithEnums(adapter, "a.0.old", "a.0.new", () => Promise.resolve(), errText)).resolves.toEqual([]);
    expect(warn.mock.calls).toEqual([
      ['Alias alias.0.lamp could not follow to "a.0.new": [via helper] write refused'],
      ['Alias alias.0.split could not follow to {"read":"a.0.new"}: [via helper] write refused'],
    ]);
    expect(aliases["alias.0.lamp"]).toEqual(userAlias("a.0.old"));
  });
});

describe("carryPlan", () => {
  it("names, per enum, the members that move and their successors — sorted by enum, nothing for staying members", () => {
    const enums = {
      "enum.rooms.living": { common: { members: ["a.0.dev.x", "a.0.dev.x.power", "a.0.other"] } },
      "enum.functions.light": { common: { members: ["a.0.dev.x.power"] } },
      "enum.rooms.kitchen": { common: { members: ["a.0.other"] } },
    };
    const below = (id: string): string[] =>
      id === "a.0.dev.x" || id.startsWith("a.0.dev.x.") ? [`a.0.dev.y${id.slice("a.0.dev.x".length)}`] : [];
    const plan = carryPlan(enums, below);
    expect([...plan.keys()]).toEqual(["enum.functions.light", "enum.rooms.living"]);
    expect([...plan.get("enum.rooms.living")!]).toEqual([
      ["a.0.dev.x", ["a.0.dev.y"]],
      ["a.0.dev.x.power", ["a.0.dev.y.power"]],
    ]);
    expect(carryPlan(undefined, below).size).toBe(0);
  });
});

describe("aliasPlan", () => {
  const below = (id: string): string[] =>
    id === "a.0.dev.x" || id.startsWith("a.0.dev.x.") ? [`a.0.dev.y${id.slice("a.0.dev.x".length)}`, "a.0.second"] : [];

  it("names every alias whose target moves, with its first new id — sorted, nothing for the rest", () => {
    const plan = aliasPlan(
      {
        "alias.0.z": userAlias("a.0.dev.x.power"),
        "alias.0.a": userAlias({ read: "a.0.dev.x.level", write: "a.0.dev.x.set" }),
        "alias.0.half": userAlias({ read: "a.0.other", write: "a.0.dev.x.set", type: "number" }),
        "alias.0.stays": userAlias("a.0.other"),
        "alias.0.split.stays": userAlias({ read: "a.0.other", write: "a.0.more" }),
        "alias.0.number": userAlias(7),
        "alias.0.empty": userAlias(null),
        "alias.0.folder": { type: "folder", common: {} },
        "alias.0.nothing": {},
      },
      below,
    );
    expect([...plan]).toEqual([
      ["alias.0.a", { read: "a.0.dev.y.level", write: "a.0.dev.y.set" }],
      ["alias.0.half", { read: "a.0.other", write: "a.0.dev.y.set", type: "number" }],
      ["alias.0.z", "a.0.dev.y.power"],
    ]);
    expect(aliasPlan(undefined, below).size).toBe(0);
  });

  it("asks the successors only for ids, never for a missing part", () => {
    const asked: unknown[] = [];
    const plan = aliasPlan({ "alias.0.read.only": userAlias({ read: "a.0.dev.x" }) }, id => {
      asked.push(id);
      return below(id);
    });
    expect(asked).toEqual(["a.0.dev.x"]);
    expect(plan.get("alias.0.read.only")).toEqual({ read: "a.0.dev.y" });
  });
});

describe("moveAllWithEnums", () => {
  it("reads the enums once, deletes once, and writes every affected enum once with all its new ids", async () => {
    const { adapter, order, store } = fakeStore({
      "enum.rooms.living": { common: { members: ["a.0.dev.x", "a.0.dev.x.power", "a.0.other"], name: "Living" } },
      "enum.functions.light": { common: { members: ["a.0.dev.x.power", "a.0.dev.x.level"] } },
      "enum.rooms.kitchen": { common: { members: ["a.0.other"] } },
    });
    const remove = vi.fn(() => {
      order.push("delete a.0.dev.x");
      for (const e of Object.values(store)) {
        e.common.members = e.common.members.filter(m => !m.startsWith("a.0.dev.x"));
      }
      return Promise.resolve();
    });
    const below = (id: string): string[] =>
      id === "a.0.dev.x" || id.startsWith("a.0.dev.x.") ? [`a.0.dev.y${id.slice("a.0.dev.x".length)}`] : [];
    await expect(moveAllWithEnums(adapter, below, remove, errText)).resolves.toEqual([
      { enumId: "enum.functions.light", newIds: ["a.0.dev.y.power", "a.0.dev.y.level"] },
      { enumId: "enum.rooms.living", newIds: ["a.0.dev.y", "a.0.dev.y.power"] },
    ]);
    expect(order).toEqual([
      "list enum.*",
      "list alias.*",
      "delete a.0.dev.x",
      "read enum.functions.light",
      "write enum.functions.light",
      "read enum.rooms.living",
      "write enum.rooms.living",
    ]);
    expect(store["enum.rooms.living"]).toEqual({
      common: { members: ["a.0.other", "a.0.dev.y", "a.0.dev.y.power"], name: "Living" },
    });
    expect(store["enum.rooms.kitchen"].common.members).toEqual(["a.0.other"]);
  });

  it("carries one old id to several new ids, and a new id twice only once", async () => {
    const { adapter, store } = fakeStore({ "enum.rooms.living": { common: { members: ["a.0.old", "a.0.b"] } } });
    const successors = (id: string): string[] => (id === "a.0.old" ? ["a.0.a", "a.0.b"] : []);
    await moveAllWithEnums(adapter, successors, () => Promise.resolve(), errText);
    expect(store["enum.rooms.living"].common.members).toEqual(["a.0.b", "a.0.a"]);
  });

  it("still deletes and warns once when the enums cannot be read", async () => {
    const { adapter, warn } = fakeStore({}, { listFails: true });
    const remove = vi.fn(() => Promise.resolve());
    await expect(moveAllWithEnums(adapter, () => ["x"], remove, errText)).resolves.toEqual([]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("Room and function assignments could not be read: [via helper] db down");
  });

  it("warns per enum when a write fails, naming every new id it could not carry", async () => {
    const { adapter, warn } = fakeStore(
      { "enum.rooms.living": { common: { members: ["a.0.x", "a.0.x.y"] } } },
      { writeFails: true },
    );
    const successors = (id: string): string[] => (id.startsWith("a.0.x") ? [id.replace("a.0.x", "a.0.z")] : []);
    await expect(moveAllWithEnums(adapter, successors, () => Promise.resolve(), errText)).resolves.toEqual([]);
    expect(warn.mock.calls[0][0]).toBe(
      "Assignment enum.rooms.living could not be carried to a.0.z, a.0.z.y: [via helper] write refused",
    );
  });

  it("points every alias below a moved root at its successor, and warns without a subject when none can be read", async () => {
    const below = (id: string): string[] =>
      id === "a.0.dev.x" || id.startsWith("a.0.dev.x.") ? [`a.0.dev.y${id.slice("a.0.dev.x".length)}`] : [];
    const { adapter, aliases } = fakeStore(
      {},
      {
        aliases: {
          "alias.0.power": userAlias("a.0.dev.x.power"),
          "alias.0.level": userAlias({ read: "a.0.dev.x.level", write: "a.0.dev.x.set" }),
          "alias.0.other": userAlias("a.0.other"),
        },
      },
    );
    await expect(moveAllWithEnums(adapter, below, () => Promise.resolve(), errText)).resolves.toEqual([]);
    expect(aliases["alias.0.power"]).toEqual(userAlias("a.0.dev.y.power"));
    expect(aliases["alias.0.level"]).toEqual(userAlias({ read: "a.0.dev.y.level", write: "a.0.dev.y.set" }));
    expect(aliases["alias.0.other"]).toEqual(userAlias("a.0.other"));

    const failing = fakeStore({}, { aliasListFails: true });
    await moveAllWithEnums(failing.adapter, below, () => Promise.resolve(), errText);
    expect(failing.warn.mock.calls).toEqual([["Aliases could not be read: [via helper] db down"]]);
  });
});
