import { expect, it } from "vite-plus/test";

import { lineageStatusMark } from "./ThreadStatusMark";

it("spins for live Lineage statuses, dots finished ones, and marks failures", () => {
  for (const status of ["pending", "running", "in_progress", "waiting", "starting"]) {
    expect(lineageStatusMark(status)).toBe("working");
  }
  expect(lineageStatusMark("completed")).toBe("done");
  expect(lineageStatusMark("failed")).toBe("failed");
  expect(lineageStatusMark("error")).toBe("failed");
  for (const status of ["idle", "cancelled", "interrupted", null]) {
    expect(lineageStatusMark(status)).toBe("ready");
  }
});
