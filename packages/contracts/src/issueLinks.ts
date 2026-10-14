import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IssueRef } from "./issue.ts";

export const IssueLinkInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  url: Schema.optional(TrimmedNonEmptyString),
  host: Schema.optional(IssueRef.fields.host),
  repository: Schema.optional(IssueRef.fields.repository),
  number: Schema.optional(IssueRef.fields.number),
});
export type IssueLinkInput = typeof IssueLinkInput.Type;
export const IssueLinkResult = Schema.Struct({
  threadId: ThreadId,
  issue: IssueRef,
  changed: Schema.Boolean,
});
export type IssueLinkResult = typeof IssueLinkResult.Type;
export class IssueLinkError extends Schema.TaggedError<IssueLinkError>()("IssueLinkError", {
  code: Schema.Literals(["invalid-request", "thread-not-found", "storage"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    switch (this.code) {
      case "invalid-request":
        return "Pass a thread and an issue URL, or repository and positive issue number.";
      case "thread-not-found":
        return "The thread is unavailable.";
      case "storage":
        return "Issue links could not be read or saved.";
    }
  }
}
