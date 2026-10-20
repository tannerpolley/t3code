import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IssueRef } from "./issue.ts";

export const IssueCleanupInput = Schema.Struct({
  ...IssueRef.fields,
  threadId: ThreadId,
  action: Schema.Literal("delete-branch"),
  expectedBranch: Schema.NullOr(TrimmedNonEmptyString),
  expectedWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  confirmed: Schema.Boolean,
  confirmUnmerged: Schema.Boolean,
});
export type IssueCleanupInput = typeof IssueCleanupInput.Type;

export class IssueCleanupError extends Schema.TaggedError<IssueCleanupError>()(
  "IssueCleanupError",
  {
    code: Schema.Literals([
      "confirmation-required",
      "work-changed",
      "not-closed",
      "work-active",
      "checked-out",
      "unmerged",
      "unavailable",
    ]),
    worktreeName: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "confirmation-required":
        return "Confirm before removing local issue work.";
      case "work-changed":
        return "The issue's local work changed. Refresh before trying again.";
      case "not-closed":
        return "Close the issue before cleaning up its local work.";
      case "work-active":
        return "Stop the issue's worker before cleaning up its local work.";
      case "checked-out":
        return `Checked out in ${this.worktreeName ?? "a worktree"}; remove the worktree or switch its branch first.`;
      case "unmerged":
        return "This branch contains work without a verified merged pull request. Confirm deleting unmerged work to continue.";
      case "unavailable":
        return "Could not verify or remove the issue's local work. Refresh and try again.";
    }
  }
}
