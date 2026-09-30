import { describe, expect, it } from "vitest";
import { ActionableProblems, type ActionableProblemsHost } from "./actionable-problems";

function makeHost(): ActionableProblemsHost & {
  warns: string[];
  notifications: string[];
} {
  const warns: string[] = [];
  const notifications: string[] = [];
  return {
    warns,
    notifications,
    logWarn: m => warns.push(m),
    notify: m => notifications.push(m),
  };
}

describe("ActionableProblems", () => {
  const problem = {
    key: "auth:qbittorrent-nas",
    title: "qBittorrent refused the login",
    action: "check user and password in the adapter settings",
  };

  it("report surfaces a new problem ONCE: warn + notification, both carrying what+action", () => {
    const host = makeHost();
    const mgr = new ActionableProblems(host);
    mgr.report(problem);
    expect(host.warns).toEqual(["qBittorrent refused the login → check user and password in the adapter settings"]);
    expect(host.notifications).toEqual(host.warns);
  });

  it("re-reporting the same active problem is a no-op (no spam)", () => {
    const host = makeHost();
    const mgr = new ActionableProblems(host);
    mgr.report(problem);
    mgr.report(problem);
    mgr.report(problem);
    expect(host.warns).toHaveLength(1);
    expect(host.notifications).toHaveLength(1);
  });

  it("re-surfaces under the same key when the message changes (refused → blocked)", () => {
    const host = makeHost();
    const mgr = new ActionableProblems(host);
    mgr.report({ key: "auth:qbittorrent-nas", title: "qBittorrent refused the login", action: "check the password" });
    mgr.report({
      key: "auth:qbittorrent-nas",
      title: "qBittorrent blocked this address",
      action: "wait an hour or restart qBittorrent",
    });
    expect(host.warns).toHaveLength(2);
    expect(host.warns[1]).toContain("blocked");
    expect(host.notifications).toHaveLength(2);
    // ...but a true duplicate after the change is still silent
    mgr.report({
      key: "auth:qbittorrent-nas",
      title: "qBittorrent blocked this address",
      action: "wait an hour or restart qBittorrent",
    });
    expect(host.warns).toHaveLength(2);
  });

  it("forget clears the problem without a line — the same problem is surfaced fresh again", () => {
    const host = makeHost();
    const mgr = new ActionableProblems(host);
    mgr.forget("never-reported");
    mgr.report(problem);
    mgr.forget("auth:qbittorrent-nas");
    expect(host.warns).toHaveLength(1);
    mgr.report(problem);
    expect(host.warns).toHaveLength(2);
    expect(host.notifications).toHaveLength(2);
  });
});
