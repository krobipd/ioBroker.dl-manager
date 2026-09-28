import { describe, expect, it } from "vitest";
import { ActionableProblems, type ActionableProblemsHost } from "./actionable-problems";

function makeHost(): ActionableProblemsHost & {
  warns: string[];
  infos: string[];
  notifications: string[];
} {
  const warns: string[] = [];
  const infos: string[] = [];
  const notifications: string[] = [];
  return {
    warns,
    infos,
    notifications,
    logWarn: m => warns.push(m),
    logInfo: m => infos.push(m),
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

  it("resolve logs a single positive line and clears the problem", () => {
    const host = makeHost();
    const mgr = new ActionableProblems(host);
    mgr.report(problem);
    mgr.resolve("auth:qbittorrent-nas", "qBittorrent accepts the login again");
    expect(host.infos).toEqual(["qBittorrent accepts the login again"]);
    // Cleared-state is observable behaviour: a second resolve is silent.
    mgr.resolve("auth:qbittorrent-nas");
    expect(host.infos).toHaveLength(1);
  });

  it("resolving an unknown / already-cleared problem is a no-op", () => {
    const host = makeHost();
    const mgr = new ActionableProblems(host);
    mgr.resolve("never-reported");
    mgr.report(problem);
    mgr.resolve("auth:qbittorrent-nas");
    mgr.resolve("auth:qbittorrent-nas"); // second resolve — nothing more
    expect(host.infos).toHaveLength(1);
  });

  it("after resolve, the same problem can be surfaced fresh again", () => {
    const host = makeHost();
    const mgr = new ActionableProblems(host);
    mgr.report(problem);
    mgr.resolve("auth:qbittorrent-nas");
    mgr.report(problem);
    expect(host.warns).toHaveLength(2);
    expect(host.notifications).toHaveLength(2);
  });
});
