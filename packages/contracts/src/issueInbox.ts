import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IssueRef, IssueRepositoryRef } from "./issue.ts";

/**
 * External activity the watcher records for a managed repository. `missed_activity` reports a
 * catch-up larger than one poll reads, as after a long time offline.
 */
export const IssueInboxEventKind = Schema.Literals([
  "issue_opened",
  "comment",
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "milestoned",
  "demilestoned",
  "renamed",
  "missed_activity",
]);
export type IssueInboxEventKind = typeof IssueInboxEventKind.Type;

export const IssueInboxEvent = Schema.Struct({
  id: NonNegativeInt,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  issueNumber: NonNegativeInt,
  issueTitle: Schema.String,
  kind: IssueInboxEventKind,
  author: Schema.NullOr(Schema.String),
  /** The project named by a cross-project source marker. */
  sourceProject: Schema.NullOr(Schema.String),
  tagged: Schema.Boolean,
  highPriority: Schema.Boolean,
  /** An external issue opened outside every milestone. */
  needsTriage: Schema.Boolean,
  url: Schema.String,
  snippet: Schema.String,
  occurredAt: IsoDateTime,
  readAt: Schema.NullOr(IsoDateTime),
});
export type IssueInboxEvent = typeof IssueInboxEvent.Type;

export const IssueInboxListResult = Schema.Struct({ events: Schema.Array(IssueInboxEvent) });
export type IssueInboxListResult = typeof IssueInboxListResult.Type;

export const IssueInboxMarkReadInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  /** Omit to mark every unread event read. */
  ids: Schema.optional(Schema.Array(NonNegativeInt)),
});
export type IssueInboxMarkReadInput = typeof IssueInboxMarkReadInput.Type;

export const IssueInboxMarkReadResult = Schema.Struct({ marked: NonNegativeInt });
export type IssueInboxMarkReadResult = typeof IssueInboxMarkReadResult.Type;

export const IssueInboxUnread = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  rootThreadId: ThreadId,
  unread: NonNegativeInt,
});
export type IssueInboxUnread = typeof IssueInboxUnread.Type;

export const IssueInboxToolInput = Schema.Struct({
  action: Schema.Literals(["list", "read", "mark_read"]),
  /** `read`: the events to read. `mark_read`: the events to mark, or every unread one when omitted. */
  ids: Schema.optional(Schema.Array(NonNegativeInt)),
});
export type IssueInboxToolInput = typeof IssueInboxToolInput.Type;

export const IssueInboxToolResult = Schema.Struct({
  repository: TrimmedNonEmptyString,
  unread: NonNegativeInt,
  events: Schema.Array(IssueInboxEvent),
});
export type IssueInboxToolResult = typeof IssueInboxToolResult.Type;

export const IssuePostInput = Schema.Struct({
  host: Schema.optional(IssueRef.fields.host),
  repository: IssueRef.fields.repository,
  /** Comment on this issue; omit to create an issue. */
  issueNumber: Schema.optional(IssueRef.fields.number),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(60_000)),
});
export type IssuePostInput = typeof IssuePostInput.Type;

export const IssuePostResult = Schema.Struct({
  url: Schema.String,
  issueNumber: IssueRef.fields.number,
  commentId: Schema.NullOr(Schema.String),
  crossProject: Schema.Boolean,
  labels: Schema.Array(Schema.String),
});
export type IssuePostResult = typeof IssuePostResult.Type;
