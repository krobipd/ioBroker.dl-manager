// Core decision K1 (accepted 2026-10-22, krobi: "alle soweit ok"): a download is the unit the user added — a
// JDownloader or pyLoad package with 20 files is one channel, not 20; likewise a torrent, an NZB job, an aria2 download
// (its top GID).
import { describe, expect, it, vi } from "vitest";
import type { DriverDeps, ProgramConfig, ProgramSnapshot } from "../lib/core/model";
import { JdDriver } from "../lib/programs/jdownloader/driver";
import { findProgram } from "../lib/programs/registry";

/**
 * What the program answers, by `<program> <call>` — each case sets exactly the calls its driver makes; a call without an
 * answer fails the case. A list of several answers is given out in turn, the last one for ever.
 */
const replies = vi.hoisted(() => new Map<string, unknown[]>());
const reply = vi.hoisted(() => (call: string): Promise<unknown> => {
  const queue = replies.get(call);
  if (!queue?.length) {
    return Promise.reject(new Error(`the program was asked ${call}, which this case does not answer`));
  }
  return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
});

// Each program's client is replaced by one that answers as the program's API does — the driver is the real one.
vi.mock("../lib/programs/qbittorrent/client", () => ({
  QbClient: class {
    readonly needsLogin = false;
    get(path: string): Promise<{ status: number; text: string; json: () => unknown }> {
      return reply(`qbittorrent ${path}`).then(body => ({
        status: 200,
        text: typeof body === "string" ? body : JSON.stringify(body),
        json: () => body,
      }));
    }
  },
}));
vi.mock("../lib/programs/pyload/client", () => ({
  PyClient: class {
    get(fn: string, query: Record<string, string> = {}): Promise<unknown> {
      return reply(`pyload ${fn}${Object.keys(query).length ? ` ${new URLSearchParams(query).toString()}` : ""}`);
    }
  },
}));
vi.mock("../lib/programs/aria2/client", () => ({
  nodeSocket: () => ({ addEventListener: () => undefined, close: () => undefined }),
  AriaClient: class {
    multicall(calls: readonly (readonly [string, unknown[]])[]): Promise<unknown[]> {
      return Promise.all(calls.map(([method]) => reply(`aria2 ${method}`)));
    }
  },
}));
vi.mock("../lib/programs/nzbget/client", () => ({
  NzbClient: class {
    call(method: string): Promise<unknown> {
      return reply(`nzbget ${method}`);
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
 * @param type a program type of the catalog
 * @param answers what the program answers, by `<program> <call>`
 * @param polls how many times the adapter asks
 * @returns the last query
 */
async function polled(type: string, answers: Record<string, unknown[]>, polls = 1): Promise<ProgramSnapshot> {
  replies.clear();
  for (const [call, list] of Object.entries(answers)) {
    replies.set(call, [...list]);
  }
  const driver = findProgram(type)!.create({ ...CFG, type }, DEPS);
  let last = await driver.poll();
  for (let i = 1; i < polls; i++) {
    last = await driver.poll();
  }
  return last;
}

describe("K1 a download is the unit the user added", () => {
  it("makes one download of a JDownloader package, however many links it holds", async () => {
    const pkg = (uuid: number, name: string, bytesTotal: number, bytesLoaded: number): Record<string, unknown> => ({
      uuid,
      name,
      saveTo: `/output/${name}`,
      hosts: ["seed"],
      childCount: uuid === 10 ? 3 : 1,
      bytesTotal,
      bytesLoaded,
      enabled: true,
      finished: false,
      status: "Downloading",
    });
    const link = (uuid: number, packageUUID: number): Record<string, unknown> => ({
      uuid,
      packageUUID,
      name: `part${uuid}.rar`,
      url: `http://seed:8080/part${uuid}.rar`,
      host: "http links",
      bytesTotal: 100,
      bytesLoaded: 0,
      enabled: true,
      finished: false,
      status: "Downloading",
    });
    // the local JDownloader's transport answers what its driver asks, in the form of its API
    const answers: Record<string, unknown> = {
      "/jd/version": 48637,
      "/toolbar/getStatus": { running: true, pause: false, state: "RUNNING", speed: 0, limit: false, limitspeed: 0 },
      "/downloadsV2/queryPackages": [pkg(10, "holiday", 300, 100), pkg(11, "single", 50, 0)],
      "/downloadsV2/queryLinks": [link(1, 10), link(2, 10), link(3, 10), link(4, 11)],
    };
    const api = {
      call: (path: string): Promise<unknown> =>
        path in answers
          ? Promise.resolve(answers[path])
          : Promise.reject(new Error(`the program was asked ${path}, which this case does not answer`)),
      close: () => undefined,
    };
    const s = await new JdDriver({ ...CFG, type: "jdownloader" }, DEPS, api, null).poll();
    expect(s.items.map(i => i.key)).toEqual(["10", "11"]);
    expect(s.items[0]).toMatchObject({ name: "holiday", sizeBytes: 300 });
  });

  it("makes one download of a pyLoad package, however many files it holds", async () => {
    const file = (fid: number): Record<string, unknown> => ({
      fid,
      url: `http://seed:8080/series.part${fid}.rar`,
      name: `series.part${fid}.rar`,
      plugin: "DefaultPlugin",
      size: 100,
      format_size: "100 B",
      status: 3,
      statusmsg: "queued",
      package_id: 5,
      error: "",
      order: fid,
    });
    const s = await polled("pyload", {
      "pyload get_server_version": ["0.5.0"],
      "pyload status_server": [{ pause: false, active: 0, queue: 3, total: 3, speed: 0, download: true }],
      "pyload get_queue_data": [
        [
          {
            pid: 5,
            name: "series",
            folder: "series",
            site: "",
            password: "",
            dest: 1,
            order: 0,
            linksdone: 0,
            sizedone: 0,
            sizetotal: 300,
            linkstotal: 3,
            links: [file(1), file(2), file(3)],
            fids: null,
          },
        ],
      ],
      "pyload status_downloads": [[]],
      "pyload free_space": [1_000_000_000],
      "pyload get_config_value category=download&option=limit_speed": [false],
      "pyload get_config_value category=download&option=max_speed": [-1],
    });
    expect(s.items.map(i => i.key)).toEqual(["5"]);
    expect(s.items[0]).toMatchObject({ name: "series" });
  });

  it("makes one download of an aria2 download — the one the user added, not the parts it was split into", async () => {
    const files = (paths: string[]): Record<string, unknown>[] =>
      paths.map((path, i) => ({
        index: String(i + 1),
        path,
        length: "300",
        completedLength: "0",
        selected: "true",
        uris: [],
      }));
    const s = await polled("aria2", {
      "aria2 aria2.getVersion": [{ version: "1.37.0", enabledFeatures: ["BitTorrent"] }],
      // the magnet's metadata finished and was followed by the torrent itself, which holds three files
      "aria2 aria2.tellActive": [
        [
          {
            gid: "real",
            status: "active",
            following: "meta",
            totalLength: "900",
            completedLength: "0",
            downloadSpeed: "10",
            uploadSpeed: "0",
            connections: "1",
            dir: "/downloads",
            bittorrent: { info: { name: "distro" } },
            files: files(["/downloads/distro/a.iso", "/downloads/distro/b.iso", "/downloads/distro/c.iso"]),
          },
        ],
      ],
      "aria2 aria2.tellWaiting": [[]],
      "aria2 aria2.tellStopped": [
        [
          {
            gid: "meta",
            status: "complete",
            followedBy: ["real"],
            totalLength: "0",
            completedLength: "0",
            downloadSpeed: "0",
            uploadSpeed: "0",
            connections: "0",
            dir: "/downloads",
            files: files(["[METADATA]distro"]),
          },
        ],
      ],
      "aria2 aria2.getGlobalStat": [{ downloadSpeed: "10", uploadSpeed: "0", numActive: "1", numWaiting: "0" }],
      "aria2 aria2.getGlobalOption": [{ "max-overall-download-limit": "0", "max-overall-upload-limit": "0" }],
    });
    expect(s.items.map(i => i.key)).toEqual(["real"]);
  });

  it("makes one download of an NZB job, however many files it holds", async () => {
    // one group of NZBGet's listgroups is one NZB job; its files are FirstID…LastID
    const s = await polled("nzbget", {
      "nzbget version": ["24.8"],
      "nzbget status": [{ DownloadPaused: false, DownloadRate: 0, DownloadLimit: 0 }],
      "nzbget listgroups": [
        [
          {
            NZBID: 7,
            NZBName: "season",
            NZBNicename: "season",
            Kind: "NZB",
            Status: "DOWNLOADING",
            FirstID: 101,
            LastID: 120,
            FileCount: 20,
            RemainingFileCount: 20,
            FileSizeLo: 2_000_000_000,
            FileSizeHi: 0,
            RemainingSizeLo: 2_000_000_000,
            RemainingSizeHi: 0,
            DownloadedSizeLo: 0,
            DownloadedSizeHi: 0,
          },
        ],
      ],
      "nzbget history": [[]],
    });
    expect(s.items.map(i => i.key)).toEqual(["7"]);
    expect(s.items[0]).toMatchObject({ name: "season", sizeBytes: 2_000_000_000 });
  });

  it("makes one download of a torrent, however many files it holds, also over a partial update", async () => {
    const hash = "0123456789abcdef0123456789abcdef01234567";
    const s = await polled(
      "qbittorrent",
      {
        "qbittorrent app/version": ["v5.0.0"],
        // the full list: one torrent whose content is a folder of files
        "qbittorrent sync/maindata?rid=0": [
          {
            rid: 1,
            full_update: true,
            torrents: {
              [hash]: {
                name: "distro",
                state: "downloading",
                content_path: "/downloads/distro",
                save_path: "/downloads",
                root_path: "/downloads/distro",
                size: 900,
                total_size: 900,
                completed: 300,
                downloaded: 300,
                progress: 0.3333,
                dlspeed: 1000,
                upspeed: 0,
                eta: 600,
                added_on: 1790633456,
                completion_on: -1,
                infohash_v1: hash,
              },
            },
            server_state: { dl_info_speed: 1000, up_info_speed: 0, dl_rate_limit: 0, up_rate_limit: 0 },
          },
        ],
        // the next answer names only what changed of the same torrent
        "qbittorrent sync/maindata?rid=1": [
          { rid: 2, torrents: { [hash]: { completed: 600, downloaded: 600, progress: 0.6667, eta: 300 } } },
        ],
      },
      2,
    );
    expect(s.items.map(i => i.key)).toEqual([hash]);
    expect(s.items[0]).toMatchObject({ name: "distro", sizeBytes: 900 });
  });
});
