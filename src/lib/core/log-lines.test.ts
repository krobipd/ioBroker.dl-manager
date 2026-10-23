import { commandLine } from "./log-lines";

describe("commandLine — the info line after a user's command", () => {
  const name = (key: string): string => (key === "k1" ? "Ubuntu ISO" : key);

  it("names the download by its name, by its key while the program has not listed it", () => {
    expect(commandLine({ kind: "pause", key: "k1" }, name)).toBe('paused "Ubuntu ISO"');
    expect(commandLine({ kind: "resume", key: "k2" }, name)).toBe('resumed "k2"');
    expect(commandLine({ kind: "remove", key: "k1" }, name)).toBe('removed "Ubuntu ISO" from the program\'s list');
  });

  it("says what a program-wide command did", () => {
    expect(commandLine({ kind: "pauseAll" }, name)).toBe("paused");
    expect(commandLine({ kind: "resumeAll" }, name)).toBe("resumed");
    expect(commandLine({ kind: "setAltSpeed", on: true }, name)).toBe("alternative speed limits on");
    expect(commandLine({ kind: "setAltSpeed", on: false }, name)).toBe("alternative speed limits off");
  });

  it("gives a limit in MB/s, and 0 as off", () => {
    expect(commandLine({ kind: "setSpeedLimit", bps: 2_500_000 }, name)).toBe("download limit 2.5 MB/s");
    expect(commandLine({ kind: "setUploadLimit", bps: 1_000_000 }, name)).toBe("upload limit 1 MB/s");
    expect(commandLine({ kind: "setSpeedLimit", bps: 0 }, name)).toBe("download limit off");
  });

  it("names an added link without its credentials", () => {
    expect(commandLine({ kind: "add", url: "https://user:secret@host/file.iso" }, name)).toBe(
      "added https://***@host/file.iso",
    );
  });

  it("names a program's own command, with the download it acted on", () => {
    expect(commandLine({ kind: "extra", name: "force start", key: "k1" }, name)).toBe('force start for "Ubuntu ISO"');
    expect(commandLine({ kind: "extra", name: "reconnect" }, name)).toBe("reconnect");
  });
});
