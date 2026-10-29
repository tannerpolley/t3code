import {
  OrchestratorMcpFailure,
  NotebookDocument,
  NotebookEditCells,
  NotebookSnapshot,
  NotebookKernelList,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
const path = {
  relativePath: Schema.String.annotate({
    description:
      "Project-relative .ipynb path in the authenticated calling thread's workspace; no absolute paths.",
  }),
};
const handle = { handle: Schema.String };
const revision = { revision: Schema.Int };
const control = { ...handle, generation: Schema.Int };
const page = { cursor: Schema.Int, byteLimit: Schema.Int };
export const NotebookToolkit = Toolkit.make(
  Tool.make("notebook_open", {
    ...shared,
    description:
      "Read an existing notebook and its full document, stable cell IDs, revision, diskHash and kernel status. Does not start a kernel. Uses the calling thread's project and workspace, including scheduled agents.",
    parameters: Schema.Struct(path),
    success: NotebookSnapshot,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("notebook_create", {
    ...shared,
    description:
      "Create and save a valid nbformat 4 notebook without overwriting an existing file. Supply the full document with metadata and initial cells. Does not execute code; use notebook_run explicitly.",
    parameters: Schema.Struct({ ...path, document: NotebookDocument }),
    success: NotebookSnapshot,
  }).annotate(Tool.Destructive, false),
  Tool.make("notebook_edit_cells", {
    ...shared,
    description:
      "Apply ordered insert/update/delete/move operations to stable notebook cells at the expected revision. Updates replace source and preserve metadata and outputs; old output provenance remains visible. Edits stay in the service draft until notebook_save. Rejects active runs and stale revisions.",
    parameters: Schema.Struct({
      ...handle,
      ...revision,
      operations: NotebookEditCells.fields.operations,
    }),
    success: NotebookSnapshot,
  }).annotate(Tool.Destructive, false),
  Tool.make("notebook_run", {
    ...shared,
    description:
      "Explicitly execute selected code cell IDs, or all=true for every code cell in document order. Supply expected revision and unique requestId (reuse only for identical retries). Returns runId promptly. Never rerun an unknown outcome: inspect outputs then explicitly restart or shutdown to recover. Requires execution permission.",
    parameters: Schema.Struct({
      ...handle,
      ...revision,
      cellIds: Schema.optional(Schema.Array(Schema.String)),
      all: Schema.optional(Schema.Boolean),
      requestId: Schema.String,
    }),
    success: Schema.Struct({ runId: Schema.String }),
  }).annotate(Tool.Destructive, false),
  Tool.make("notebook_read_outputs", {
    ...shared,
    description:
      "Read one cell's bounded output page plus run status, source/generation provenance and truncation. cursor starts at 0; byteLimit is 1..1048576. nextCursor=null ends the page sequence. afterSequence optionally waits up to 25 seconds for a service update; use the returned sequence for event waits instead of busy polling. A page too small for one output returns output-limit; increase byteLimit.",
    parameters: Schema.Struct({
      ...handle,
      cellId: Schema.String,
      ...page,
      afterSequence: Schema.optional(Schema.Int),
    }),
    success: Schema.Unknown,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("notebook_list_kernels", {
    ...shared,
    description:
      "List configured kernel spec names and this project's owned running notebooks in the calling thread's workspace. Returns status, generation, interpreter verification and idle deadline, never credentials. cursor=0 and limit=1..100 paginate owned kernels. Does not start kernels or discover unrelated servers.",
    parameters: Schema.Struct({ cursor: Schema.Int, limit: Schema.Int }),
    success: NotebookKernelList,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("notebook_save", {
    ...shared,
    description:
      "Atomically save the service-owned notebook with its outputs and metadata. Pass current revision and base diskHash from notebook_open/create or the last save. Conflicts retain the draft; never overwrite external edits blindly.",
    parameters: Schema.Struct({ ...handle, ...revision, diskHash: Schema.String }),
    success: NotebookSnapshot,
  }).annotate(Tool.Destructive, false),
  Tool.make("notebook_interrupt", {
    ...shared,
    description:
      "Interrupt the active run and cancel its undispatched cells. Pass runId and current generation. Acknowledgement is not completion: wait through notebook_read_outputs.",
    parameters: Schema.Struct({ ...control, runId: Schema.String }),
    success: Schema.Void,
  }).annotate(Tool.Destructive, false),
  Tool.make("notebook_restart", {
    ...shared,
    description:
      "Explicitly restart the owned kernel at the expected generation, clearing variables and resolving unknown execution state. Preserves draft outputs with their previous-generation provenance. Does not rerun code.",
    parameters: Schema.Struct(control),
    success: Schema.Void,
  }).annotate(Tool.Destructive, true),
  Tool.make("notebook_shutdown", {
    ...shared,
    description:
      "Shut down only this notebook's owned kernel at the expected generation, including recovery from unknown outcomes. Retains the draft and outputs for notebook_save. Does not stop the Jupyter server.",
    parameters: Schema.Struct(control),
    success: Schema.Void,
  }).annotate(Tool.Destructive, true),
);
