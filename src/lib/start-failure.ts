// Fleet master — the release run requires this file byte for byte in every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
/**
 * How an adapter ends when its start fails — the fleet's start-failure standard (krobi 2026-11-11 23:32, "yes, accept it
 * like that", on the question that named its content). A start that cannot reach its working state ends the process and
 * never runs on as an empty shell. Wrong settings end with one error line, a notification in the admin and exit code 11:
 * the controller starts the instance again only when the user saves its settings or starts it. Everything else — a taken
 * port, a data file that cannot be read or written, a certificate, a bug of the adapter — ends with one error line and
 * exit code 6: the controller tries again after 30 s and, at the third failure within ten minutes, leaves the instance
 * off and shows its restart-loop notification. When in doubt it is the second way: a passing cause must never end as a
 * settings error, or the instance stays off until a person comes. No adapter builds a restart loop of its own — never
 * `restart()` (code 0: again every 30 s, without end and without a notification), never code 156 (again every second).
 * A counterpart that is missing, slow or refuses is no start failure: the outage rules hold and the adapter keeps trying
 * on its own. Measured at js-controller's exit handler (`controller/src/main.ts`) of the stable baseline of 2026-11-11.
 *
 * A stop during the start is no start failure either: whatever the start awaited fails because the instance closes, and
 * that ends with one debug line, no error line and no exit code of its own — the stop ends the process. `terminate` does
 * not call `onUnload`, so the caller hands over its own cleanup (servers, sockets, timers, the last writes), the path its
 * `onUnload` takes; it runs before the end. A resource of the adapter's own that fails after the start (its server ends
 * with an error, the data folder can no longer be written) and leaves it unable to work takes the same way.
 *
 * Fleet master: `Entwicklung/.consistency-master/src/lib/start-failure.ts`. Every adapter carries this file and its test
 * byte for byte — the release run (consistency level 1) reports any difference — and its `onReady` catch calls
 * `failStart` (consistency level 2). Change the master, then copy; never the copy.
 */
import { EXIT_CODES } from "@iobroker/adapter-core/exitCodes";
import { errText } from "./err-text";

/** The notification category every adapter that throws a {@link SettingsError} declares in its io-package.json. */
export const SETTINGS_CATEGORY = "userActionRequired";

/** A start failure caused by the adapter's own settings; the message says what is wrong and what the user must do. */
export class SettingsError extends Error {
  /**
   * @param message what is wrong and what the user must do — the error line and the notification in one sentence
   */
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/** What `failStart` needs of the adapter — the adapter class itself. */
export interface StartFailureAdapter {
  /** The adapter's name — the scope of its notifications. */
  readonly name: string;
  /** The adapter's logger. */
  readonly log: {
    /** A problem the user should look at. */
    error(message: string): void;
    /** A routine line. */
    debug(message: string): void;
  };
  /** A notification in the admin, of a category the io-package.json declares. */
  registerNotification(scope: string, category: string | null, message: string): Promise<void>;
  /** Ends the process with the exit code; `onUnload` does not run. */
  terminate(reason: string, exitCode: number): never;
}

/** What only the caller knows. */
export interface StartFailureOptions {
  /** True once the instance is stopping (its `onUnload` began): a stop during the start is no start failure. */
  stopping: boolean;
  /** Closes what the start opened and awaits the last writes — the path `onUnload` takes, which `terminate` skips. */
  cleanup?: () => Promise<void>;
}

/**
 * Ends a failed start the fleet's way: one error line, the cleanup, then a {@link SettingsError} with a notification and
 * exit code 11, anything else with exit code 6; a stop during the start with one debug line only.
 *
 * @param adapter the adapter (`this` in its `onReady` catch)
 * @param err what the start threw
 * @param options whether the instance is stopping, and the cleanup
 */
export async function failStart(
  adapter: StartFailureAdapter,
  err: unknown,
  options: StartFailureOptions,
): Promise<void> {
  const text = errText(err);
  if (options.stopping) {
    adapter.log.debug(`Start ended by the stop: ${text}`);
    return;
  }
  const settings = err instanceof SettingsError;
  adapter.log.error(settings ? `Settings: ${text}` : `Start failed: ${text}`);
  if (options.cleanup) {
    try {
      await options.cleanup();
    } catch (cleanupError) {
      adapter.log.debug(`Cleanup after the failed start: ${errText(cleanupError)}`);
    }
  }
  if (!settings) {
    return adapter.terminate(text, EXIT_CODES.UNCAUGHT_EXCEPTION);
  }
  try {
    await adapter.registerNotification(adapter.name, SETTINGS_CATEGORY, text);
  } catch (notifyError) {
    adapter.log.debug(`Notification of the settings error: ${errText(notifyError)}`);
  }
  return adapter.terminate(text, EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
}
