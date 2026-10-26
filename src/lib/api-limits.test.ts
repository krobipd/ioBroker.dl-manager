import { API_COUNTERPARTS, apiLimit } from "./api-limits";

describe("api-limits", () => {
  it("gives the local programs pyLoad's documented 100 calls a minute per host", () => {
    expect(apiLimit("Download program in the user's network", 60)).toMatchObject({ max: 100, per: "host" });
  });

  it("names the counterpart or the window it does not know", () => {
    expect(() => apiLimit("My.JDownloader", 1)).toThrow(/no 1-second limit/);
    expect(() => apiLimit("somewhere", 60)).toThrow(/'somewhere'/);
  });

  it("keeps My.JDownloader out of the local programs' pattern", () => {
    const local = API_COUNTERPARTS.find(c => c.name === "Download program in the user's network");
    const pattern = new RegExp(local?.match.hostPattern ?? "^$");
    expect(pattern.test("api.jdownloader.org")).toBe(false);
    expect(pattern.test("pyload.fixture")).toBe(true);
    expect(pattern.test("192.168.1.10")).toBe(true);
  });
});
