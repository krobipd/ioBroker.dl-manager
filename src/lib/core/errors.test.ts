import { AuthError, classify, ProtocolError, UnreachableError } from "./errors";
import { redact } from "./redact";

describe("classify", () => {
  it("tells login and reachability apart — a protocol error is one of the others", () => {
    expect(classify(new AuthError("login rejected"))).toBe("auth");
    expect(classify(new UnreachableError("timeout"))).toBe("unreachable");
    expect(classify(new ProtocolError("unexpected body"))).toBe("other");
  });

  it("treats Node's fetch failures and timeouts as unreachable", () => {
    expect(classify(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))).toBe("unreachable");
    expect(
      classify(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })),
    ).toBe("unreachable");
    expect(classify(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("unreachable");
  });

  it("calls everything else other", () => {
    expect(classify(new Error("boom"))).toBe("other");
    expect(classify("text")).toBe("other");
    expect(classify(undefined)).toBe("other");
  });
});

describe("redact", () => {
  it("hides credentials in URLs and query strings", () => {
    expect(redact("GET http://u:p@h/api?apikey=abc&x=1")).toBe("GET http://***@h/api?apikey=***&x=1");
    expect(redact("token=abc; secret=s2 password=p3 api_key=k4 pass=p5")).toBe(
      "token=***; secret=*** password=*** api_key=*** pass=***",
    );
    expect(redact('{"token":"token:secret1"}')).toBe('{"token":"token:***"}');
  });

  it("leaves ordinary text alone", () => {
    expect(redact("fetch failed (connect ECONNREFUSED 10.0.0.2:8080)")).toBe(
      "fetch failed (connect ECONNREFUSED 10.0.0.2:8080)",
    );
  });
});
