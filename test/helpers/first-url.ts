/**
 * The URL of the first request an action sends. `fetch` is stubbed to refuse, so nothing leaves the machine — the
 * way to check a default port or a path that no local fixture server can listen on.
 *
 * @param action the call to make (its failure is expected and swallowed)
 * @returns the URL of the first request
 */
export async function firstUrl(action: () => Promise<unknown>): Promise<string> {
  const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
  try {
    await action().catch(() => undefined);
    const input: unknown = spy.mock.calls[0]?.[0];
    if (typeof input === "string") {
      return input;
    }
    return input instanceof URL ? input.href : "";
  } finally {
    spy.mockRestore();
  }
}
