/** The program refused the login. The runner asks it no more until the configuration changes. */
export class AuthError extends Error {}

/** The program could not be reached: network, timeout, server error. A state, not a log line. */
export class UnreachableError extends Error {}

/** The program answered, but not in a way the driver understands (unexpected body, unsupported command). */
export class ProtocolError extends Error {}

/** What the runner and the connection test tell apart; a protocol error is an `other` like any unexpected one. */
export type ErrorKind = "auth" | "unreachable" | "other";

/**
 * The class of a caught value.
 *
 * @param err whatever a `catch` received
 * @returns the class
 */
export function classify(err: unknown): ErrorKind {
  if (err instanceof AuthError) {
    return "auth";
  }
  if (err instanceof UnreachableError) {
    return "unreachable";
  }
  if (err instanceof Error) {
    // Node's fetch: TypeError("fetch failed", { cause }) for DNS/refused/reset, TimeoutError/AbortError for the signal.
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "unreachable";
    }
    if (err instanceof TypeError && err.message === "fetch failed") {
      return "unreachable";
    }
  }
  return "other";
}
