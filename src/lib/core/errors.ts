/** The program refused the login. The runner asks it no more until the configuration changes. */
export class AuthError extends Error {
  public readonly kind = "auth";
}

/** The program could not be reached: network, timeout, server error. A state, not a log line. */
export class UnreachableError extends Error {
  public readonly kind = "unreachable";
}

/** The program answered, but not in a way the driver understands (unexpected body, unsupported command). */
export class ProtocolError extends Error {
  public readonly kind = "protocol";
}

/** Error classes the runner reacts to. */
export type ErrorKind = "auth" | "unreachable" | "protocol" | "unknown";

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
  if (err instanceof ProtocolError) {
    return "protocol";
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
  return "unknown";
}
