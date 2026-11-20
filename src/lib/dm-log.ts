// Fleet master (.consistency-master/src/lib/dm-log.ts) — never edit the copy in an adapter.
//
// Round 187 (R187-15, finding 8204263955b4): @iobroker/dm-utils writes every message of the admin's device manager whole
// into the debug log (`DeviceManagement received: <the message as JSON>`, build/DeviceManagement.js `handleMessage`) —
// the answer to a dialog with what the user typed, a password or an API key among it; and no log line carries a secret,
// at no level (ioBroker.docs bestpractices.md, rule sentence S8 of the fleet). dm-utils takes its log from its `log`
// getter. Every device manager of the fleet (common.supportedMessages.deviceManager) hands it this master, so the line
// keeps the command and never the message:
//
//   protected override get log(): ioBroker.Logger {
//     return deviceManagerLog(this.adapter.log);
//   }

/** How dm-utils starts the line it writes for every message it receives. */
export const RECEIVED = "DeviceManagement received: ";

/**
 * The text of a log call with the message of a received line left out: the line names the command alone. Every other
 * text passes as it came — dm-utils hands its catch the log's `error` itself, which then gets an Error, not a text.
 *
 * @param text what the device manager logs
 */
export function withoutMessage(text: string): string {
  const given: unknown = text;
  if (typeof given !== "string" || !given.startsWith(RECEIVED)) {
    return text;
  }
  let command: unknown;
  try {
    command = (JSON.parse(given.slice(RECEIVED.length)) as { command?: unknown } | null)?.command;
  } catch {
    // not JSON: the line names no part of it
  }
  return `${RECEIVED}${typeof command === "string" ? command : "a message"}`;
}

/**
 * The adapter's log for its device manager: every level writes to `log`, a received message without its content.
 *
 * @param log the adapter's log
 */
export function deviceManagerLog(log: ioBroker.Logger): ioBroker.Logger {
  return {
    silly: text => log.silly(withoutMessage(text)),
    debug: text => log.debug(withoutMessage(text)),
    info: text => log.info(withoutMessage(text)),
    warn: text => log.warn(withoutMessage(text)),
    error: text => log.error(withoutMessage(text)),
    get level() {
      return log.level;
    },
  };
}
