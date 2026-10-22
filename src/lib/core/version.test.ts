import { ProgramVersion } from "./version";

describe("ProgramVersion", () => {
  it("reads the version with the first query and again after a failed one (review B15)", async () => {
    const v = new ProgramVersion();
    let reads = 0;
    const read = (): Promise<string> => Promise.resolve(`v${++reads}`);
    expect(await v.poll(read, version => Promise.resolve(version))).toBe("v1");
    expect(await v.poll(read, version => Promise.resolve(version))).toBe("v1");
    await expect(v.poll(read, () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await v.poll(read, version => Promise.resolve(version))).toBe("v2");
    v.forget();
    expect(await v.poll(read, version => Promise.resolve(version))).toBe("v3");
  });

  it("reads again when the version itself could not be read", async () => {
    const v = new ProgramVersion();
    let fail = true;
    const read = (): Promise<string> => (fail ? Promise.reject(new Error("no")) : Promise.resolve("v9"));
    await expect(v.poll(read, version => Promise.resolve(version))).rejects.toThrow("no");
    fail = false;
    expect(await v.poll(read, version => Promise.resolve(version))).toBe("v9");
  });
});
