import { IssueSuspension } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import { ClaudeDriver } from "../provider/Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../provider/Drivers/CodexDriver.ts";
import {
  supportsManagedIssueWork,
  isAutomaticIssueSuspension,
  isOpenBlockerSuspension,
  openBlockerSuspensionReason,
} from "./IssueEligibility.ts";

const decodeSuspension = Schema.decodeSync(IssueSuspension);

it("managed issue work accepts the real Codex and Claude driver kinds", () => {
  assert.isTrue(supportsManagedIssueWork(CodexDriver.driverKind));
  assert.isTrue(supportsManagedIssueWork(ClaudeDriver.driverKind));
});

it("recovers both current and persisted GitHub blocker suspensions", () => {
  for (const reason of [
    openBlockerSuspensionReason,
    "A GitHub blocker is open. Resolve it before resuming.",
  ]) {
    const entry = decodeSuspension({ id: "issue", reason });
    assert.isTrue(isOpenBlockerSuspension(entry));
    assert.isTrue(isAutomaticIssueSuspension(entry));
  }
  assert.isFalse(isAutomaticIssueSuspension({ kind: "closed" }));
});

it("suspension kind owns recovery even when the display reason changes", () => {
  assert.isTrue(
    isAutomaticIssueSuspension(
      decodeSuspension({ id: "issue", kind: "blocked", reason: "Waiting for dependencies" }),
    ),
  );
  assert.isFalse(
    isAutomaticIssueSuspension(
      decodeSuspension({ id: "issue", kind: "closed", reason: openBlockerSuspensionReason }),
    ),
  );
});
