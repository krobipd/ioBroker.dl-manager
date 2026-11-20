// Fleet master (.consistency-master/src/lib/dm-log.test.ts) — never edit the copy in an adapter.
import { describe, expect, it } from "vitest";
import { RECEIVED, deviceManagerLog, withoutMessage } from "./dm-log";

function logger(): ioBroker.Logger & { lines: unknown[] } {
  const lines: unknown[] = [];
  return {
    lines,
    level: "debug",
    silly: m => lines.push(["silly", m]),
    debug: m => lines.push(["debug", m]),
    info: m => lines.push(["info", m]),
    warn: m => lines.push(["warn", m]),
    error: m => lines.push(["error", m]),
  };
}

// the line @iobroker/dm-utils writes for the answer to a dialog (build/DeviceManagement.js `handleMessage`)
const answer = `${RECEIVED}${JSON.stringify({
  command: "dm:actionProgress",
  message: { origin: 7, data: { host: "nas", password: "typed-by-the-user" } },
  from: "system.adapter.admin.0",
  callback: { id: 3 },
  _id: 9,
})}`;

describe("deviceManagerLog", () => {
  it("keeps the command of a received message and never the message", () => {
    const log = logger();
    deviceManagerLog(log).debug(answer);
    expect(log.lines).toEqual([["debug", `${RECEIVED}dm:actionProgress`]]);
    expect(JSON.stringify(log.lines)).not.toContain("typed-by-the-user");
  });

  it("writes every level to the same level of the adapter's log, a received message without it at each", () => {
    const log = logger();
    const dm = deviceManagerLog(log);
    for (const level of ["silly", "debug", "info", "warn", "error"] as const) {
      dm[level](answer);
    }
    dm.warn("Unknown message origin: 7");
    expect(log.lines).toEqual([
      ["silly", `${RECEIVED}dm:actionProgress`],
      ["debug", `${RECEIVED}dm:actionProgress`],
      ["info", `${RECEIVED}dm:actionProgress`],
      ["warn", `${RECEIVED}dm:actionProgress`],
      ["error", `${RECEIVED}dm:actionProgress`],
      ["warn", "Unknown message origin: 7"],
    ]);
    expect(dm.level).toBe("debug");
  });

  it("passes an Error to the log's error as it came — dm-utils hands its catch the log's error itself", () => {
    const log = logger();
    const failed = new Error("a handler threw");
    const { error } = deviceManagerLog(log);
    error(failed as unknown as string);
    expect(log.lines).toEqual([["error", failed]]);
  });

  it("names no part of a received line it cannot read", () => {
    expect(withoutMessage(`${RECEIVED}{"command": "dm:deviceAction", "message": {"password": "x`)).toBe(
      `${RECEIVED}a message`,
    );
    expect(withoutMessage(`${RECEIVED}null`)).toBe(`${RECEIVED}a message`);
    expect(withoutMessage(`${RECEIVED}{"command": 5}`)).toBe(`${RECEIVED}a message`);
  });
});
