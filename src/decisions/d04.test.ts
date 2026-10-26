// Core decision D-04 (accepted 2026-10-22): a download can be removed through a datapoint of its own, like in the
// parcelapp adapter — removing takes it at most out of the program's list; the adapter never deletes downloaded files.
// krobi 2026-09-28 21:52: "just build in a datapoint for deleting, like in the parcel adapter — it only deletes the
// datapoint, at most the api can delete the download from the list through it".
import { describe, expect, it, vi } from "vitest";
import { ITEM_DATAPOINTS } from "../lib/core/datapoints";
import type { DriverDeps, ProgramConfig, ProgramDriver } from "../lib/core/model";
import { JdDriver } from "../lib/programs/jdownloader/driver";
import { findProgram } from "../lib/programs/registry";

/** Every request a program client was asked to send: program, method or endpoint, parameters. */
const sent = vi.hoisted(() => [] as { program: string; method: string; params: unknown }[]);

// Each program's client is replaced by a recorder — this guard checks what the driver asks the program, not the wire.
vi.mock("../lib/programs/qbittorrent/client", () => ({
  QbClient: class {
    post(method: string, params: unknown): Promise<string> {
      sent.push({ program: "qbittorrent", method, params });
      return Promise.resolve("");
    }
  },
}));
vi.mock("../lib/programs/transmission/client", () => ({
  TrClient: class {
    call(method: string, params: unknown): Promise<Record<string, unknown>> {
      sent.push({ program: "transmission", method, params });
      return Promise.resolve({});
    }
  },
}));
vi.mock("../lib/programs/deluge/client", () => ({
  DlClient: class {
    call(method: string, params: unknown): Promise<unknown> {
      sent.push({ program: "deluge", method, params });
      return Promise.resolve(true);
    }
  },
}));
vi.mock("../lib/programs/sabnzbd/client", () => ({
  SabClient: class {
    call(params: Record<string, unknown>): Promise<Record<string, unknown>> {
      sent.push({ program: "sabnzbd", method: `${String(params.mode)}.${String(params.name)}`, params });
      return Promise.resolve({ status: true });
    }
  },
}));
vi.mock("../lib/programs/nzbget/client", () => ({
  NzbClient: class {
    call(method: string, params: unknown): Promise<unknown> {
      sent.push({ program: "nzbget", method, params });
      return Promise.resolve(true);
    }
  },
}));
vi.mock("../lib/programs/aria2/client", () => ({
  nodeSocket: () => ({ addEventListener: () => undefined, close: () => undefined }),
  AriaClient: class {
    call(method: string, params: unknown): Promise<unknown> {
      sent.push({ program: "aria2", method, params });
      return Promise.resolve("OK");
    }
  },
}));
vi.mock("../lib/programs/pyload/client", () => ({
  PyClient: class {
    post(method: string, params: unknown): Promise<unknown> {
      sent.push({ program: "pyload", method, params });
      return Promise.resolve(true);
    }
  },
}));

const CFG: ProgramConfig = {
  type: "",
  name: "guard",
  host: "192.0.2.1",
  port: 0,
  https: false,
  path: "",
  username: "user",
  password: "pw",
  apiKey: "key",
  device: "",
  deviceId: "",
};
const DEPS: DriverDeps = {
  setTimeout: () => undefined,
  clearTimeout: () => undefined,
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
};

/**
 * @param type a program type
 * @param listed which list of the program the download is in (`queue` for one still loading, `history` for a done one)
 * @returns what removing a download of that program asks the program
 */
async function removeVia(type: string, listed: "queue" | "history"): Promise<{ method: string; params: unknown }[]> {
  sent.length = 0;
  const driver: ProgramDriver = findProgram(type)!.create({ ...CFG, type }, DEPS);
  const own = driver as unknown as { inQueue?: Set<string>; stopped?: Set<string> };
  if (listed === "queue") {
    own.inQueue?.add("42");
  } else {
    own.stopped?.add("42");
  }
  await driver.command({ kind: "remove", key: "42" });
  return sent.filter(s => s.program === type).map(({ method, params }) => ({ method, params }));
}

describe("D-04 remove takes a download out of the list, never its files", () => {
  it("is a button of its own on every download", () => {
    const remove = ITEM_DATAPOINTS.find(d => d.id === "remove");
    expect(remove).toMatchObject({ role: "button", write: true, capability: "itemRemove" });
    expect(remove?.command?.(true, "42")).toEqual({ kind: "remove", key: "42" });
    expect(remove?.command?.(false, "42")).toBeNull();
  });

  it("asks every program to drop the download from its list and to keep the files", async () => {
    for (const listed of ["queue", "history"] as const) {
      expect(await removeVia("qbittorrent", listed)).toEqual([
        { method: "torrents/delete", params: { hashes: "42", deleteFiles: "false" } },
      ]);
      expect(await removeVia("transmission", listed)).toEqual([
        { method: "torrent_remove", params: { ids: ["42"], delete_local_data: false } },
      ]);
      expect(await removeVia("deluge", listed)).toEqual([{ method: "core.remove_torrent", params: ["42", false] }]);
      expect(await removeVia("pyload", listed)).toEqual([{ method: "delete_packages", params: { package_ids: [42] } }]);
    }
    expect(await removeVia("sabnzbd", "queue")).toEqual([
      { method: "queue.delete", params: { mode: "queue", name: "delete", value: "42" } },
    ]);
    expect(await removeVia("sabnzbd", "history")).toEqual([
      { method: "history.delete", params: { mode: "history", name: "delete", value: "42" } },
    ]);
    // NZBGet: GroupParkDelete keeps what is loaded, HistoryDelete drops only the entry (never *FinalDelete/GroupDelete)
    expect(await removeVia("nzbget", "queue")).toEqual([
      { method: "editqueue", params: ["GroupParkDelete", "", [42]] },
    ]);
    expect(await removeVia("nzbget", "history")).toEqual([
      { method: "editqueue", params: ["HistoryDelete", "", [42]] },
    ]);
    expect(await removeVia("aria2", "queue")).toEqual([{ method: "aria2.remove", params: ["42"] }]);
    expect(await removeVia("aria2", "history")).toEqual([{ method: "aria2.removeDownloadResult", params: ["42"] }]);
  });

  it("asks JDownloader, local and through My.JDownloader, to remove the package from its list only", async () => {
    for (const type of ["jdownloader", "jdownloader-cloud"]) {
      const calls: { path: string; params: unknown }[] = [];
      const api = {
        call: (path: string, params?: unknown[]): Promise<unknown> => {
          calls.push({ path, params });
          return Promise.resolve(null);
        },
        close: () => undefined,
      };
      await new JdDriver({ ...CFG, type }, DEPS, api, null).command({ kind: "remove", key: "42" });
      expect(calls).toEqual([{ path: "/downloadsV2/removeLinks", params: [[], [42]] }]);
    }
  });
});
