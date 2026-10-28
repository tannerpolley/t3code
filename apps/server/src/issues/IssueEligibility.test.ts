import { assert, it } from "@effect/vitest";

import { ClaudeDriver } from "../provider/Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../provider/Drivers/CodexDriver.ts";
import {
  supportsManagedIssueWork,
  isAutomaticIssueSuspension,
  isOpenBlockerSuspension,
  openBlockerSuspensionReason,
} from "./IssueEligibility.ts";

it("managed issue work accepts the real Codex and Claude driver kinds", () => {
  assert.isTrue(supportsManagedIssueWork(CodexDriver.driverKind));
  assert.isTrue(supportsManagedIssueWork(ClaudeDriver.driverKind));
});

it("recovers both current and persisted GitHub blocker suspensions", () => {
  for (const reason of [
    openBlockerSuspensionReason,
    "A GitHub blocker is open. Resolve it before resuming.",
  ]) {
    assert.isTrue(isOpenBlockerSuspension(reason));
    assert.isTrue(isAutomaticIssueSuspension(reason));
  }
  assert.isFalse(isAutomaticIssueSuspension("Paused by owner"));
});
