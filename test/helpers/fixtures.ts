import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One recorded answer from `test/fixtures/` (live-programs.yml). */
export interface Fixture {
  /** Where and when it was recorded. */
  _source: { program: string; version: string; request: string; recordedAt: string };
  /** HTTP status. */
  status: number;
  /** Response headers the drivers read. */
  headers?: Record<string, string>;
  /** Parsed body (JSON or text). */
  body: unknown;
}

/**
 * @param program program type
 * @param version version folder
 * @param state state folder (`running`, `commands`, …)
 * @param name file name without `.json`
 * @returns the recorded answer
 */
export function loadFixture(program: string, version: string, state: string, name: string): Fixture {
  const file = join(__dirname, "..", "fixtures", program, version, state, `${name}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Fixture;
}
