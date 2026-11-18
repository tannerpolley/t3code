import * as Schema from "effect/Schema";

export class IssueLinkError extends Schema.TaggedError<IssueLinkError>()("IssueLinkError", {
  code: Schema.Literals(["storage"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return "Issue links could not be read.";
  }
}
