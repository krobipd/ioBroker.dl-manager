import { loginHint } from "./login-hint";
import type { ProgramConfig } from "./model";

const cfg = (type: string, login: Partial<Pick<ProgramConfig, "username" | "apiKey">> = {}): ProgramConfig => ({
  type,
  name: "",
  host: "nas",
  port: 0,
  https: false,
  path: "",
  username: "",
  password: "",
  apiKey: "",
  device: "",
  deviceId: "",
  ...login,
});

describe("loginHint", () => {
  it("says for Transmission without a login that none is set and names the switch of its dialog", () => {
    expect(loginHint(cfg("transmission"))).toEqual({
      cause: "no login is set on its card",
      action: 'switch on "The program asks for a login" on its card and enter user and password',
    });
  });

  it("asks to check user and password once a user is set", () => {
    expect(loginHint(cfg("transmission", { username: "u" }))).toEqual({
      action: "check user and password on its card",
    });
    expect(loginHint(cfg("nzbget", { username: "u" }))).toEqual({ action: "check user and password on its card" });
  });

  it("says for NZBGet without a user that none is set", () => {
    expect(loginHint(cfg("nzbget"))).toEqual({
      cause: "no login is set on its card",
      action: "enter user and password on its card",
    });
  });

  it("names the API key only where the program has one", () => {
    expect(loginHint(cfg("sabnzbd")).action).toBe("check the API key on its card");
    expect(loginHint(cfg("qbittorrent", { apiKey: "k" })).action).toBe("check the API key on its card");
    expect(loginHint(cfg("pyload", { username: "u" })).action).toBe("check user and password on its card");
    expect(loginHint(cfg("deluge")).action).toBe("check the password on its card");
    expect(loginHint(cfg("jdownloader-cloud")).action).toBe("check e-mail and password on its card");
    for (const type of ["transmission", "nzbget", "deluge", "jdownloader-cloud"]) {
      expect(loginHint(cfg(type)).action).not.toMatch(/API key/);
    }
  });

  it("says for qBittorrent or pyLoad without user and key that none is set", () => {
    for (const type of ["qbittorrent", "pyload"]) {
      expect(loginHint(cfg(type))).toEqual({
        cause: "no login is set on its card",
        action: "enter user and password or an API key on its card",
      });
    }
  });

  it("handles the RPC secret of aria2 — set or not", () => {
    expect(loginHint(cfg("aria2", { apiKey: "s" }))).toEqual({ action: "check the RPC secret on its card" });
    expect(loginHint(cfg("aria2"))).toEqual({
      cause: "no login is set on its card",
      action: "enter the RPC secret on its card",
    });
  });

  it("falls back to address and login for a program without a login of its own", () => {
    expect(loginHint(cfg("jdownloader"))).toEqual({ action: "check the address and the login on its card" });
    expect(loginHint(cfg("unknown"))).toEqual({ action: "check the address and the login on its card" });
  });
});
