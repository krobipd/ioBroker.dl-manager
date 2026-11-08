import { API_COUNTERPARTS, apiLimit, LOCAL_PROGRAMS, MY_JDOWNLOADER } from "./api-limits";

describe("api-limits", () => {
  it("gives the local programs pyLoad's documented 100 calls a minute per host", () => {
    expect(apiLimit(LOCAL_PROGRAMS, 60)).toMatchObject({ max: 100, per: "host" });
  });

  it("names the counterpart or the window it does not know", () => {
    expect(() => apiLimit(MY_JDOWNLOADER, 1)).toThrow(/no 1-second limit/);
    expect(() => apiLimit("somewhere", 60)).toThrow(/'somewhere'/);
  });

  it("reaches the local programs in the user's network and My.JDownloader at its host", () => {
    const match = (name: string): unknown => API_COUNTERPARTS.find(c => c.name === name)?.match;
    expect(match(LOCAL_PROGRAMS)).toEqual({ network: "private", kind: "http" });
    expect(match(MY_JDOWNLOADER)).toEqual({ host: "api.jdownloader.org", kind: "http" });
  });
});
