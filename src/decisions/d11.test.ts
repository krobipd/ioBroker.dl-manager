// Core decision D-11 (accepted 2026-10-22): the program list is no folder in the object tree but a file of the instance
// — programs.json in its data folder, which every ioBroker backup takes along; password and API key are stored encrypted
// with encrypt(); neither account nor password shows up in the object tree, and so in no object export. krobi 2026-09-30
// 21:19: "why is that actually a folder? dl-manager.0.programs — does it have to be stored in the object tree? can't it
// be stored differently? besides, the password is encrypted" · 21:23 on moving the programs into a file in the data
// folder, with dataFolder for the backup: "yes, absolutely".
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProgramManager, type ManagerAdapter } from "../lib/core/manager";
import type { ProgramDriver, ProgramEntry } from "../lib/core/model";
import type { ProgramStore } from "../lib/core/store";
import { SECRET_FIELDS, STORE_FILE } from "../lib/core/store";
import { readDataFile, type DataFileCipher } from "../lib/data-file";
import * as mainModule from "../main";
const { DownloadManagerAdapter } = mainModule as unknown as { DownloadManagerAdapter: new () => ioBroker.Adapter };

// The adapter base without js-controller: what the store needs — the instance's data folder and the installation secret.
vi.mock("@iobroker/adapter-core", () => ({
  Adapter: class {
    namespace = "dl-manager.0";
    adapterDir = "/opt/iobroker/node_modules/iobroker.dl-manager";
    log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
    on(): void {}
    encrypt(value: string): string {
      return `$/aes-192-cbc:${Buffer.from(value).toString("base64")}`;
    }
    decrypt(value: string): string {
      return Buffer.from(value.replace("$/aes-192-cbc:", ""), "base64").toString();
    }
  },
  getAbsoluteInstanceDataDir: () => "/opt/iobroker/iobroker-data/dl-manager.0",
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

const pkg = JSON.parse(readFileSync(join(process.cwd(), "io-package.json"), "utf8")) as {
  common: Record<string, unknown>;
  native: Record<string, unknown>;
  instanceObjects: { _id: string }[];
};

/** The object and state store of an instance, in memory — this guard's own copy (a guard imports no test code). */
class Memory implements ManagerAdapter {
  readonly namespace = "dl-manager.0";
  readonly objects = new Map<string, ioBroker.Object>();
  readonly states = new Map<string, ioBroker.StateValue>();
  readonly log = { debug: () => undefined, info: () => undefined, warn: () => undefined };
  private full(id: string): string {
    return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
  }
  extendObject(id: string, obj: ioBroker.PartialObject): Promise<void> {
    const old = (this.objects.get(this.full(id)) ?? {}) as Record<string, unknown>;
    const patch = structuredClone(obj) as Record<string, unknown>;
    this.objects.set(this.full(id), {
      ...old,
      ...patch,
      common: { ...(old.common as object), ...(patch.common as object) },
      native: { ...(old.native as object), ...(patch.native as object) },
    } as unknown as ioBroker.Object);
    return Promise.resolve();
  }
  delObject(): Promise<void> {
    return Promise.resolve();
  }
  knownObject(id: string): unknown {
    return this.objects.get(this.full(id));
  }
  getForeignObjects(): Promise<Record<string, ioBroker.Object>> {
    return Promise.resolve({});
  }
  knownValue(id: string): ioBroker.StateValue | undefined {
    return this.states.get(this.full(id));
  }
  setState(id: string, state: ioBroker.SettableState): Promise<void> {
    this.states.set(this.full(id), state.val ?? null);
    return Promise.resolve();
  }
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<void> {
    return this.setState(id, state);
  }
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null> {
    return Promise.resolve(structuredClone(this.objects.get(id) ?? null));
  }
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
    this.objects.set(id, obj as ioBroker.Object);
    return Promise.resolve();
  }
}

describe("D-11 the programs live in a file of the data folder, secrets encrypted, nothing of them in the object tree", () => {
  it("keeps the programs in programs.json in the instance's data folder, which the backup takes along", () => {
    expect(STORE_FILE).toBe("programs.json");
    expect(pkg.common.dataFolder).toBe("dl-manager.%INSTANCE%");
    const adapter = new DownloadManagerAdapter() as unknown as { storeFile: string };
    expect(adapter.storeFile).toBe(join("/opt/iobroker/iobroker-data/dl-manager.0", "programs.json"));
  });

  it("stores password and API key encrypted with the adapter's encrypt(), the rest as typed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-manager-d11-"));
    try {
      const adapter = new DownloadManagerAdapter() as unknown as { programs: ProgramStore } & DataFileCipher;
      Object.defineProperty(adapter, "storeFile", { value: join(dir, STORE_FILE) });
      const row = {
        id: "qbittorrent-nas",
        type: "qbittorrent",
        host: "nas",
        username: "admin",
        password: "password-of-the-nas",
        apiKey: "api-key-of-the-nas",
      };
      await adapter.programs.write([row]);
      const raw = readFileSync(join(dir, STORE_FILE), "utf8");
      for (const secret of [row.password, row.apiKey]) {
        expect(raw.includes(secret), secret).toBe(false);
      }
      expect((JSON.parse(raw) as { rows: Record<string, unknown>[] }).rows[0]).toMatchObject({
        username: "admin",
        host: "nas",
      });
      const read = readDataFile(dir, STORE_FILE, { cipher: adapter, fields: SECRET_FIELDS });
      expect((read.value as { rows: Record<string, unknown>[] }).rows[0]).toMatchObject({
        password: row.password,
        apiKey: row.apiKey,
      });
      expect(await adapter.programs.read()).toEqual([row]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts no program list into the instance or the object tree", () => {
    expect(pkg.native).not.toHaveProperty("programs");
    expect(pkg.instanceObjects.map(o => o._id).filter(id => id === "programs" || id.startsWith("programs."))).toEqual(
      [],
    );
  });

  it("writes neither account nor password of a program into the object tree", async () => {
    const a = new Memory();
    const driver = (type: string): ProgramDriver => ({
      type,
      capabilities: new Set(["globalPause", "add"]),
      extras: [],
      poll: () => new Promise(() => undefined),
      command: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
    const entries: Record<string, ProgramEntry> = {
      "jdownloader-cloud": { type: "jdownloader-cloud", needs: [], create: () => driver("jdownloader-cloud") },
      qbittorrent: { type: "qbittorrent", needs: [], create: () => driver("qbittorrent") },
    };
    const manager = new ProgramManager(
      {
        adapter: a,
        timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
        find: type => entries[type],
        problems: { report: () => undefined, forget: () => undefined },
        moveDevice: () => Promise.resolve(),
      },
      { intervalMs: 10_000, scope: "all", limit: 100 },
    );
    // an earlier version stored the account in the device's address
    await a.extendObject("dl-manager.0.jdownloader-2222", {
      type: "device",
      common: { name: "JD friend" },
      native: { type: "jdownloader-cloud", address: "owner@example.com/Office" },
    });
    await manager.start([
      {
        id: "jdownloader-2222",
        type: "jdownloader-cloud",
        name: "JD friend",
        username: "owner@example.com",
        password: "cloud-secret",
        device: "Office",
        deviceId: "bbbb2222",
      },
      {
        id: "qbittorrent-nas",
        type: "qbittorrent",
        name: "NAS",
        host: "nas",
        username: "admin",
        password: "qb-secret",
      },
    ]);
    expect(a.objects.get("dl-manager.0.jdownloader-2222")?.type).toBe("device");
    expect(a.objects.get("dl-manager.0.qbittorrent-nas")?.type).toBe("device");
    const tree = JSON.stringify([...a.objects]) + JSON.stringify([...a.states]);
    for (const secret of ["owner@example.com", "cloud-secret", "qb-secret"]) {
      expect(tree.includes(secret), secret).toBe(false);
    }
  });
});
