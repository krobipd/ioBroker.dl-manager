import { deviceIdFor, hostPiece, ID_SCHEME, programPart, RESERVED_IDS, settleIds } from "./device-id";

const none = new Set<string>();
const local = (
  type: string,
  host: string,
  port = 0,
): { type: string; host: string; port: number; deviceId: string } => ({
  type,
  host,
  port,
  deviceId: "",
});

describe("programPart", () => {
  it("names the program without the way it is reached", () => {
    expect(programPart("jdownloader")).toBe("jdownloader");
    expect(programPart("jdownloader-cloud")).toBe("jdownloader");
    expect(programPart("qbittorrent")).toBe("qbittorrent");
    expect(programPart("Some Thing")).toBe("some-thing");
    expect(programPart("")).toBe("program");
  });
});

describe("hostPiece", () => {
  it("takes the first label of a host name, an IP address with dashes", () => {
    expect(hostPiece("nas.fritz.box", "iob")).toBe("nas");
    expect(hostPiece(" NAS ", "iob")).toBe("nas");
    expect(hostPiece("192.168.1.20", "iob")).toBe("192-168-1-20");
    expect(hostPiece("[fd00::1]", "iob")).toBe("fd00-1");
    expect(hostPiece("fd00::1", "iob")).toBe("fd00-1");
  });

  it("names the ioBroker host for the machine ioBroker runs on", () => {
    expect(hostPiece("localhost", "ioBroker-Pi")).toBe("iobroker-pi");
    expect(hostPiece("127.0.0.1", "iob")).toBe("iob");
    expect(hostPiece("::1", "iob")).toBe("iob");
    expect(hostPiece("localhost", "")).toBe("localhost");
  });

  it("keeps at most 20 characters and no dash at the end", () => {
    expect(hostPiece("a-very-long-host-name-indeed.lan", "iob")).toBe("a-very-long-host-nam");
    expect(hostPiece("abcdefghijklmnopqrs-tuv", "iob")).toBe("abcdefghijklmnopqrs");
    expect(hostPiece("über-straße", "iob")).toBe("uber-strasse");
  });
});

describe("deviceIdFor", () => {
  it("gives a local program the machine, then the port, then a counter", () => {
    expect(deviceIdFor(local("transmission", "nas.lan"), none, "iob")).toBe("transmission-nas");
    expect(deviceIdFor(local("transmission", "nas", 9092), new Set(["transmission-nas"]), "iob")).toBe(
      "transmission-nas-9092",
    );
    expect(deviceIdFor(local("transmission", "nas"), new Set(["transmission-nas"]), "iob")).toBe(
      "transmission-nas-9091",
    );
    expect(
      deviceIdFor(local("transmission", "nas"), new Set(["transmission-nas", "transmission-nas-9091"]), "iob"),
    ).toBe("transmission-nas-9091-2");
    expect(
      deviceIdFor(
        local("transmission", "nas"),
        new Set(["transmission-nas", "transmission-nas-9091", "transmission-nas-9091-2"]),
        "iob",
      ),
    ).toBe("transmission-nas-9091-3");
  });

  it("gives a local JDownloader the machine as well — never the way it is reached", () => {
    expect(deviceIdFor(local("jdownloader", "10.0.0.5"), none, "iob")).toBe("jdownloader-10-0-0-5");
  });

  it("gives My.JDownloader the last four characters of the account's id, then the whole id, then a counter", () => {
    const cloud = { type: "jdownloader-cloud", host: "", port: 0, deviceId: "AF9D03A21DDB917492DC1AF8A6427F11" };
    expect(deviceIdFor(cloud, none, "iob")).toBe("jdownloader-7f11");
    expect(deviceIdFor(cloud, new Set(["jdownloader-7f11"]), "iob")).toBe(
      "jdownloader-af9d03a21ddb917492dc1af8a6427f11",
    );
    expect(
      deviceIdFor(cloud, new Set(["jdownloader-7f11", "jdownloader-af9d03a21ddb917492dc1af8a6427f11"]), "iob"),
    ).toBe("jdownloader-af9d03a21ddb917492dc1af8a6427f11-2");
  });

  it("has no id for My.JDownloader while the account's id is unknown", () => {
    expect(deviceIdFor({ type: "jdownloader-cloud", host: "", port: 0, deviceId: "" }, none, "iob")).toBeUndefined();
    expect(deviceIdFor({ type: "jdownloader-cloud", host: "", port: 0, deviceId: "--" }, none, "iob")).toBeUndefined();
  });

  it("gives a row without an address a piece all the same, and never one of the instance's own roots", () => {
    expect(deviceIdFor(local("sabnzbd", ""), none, "iob")).toBe("sabnzbd-device");
    for (const id of RESERVED_IDS) {
      expect(deviceIdFor(local(id, ""), none, "iob")).not.toBe(id);
    }
    expect(ID_SCHEME).toBe(3);
  });
});

describe("settleIds", () => {
  it("gives every row from before 0.3.0 its id, names the move of its device and drops the ID column", () => {
    const { rows, moves } = settleIds(
      [
        { type: "transmission", key: "", host: "nas" },
        { type: "qbittorrent", key: "keller", host: "10.0.0.2", port: 8081 },
      ],
      "iob",
    );
    expect(rows).toEqual([
      { type: "transmission", host: "nas", id: "transmission-nas" },
      { type: "qbittorrent", host: "10.0.0.2", port: 8081, id: "qbittorrent-10-0-0-2" },
    ]);
    expect([...moves]).toEqual([
      ["transmission", "transmission-nas"],
      ["qbittorrent-keller", "qbittorrent-10-0-0-2"],
    ]);
  });

  it("keeps a row that has its id, and never gives another row that id or an old id still to move", () => {
    const { rows, moves } = settleIds(
      [
        { id: "qbittorrent-nas", type: "qbittorrent", host: "10.0.0.9" },
        { type: "qbittorrent", key: "nas-8080", host: "other" },
        { type: "qbittorrent", key: "", host: "nas" },
      ],
      "iob",
    );
    expect(rows.map(r => r.id)).toEqual(["qbittorrent-nas", "qbittorrent-other", "qbittorrent-nas-8080-2"]);
    expect(moves.get("qbittorrent")).toBe("qbittorrent-nas-8080-2");
  });

  it("keeps a My.JDownloader row on its old id until the account names the instance's id", () => {
    const first = settleIds([{ type: "jdownloader-cloud", key: "", username: "me@x", device: "PC" }], "iob");
    expect(first.rows).toEqual([
      { type: "jdownloader-cloud", username: "me@x", device: "PC", id: "jdownloader-cloud", idPending: true },
    ]);
    expect(first.moves.size).toBe(0);
    const again = settleIds(first.rows, "iob");
    expect(again.rows).toEqual(first.rows);
    const named = settleIds([{ ...first.rows[0], deviceId: "abcd1234" }], "iob");
    expect(named.rows).toEqual([
      { type: "jdownloader-cloud", username: "me@x", device: "PC", deviceId: "abcd1234", id: "jdownloader-1234" },
    ]);
    expect([...named.moves]).toEqual([["jdownloader-cloud", "jdownloader-1234"]]);
  });

  it("moves nothing when the new id is the old one", () => {
    const { rows, moves } = settleIds([{ type: "aria2", key: "iob", host: "localhost" }], "iob");
    expect(rows[0].id).toBe("aria2-iob");
    expect(moves.size).toBe(0);
  });
});
