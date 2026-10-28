import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

export const NOTEBOOK_LIMITS = {
  bytes: 8 * 1024 * 1024,
  cells: 500,
  outputs: 100,
  frameBytes: 1024 * 1024,
  sessions: 16,
} as const;
export class NotebookError extends Schema.TaggedError<NotebookError>()("NotebookError", {
  reason: Schema.Literals([
    "unavailable",
    "invalid-document",
    "permission-denied",
    "not-found",
    "busy",
    "stale-revision",
    "stale-generation",
    "disconnected",
    "kernel-failure",
    "output-limit",
    "invalid-path",
    "save-conflict",
  ]),
}) {
  override get message() {
    return `Notebook operation failed: ${this.reason}.`;
  }
}
// The JSON record owns unknown nbformat fields; preview models must never be saved.
export const NotebookDocument = Schema.Record(Schema.String, Schema.Unknown);
export type NotebookDocument = typeof NotebookDocument.Type;
export const NotebookIdentity = Schema.Struct({
  projectId: ProjectId,
  relativePath: Schema.String,
});
export type NotebookIdentity = typeof NotebookIdentity.Type;
export const NotebookHandle = Schema.Struct({ projectId: ProjectId, handle: Schema.String });
export type NotebookHandle = typeof NotebookHandle.Type;
export const NotebookExecute = Schema.Struct({
  ...NotebookHandle.fields,
  revision: Schema.Int,
  cellIds: Schema.Array(Schema.String),
  requestId: Schema.String,
});
export type NotebookExecute = typeof NotebookExecute.Type;
export const NotebookControl = Schema.Struct({ ...NotebookHandle.fields, generation: Schema.Int });
export type NotebookControl = typeof NotebookControl.Type;
export const NotebookInterrupt = Schema.Struct({ ...NotebookControl.fields, runId: Schema.String });
export type NotebookInterrupt = typeof NotebookInterrupt.Type;
const NotebookExecution = Schema.Struct({
  replyStatus: Schema.optional(Schema.String),
  runId: Schema.String,
  generation: Schema.Int,
  sourceHash: Schema.String,
  sourceRevision: Schema.Int,
});
export const NotebookSnapshot = Schema.Struct({
  handle: Schema.String,
  epoch: Schema.String,
  sequence: Schema.Int,
  revision: Schema.Int,
  diskHash: Schema.String,
  savedRevision: Schema.Int,
  idleDeadline: Schema.NullOr(Schema.Number),
  availability: Schema.Literals(["available", "unavailable"]),
  environment: Schema.Literals(["unverified", "verified"]),
  executions: Schema.Record(Schema.String, NotebookExecution),
  generation: Schema.Int,
  document: NotebookDocument,
  kernel: Schema.Literals(["stopped", "idle", "busy", "unknown"]),
  runId: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["none", "running", "ok", "error", "aborted", "unknown"]),
  truncated: Schema.Boolean,
});
export type NotebookSnapshot = typeof NotebookSnapshot.Type;
export const NotebookOutputPatch = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("execution"),
    cellId: Schema.String,
    count: Schema.NullOr(Schema.Int),
    execution: NotebookExecution,
  }),
  Schema.Struct({ type: Schema.Literal("clear"), cellId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("count"), cellId: Schema.String, count: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("append"),
    cellId: Schema.String,
    output: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("stream"), cellId: Schema.String, text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("replace"),
    cellId: Schema.String,
    index: Schema.Int,
    output: Schema.Record(Schema.String, Schema.Unknown),
  }),
]);
export type NotebookOutputPatch = typeof NotebookOutputPatch.Type;
export const NotebookEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("resync-required"),
    epoch: Schema.String,
    sequence: Schema.Int,
  }),
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: NotebookSnapshot }),
  Schema.Struct({
    type: Schema.Literal("changed"),
    patches: Schema.Array(NotebookOutputPatch),
    kernel: NotebookSnapshot.fields.kernel,
    outcome: NotebookSnapshot.fields.outcome,
    truncated: Schema.Boolean,
    savedRevision: Schema.Int,
    diskHash: Schema.String,
    idleDeadline: Schema.NullOr(Schema.Number),
    availability: NotebookSnapshot.fields.availability,
    environment: NotebookSnapshot.fields.environment,
    epoch: Schema.String,
    sequence: Schema.Int,
    revision: Schema.Int,
    generation: Schema.Int,
    runId: Schema.NullOr(Schema.String),
    cellId: Schema.NullOr(Schema.String),
  }),
]);
export type NotebookEvent = typeof NotebookEvent.Type;

export const NotebookSave = Schema.Struct({
  ...NotebookHandle.fields,
  revision: Schema.Int,
  diskHash: Schema.String,
});
export type NotebookSave = typeof NotebookSave.Type;
export const NotebookEdit = Schema.Struct({
  ...NotebookHandle.fields,
  revision: Schema.Int,
  document: NotebookDocument,
});
export type NotebookEdit = typeof NotebookEdit.Type;
export const NotebookCreate = Schema.Struct({
  ...NotebookIdentity.fields,
  document: NotebookDocument,
});
export type NotebookCreate = typeof NotebookCreate.Type;
export const NotebookLease = Schema.Struct({ ...NotebookHandle.fields, leaseId: Schema.String });
export type NotebookLease = typeof NotebookLease.Type;

export const NotebookSubscribe = Schema.Struct({
  ...NotebookHandle.fields,
  leaseId: Schema.optional(Schema.String),
});
export type NotebookSubscribe = typeof NotebookSubscribe.Type;
