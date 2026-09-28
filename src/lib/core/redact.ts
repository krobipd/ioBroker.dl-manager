/**
 * Removes credentials from a text before it reaches the log or a datapoint: `user:pass@` in URLs, secret query and
 * form parameters, and aria2's `token:<secret>`.
 *
 * @param text any text, typically an error message
 * @returns the text with every credential replaced by `***`
 */
export function redact(text: string): string {
  return text
    .replace(/\/\/[^/\s@]+@/g, "//***@")
    .replace(/\b(apikey|api_key|token|secret|password|pass|pwd)=([^&\s;"]+)/gi, "$1=***")
    .replace(/token:[^"\s,\]]+/g, "token:***");
}
