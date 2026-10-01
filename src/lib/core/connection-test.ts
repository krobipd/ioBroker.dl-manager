import { errText } from "../err-text";
import { parsePrograms } from "./config";
import { classify } from "./errors";
import type { DriverDeps, ProgramEntry } from "./model";
import { redact } from "./redact";

/** What a connection test found. */
export type TestResult =
  | { ok: true; version: string; downloads?: number }
  | { ok: false; kind: "setup" | "auth" | "unreachable" | "other"; text: string };

/**
 * The card's connection test: builds a driver for one settings row, asks the program once and closes the driver.
 * A switched-off row is tested all the same — the user asked for it.
 *
 * @param raw one program row (secrets readable)
 * @param find registry lookup
 * @param deps timers and log for the driver — no pause store, no id learning
 * @returns what the program answered
 */
export async function testProgram(
  raw: unknown,
  find: (type: string) => ProgramEntry | undefined,
  deps: DriverDeps,
): Promise<TestResult> {
  const [row] = parsePrograms([raw && typeof raw === "object" ? { ...raw, enabled: true } : raw], find);
  if (!row?.entry) {
    return { ok: false, kind: "setup", text: row?.problem || "program type missing" };
  }
  const driver = row.entry.create(row.cfg, deps);
  try {
    if (driver.test) {
      return { ok: true, version: await driver.test() };
    }
    const snap = await driver.poll();
    return { ok: true, version: snap.status.version, downloads: snap.items.length };
  } catch (err: unknown) {
    return { ok: false, kind: classify(err), text: redact(errText(err)) };
  } finally {
    await driver.close().catch(() => undefined);
  }
}
