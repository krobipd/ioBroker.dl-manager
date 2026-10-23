// Fleet master (.consistency-master/src/lib/actionable-problems.test.ts) — never edit the copy in an adapter.
import { describe, expect, it } from "vitest";
import { ActionableProblems, type ActionableProblemsHost } from "./actionable-problems";

function host(): ActionableProblemsHost & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logWarn: m => lines.push(`warn ${m}`),
    logInfo: m => lines.push(`info ${m}`),
    notify: m => lines.push(`notify ${m}`),
  };
}

describe("ActionableProblems", () => {
  const login = { key: "auth:nas", title: "nas refused the login", action: "check the login on its card" };

  it("surfaces a new problem once with a notification, stays quiet while it is the same", () => {
    const h = host();
    const problems = new ActionableProblems(h);
    problems.report(login);
    problems.report(login);
    expect(h.lines).toEqual([
      "warn nas refused the login → check the login on its card",
      "notify nas refused the login → check the login on its card",
    ]);
  });

  it("surfaces it again when its text changed", () => {
    const h = host();
    const problems = new ActionableProblems(h);
    problems.report(login);
    problems.report({ ...login, title: "nas blocked the address" });
    expect(h.lines.filter(l => l.startsWith("warn"))).toEqual([
      "warn nas refused the login → check the login on its card",
      "warn nas blocked the address → check the login on its card",
    ]);
  });

  it("resolves an active problem with one info line, a default one or the caller's", () => {
    const h = host();
    const problems = new ActionableProblems(h);
    problems.resolve("auth:nas");
    problems.report(login);
    problems.resolve("auth:nas");
    problems.resolve("auth:nas");
    problems.report(login);
    problems.resolve("auth:nas", "nas accepts the login again");
    expect(h.lines.filter(l => l.startsWith("info"))).toEqual([
      "info Resolved: nas refused the login",
      "info nas accepts the login again",
    ]);
  });

  it("forgets a problem without a line, so the next report surfaces it again", () => {
    const h = host();
    const problems = new ActionableProblems(h);
    problems.report(login);
    problems.forget("auth:nas");
    problems.resolve("auth:nas");
    problems.report(login);
    expect(h.lines.filter(l => l.startsWith("warn")).length).toBe(2);
    expect(h.lines.filter(l => l.startsWith("info"))).toEqual([]);
  });
});
