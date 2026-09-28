import { STATUSES } from "./model";

describe("model", () => {
  it("keeps the one status list the plan and the preview agreed on, in display order", () => {
    expect(STATUSES).toEqual([
      "queued",
      "downloading",
      "waiting",
      "paused",
      "checking",
      "postprocessing",
      "seeding",
      "completed",
      "failed",
    ]);
  });
});
