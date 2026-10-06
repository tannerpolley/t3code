import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Stable GitHub identity retained on historical attempts, even after another thread owns work. */
export const ThreadLinkedIssue = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  repositoryId: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  nodeId: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/[^\s]+$/i)),
  title: Schema.String,
});
export type ThreadLinkedIssue = typeof ThreadLinkedIssue.Type;

/** The issue number survives every rename and every late AI title result. */
export function issueThreadTitle(issue: Pick<ThreadLinkedIssue, "number" | "title">): string {
  const title = issue.title.replaceAll(/\s+/g, " ").trim();
  return `#${issue.number} ${title || "Untitled issue"}`;
}
