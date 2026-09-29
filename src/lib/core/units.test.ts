import {
  asRecord,
  asRecords,
  asText,
  doneOf,
  epochMs,
  eta,
  fromMBps,
  hiLo,
  nonNegative,
  num,
  percent,
  round2,
  toGB,
  toMBps,
} from "./units";

describe("units", () => {
  it("converts speeds to MB/s with two decimals", () => {
    expect(toMBps(11_800_000)).toBe(11.8);
    expect(toMBps(40_000)).toBe(0.04);
    expect(toMBps(0)).toBe(0);
  });

  it("treats negative, NaN and non-numbers as unknown", () => {
    for (const v of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined]) {
      expect(toMBps(v)).toBeNull();
    }
  });

  it("converts sizes to GB with two decimals", () => {
    expect(toGB(6_120_000_000)).toBe(6.12);
    expect(toGB(-5)).toBeNull();
  });

  it("turns 0, negatives and garbage into unlimited when writing a limit", () => {
    expect(fromMBps(0)).toBe(0);
    expect(fromMBps(-3)).toBe(0);
    expect(fromMBps("2")).toBe(0);
    expect(fromMBps(2.5)).toBe(2_500_000);
  });

  it("computes percent only with a known size and caps it at 100", () => {
    expect(percent(2.61e9, 6.12e9)).toBe(42.6);
    expect(percent(5, 0)).toBeNull();
    expect(percent(null, 10)).toBeNull();
    expect(percent(20, 10)).toBe(100);
  });

  it("maps every program sentinel for the time left to null", () => {
    expect(eta(8_640_000, [8_640_000])).toBeNull();
    expect(eta(-1, [])).toBeNull();
    expect(eta(-2, [])).toBeNull();
    expect(eta(0, [0])).toBeNull();
    expect(eta(89.6, [0])).toBe(90);
    expect(eta("90", [])).toBeNull();
  });

  it("reads the numeric strings SABnzbd and aria2 send", () => {
    expect(num("1277.65")).toBe(1277.65);
    expect(num(12)).toBe(12);
    expect(num("")).toBeNull();
    expect(num("abc")).toBeNull();
    expect(num(Number.NaN)).toBeNull();
    expect(num(null)).toBeNull();
  });

  it("joins NZBGet's unsigned 32-bit hi/lo pairs", () => {
    expect(hiLo(1, 5)).toBe(4_294_967_301);
    expect(hiLo("0", "7")).toBe(7);
    expect(hiLo(undefined, 5)).toBeNull();
  });
});

describe("reading a program's answer", () => {
  it("takes an object as it is and anything else as none", () => {
    const o = { a: 1 };
    expect(asRecord(o)).toBe(o);
    for (const v of [null, undefined, 3, "x", [1]]) {
      expect(asRecord(v)).toEqual({});
    }
    expect(asRecords([o, 5, null])).toEqual([o, {}, {}]);
    expect(asRecords({ a: 1 })).toEqual([]);
    expect(asText("x")).toBe("x");
    expect(asText(5)).toBe("");
  });

  it("takes counts, sizes and rates of zero and up, as numbers or digit strings", () => {
    expect(nonNegative(0)).toBe(0);
    expect(nonNegative("12")).toBe(12);
    expect(nonNegative(-1)).toBeNull();
    expect(nonNegative("x")).toBeNull();
  });

  it("turns a time in seconds since 1970 into milliseconds, 0 and below into none", () => {
    expect(epochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(epochMs("2")).toBe(2000);
    expect(epochMs(0)).toBeNull();
    expect(epochMs(-5)).toBeNull();
  });

  it("works out the loaded bytes, never below zero, none while a part is unknown", () => {
    expect(doneOf(100, 40)).toBe(60);
    expect(doneOf(100, 140)).toBe(0);
    expect(doneOf(null, 40)).toBeNull();
    expect(doneOf(100, null)).toBeNull();
  });

  it("rounds to two decimals", () => {
    expect(round2(1.23456)).toBe(1.23);
    expect(round2(0.005)).toBe(0.01);
  });
});
