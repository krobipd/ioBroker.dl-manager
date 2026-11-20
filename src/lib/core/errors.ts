/** The program refused the login. The runner asks it no more until the configuration changes. */
export class AuthError extends Error {}

/** The program could not be reached: network, timeout, server error. A state, not a log line. */
export class UnreachableError extends Error {}

/** The program answered, but not in a way the driver understands (unexpected body, unsupported command). */
export class ProtocolError extends Error {}

/**
 * The program cannot do what the command asks, so the driver sends nothing (core decision D-13: what a program cannot
 * reach is not offered there) — the command is not confirmed, a warning says why.
 */
export class RefusedError extends Error {}

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
  return "other";
}
