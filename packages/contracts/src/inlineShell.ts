import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString, IsoDateTime } from "./baseSchemas.ts";

export const INLINE_SHELL_OUTPUT_LINES = 200;
export const INLINE_SHELL_OUTPUT_BYTES = 16_384;
export const InlineShellLanguage = Schema.Literals([
  "sh",
  "bash",
  "zsh",
  "fish",
  "shell",
  "powershell",
  "pwsh",
]);
export type InlineShellLanguage = typeof InlineShellLanguage.Type;

export const InlineShellRunInput = Schema.Struct({
  threadId: ThreadId,
  runId: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9-]{1,64}$/i)),
  blockId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  language: InlineShellLanguage,
});
export type InlineShellRunInput = typeof InlineShellRunInput.Type;

export const InlineShellRunLookupInput = Schema.Struct({
  threadId: ThreadId,
  blockId: InlineShellRunInput.fields.blockId,
});
export type InlineShellRunLookupInput = typeof InlineShellRunLookupInput.Type;

export const InlineShellRunRecord = Schema.Struct({
  ...InlineShellRunInput.fields,
  terminalId: TrimmedNonEmptyString,
  status: Schema.Literals(["running", "completed", "interrupted", "error"]),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  output: Schema.String.check(Schema.isMaxLength(INLINE_SHELL_OUTPUT_BYTES)),
});
export type InlineShellRunRecord = typeof InlineShellRunRecord.Type;

export class InlineShellRunError extends Schema.TaggedError<InlineShellRunError>()(
  "InlineShellRunError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return "Could not run the shell block in this project thread.";
  }
}
