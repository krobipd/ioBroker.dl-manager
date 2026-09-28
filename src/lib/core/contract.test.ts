import { runDriverContract } from "../../../test/helpers/contract";
import { FakeProgramDriver, mapFakeStatus, startFakeProgram } from "../../../test/helpers/fake-program";

// The contract suite run against a minimal fake program — proves the suite itself before any real driver uses it.
runDriverContract({
  type: "fake",
  server: startFakeProgram,
  makeDriver: (baseUrl, creds) => new FakeProgramDriver(baseUrl, "admin", creds.good ? "good" : "bad"),
  mapStatus: mapFakeStatus,
  statusTable: [
    ["q", "queued"],
    ["dl", "downloading"],
    ["stop", "paused"],
    ["done", "completed"],
    ["err", "failed"],
  ],
  unknownStatus: "somethingNew",
  commandCalls: {
    pauseAll: { method: "POST", path: "/pause", bodyContains: "{}" },
    resumeAll: { method: "POST", path: "/resume", bodyContains: "{}" },
    pause: { method: "POST", path: "/pause", bodyContains: '"id":"a1b2c3d4e5"' },
    resume: { method: "POST", path: "/resume", bodyContains: '"id":"a1b2c3d4e5"' },
    remove: { method: "POST", path: "/remove", bodyContains: '"id":"a1b2c3d4e5"' },
    add: { method: "POST", path: "/add", bodyContains: "magnet:" },
  },
  isLoginCall: call => call.path === "/login",
});
