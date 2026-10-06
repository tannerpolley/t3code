import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadLinkedIssue } from "./threadIssue.ts";

export const IssueGithubCommentOperation = Schema.Literals(["status_sync", "closeout_create"]);

/** Receipt event used to rebuild the comment IDs needed for safe retries. */
export const IssueGithubCommentRecorded = Schema.Struct({
  operation: IssueGithubCommentOperation,
  issue: ThreadLinkedIssue,
  threadId: ThreadId,
  writeKey: TrimmedNonEmptyString,
  resultEventId: Schema.optional(TrimmedNonEmptyString),
  commentId: TrimmedNonEmptyString,
  marker: TrimmedNonEmptyString,
});
export type IssueGithubCommentRecorded = typeof IssueGithubCommentRecorded.Type;
