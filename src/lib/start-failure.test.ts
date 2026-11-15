// Fleet master — the release run requires this file byte for byte in every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
import { EXIT_CODES } from "@iobroker/adapter-core/exitCodes";
import { failStart, SETTINGS_CATEGORY, SettingsError, type StartFailureAdapter } from "./start-failure";

/**
 * An adapter that writes every call it gets, in order, into `calls`.
 *
 * @param opts how it behaves
 * @param opts.notifyFails its notification rejects
 */
function fakeAdapter(opts: { notifyFails?: boolean } = {}): { calls: string[]; adapter: StartFailureAdapter } {
  const calls: string[] = [];
  const adapter: StartFailureAdapter = {
    name: "demo",
    log: {
      error: message => {
        calls.push(`error ${message}`);
      },
      debug: message => {
        calls.push(`debug ${message}`);
      },
    },
    registerNotification: (scope, category, message) => {
      calls.push(`notify ${scope} ${String(category)} ${message}`);
      return opts.notifyFails ? Promise.reject(new Error("no such category")) : Promise.resolve();
    },
    terminate: (reason, exitCode) => {
      calls.push(`terminate ${exitCode} ${reason}`);
      // the real one never returns; the fake must, or the test would end with it
      return undefined as never;
    },
  };
  return { calls, adapter };
}

const WRONG_PORT = "Port 70000 is out of range — choose a port from 1 to 65535";
const TAKEN = "listen EADDRINUSE: address already in use 0.0.0.0:8123";

describe("failStart — the fleet's start-failure standard", () => {
  it("a settings error: one error line, the cleanup, a notification, then exit code 11", async () => {
    const { calls, adapter } = fakeAdapter();
    const cleanup = async (): Promise<void> => {
      await Promise.resolve();
      calls.push("cleanup");
    };
    await failStart(adapter, new SettingsError(WRONG_PORT), { stopping: false, cleanup });
    expect(calls).toEqual([
      `error Settings: ${WRONG_PORT}`,
      "cleanup",
      `notify demo userActionRequired ${WRONG_PORT}`,
      `terminate 11 ${WRONG_PORT}`,
    ]);
  });

  it("any other failure: one error line, the cleanup, then exit code 6 and no notification", async () => {
    const { calls, adapter } = fakeAdapter();
    const cleanup = async (): Promise<void> => {
      await Promise.resolve();
      calls.push("cleanup");
    };
    await failStart(adapter, new Error(TAKEN), { stopping: false, cleanup });
    expect(calls).toEqual([`error Start failed: ${TAKEN}`, "cleanup", `terminate 6 ${TAKEN}`]);
  });

  it("a stop during the start: one debug line — no error line, no cleanup, no exit code of its own", async () => {
    const { calls, adapter } = fakeAdapter();
    const cleanup = (): Promise<void> => {
      calls.push("cleanup");
      return Promise.resolve();
    };
    await failStart(adapter, new SettingsError("Connection is closed."), { stopping: true, cleanup });
    expect(calls).toEqual(["debug Start ended by the stop: Connection is closed."]);
  });

  it("a cleanup that fails costs no second error line and still ends the process", async () => {
    const { calls, adapter } = fakeAdapter();
    const cleanup = (): Promise<void> => Promise.reject(new Error("socket gone"));
    await failStart(adapter, new Error(TAKEN), { stopping: false, cleanup });
    expect(calls).toEqual([
      `error Start failed: ${TAKEN}`,
      "debug Cleanup after the failed start: socket gone",
      `terminate 6 ${TAKEN}`,
    ]);
  });

  it("a notification that fails still ends with exit code 11", async () => {
    const { calls, adapter } = fakeAdapter({ notifyFails: true });
    await failStart(adapter, new SettingsError(WRONG_PORT), { stopping: false });
    expect(calls).toEqual([
      `error Settings: ${WRONG_PORT}`,
      `notify demo userActionRequired ${WRONG_PORT}`,
      "debug Notification of the settings error: no such category",
      `terminate 11 ${WRONG_PORT}`,
    ]);
  });

  it("without a cleanup the end follows the error line; a thrown text is the reason", async () => {
    const { calls, adapter } = fakeAdapter();
    await failStart(adapter, "certificate expired", { stopping: false });
    expect(calls).toEqual(["error Start failed: certificate expired", "terminate 6 certificate expired"]);
  });

  it("the codes and the category are the platform's", () => {
    // js-controller counts a crash only at 6 and restarts at 11 only when the user acts (its exit handler)
    expect(EXIT_CODES.UNCAUGHT_EXCEPTION).toBe(6);
    expect(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION).toBe(11);
    expect(SETTINGS_CATEGORY).toBe("userActionRequired");
    const err = new SettingsError(WRONG_PORT);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SettingsError");
    expect(err.message).toBe(WRONG_PORT);
  });
});
