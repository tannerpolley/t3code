import { assert, it } from "@effect/vitest";

import { ClaudeDriver } from "../provider/Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../provider/Drivers/CodexDriver.ts";
import { supportsManagedIssueWork } from "./IssueEligibility.ts";

it("managed issue work accepts the real Codex and Claude driver kinds", () => {
  assert.isTrue(supportsManagedIssueWork(CodexDriver.driverKind));
  assert.isTrue(supportsManagedIssueWork(ClaudeDriver.driverKind));
});
