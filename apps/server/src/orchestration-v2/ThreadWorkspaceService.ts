import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type ProjectId,
  ThreadId,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeReturnToRootInput,
  type WorktreeReturnToRootResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

type BindingInput = {
  readonly command: Extract<OrchestrationV2Command, { type: "thread.metadata.update" }>;
  readonly continuationPrompt?: string | undefined;
  readonly continuationCommandId: CommandId;
  readonly continuationMessageId: MessageId;
  readonly projectId: ProjectId;
  readonly provenance: ThreadManagementService.ThreadManagementProvenance;
};

export class ThreadWorkspaceService extends Context.Service<
  ThreadWorkspaceService,
  {
    readonly bind: (
      input: BindingInput,
    ) => Effect.Effect<WorktreeMcpContinuationStatus, WorktreeMcpFailure>;
    readonly returnToRoot: (
      threadId: ThreadId,
      input: WorktreeReturnToRootInput,
      provenance: ThreadManagementService.ThreadManagementProvenance,
    ) => Effect.Effect<WorktreeReturnToRootResult, WorktreeMcpFailure>;
  }
>()("t3/orchestration-v2/ThreadWorkspaceService") {}

const operationFailed = (cause: unknown) =>
  new WorktreeMcpFailure({
    code: "operation_failed",
    message: cause instanceof Error ? cause.message : "Unable to change the thread workspace.",
  });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const crypto = yield* Crypto.Crypto;

  // Both directions use the metadata command's serialized safety checks and detach effect.
  // Keep the continuation durable before the detach can interrupt the caller's request.
  const bind = Effect.fn("ThreadWorkspaceService.bind")(function* (input: BindingInput) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* threads
          .dispatch(input.command)
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause as Cause.Cause<never>)
                : Effect.fail(operationFailed(Cause.squash(cause))),
            ),
          );
        if (input.continuationPrompt === undefined) return { status: "skipped" } as const;
        return yield* threads
          .sendToThread({
            projectId: input.projectId,
            commandId: input.continuationCommandId,
            threadId: input.command.threadId,
            messageId: input.continuationMessageId,
            text: input.continuationPrompt,
            attachments: [],
            mode: "queue",
            ...input.provenance,
          })
          .pipe(
            Effect.map((result): WorktreeMcpContinuationStatus => ({
              status: "scheduled",
              delivery: result.delivery,
            })),
            Effect.catchCause((cause) =>
              Effect.logWarning("Workspace continuation failed to queue", {
                threadId: input.command.threadId,
              }).pipe(
                Effect.as({
                  status: "failed",
                  detail: operationFailed(Cause.squash(cause)).message,
                } as const),
              ),
            ),
          );
      }),
    );
  });

  const returnToRoot = Effect.fn("ThreadWorkspaceService.returnToRoot")(function* (
    threadId: ThreadId,
    input: WorktreeReturnToRootInput,
    provenance: ThreadManagementService.ThreadManagementProvenance,
  ) {
    const { thread } = yield* threads
      .getThreadRecords(threadId, [])
      .pipe(Effect.mapError(operationFailed));
    if (thread.deletedAt !== null)
      return yield* new WorktreeMcpFailure({
        code: "thread_not_found",
        message: `Thread '${threadId}' was not found.`,
      });
    if (thread.worktreePath === null)
      return yield* new WorktreeMcpFailure({
        code: "invalid_request",
        message: `Thread '${threadId}' is already in the project's main checkout.`,
      });
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.mapError(operationFailed));
    if (Option.isNone(project))
      return yield* new WorktreeMcpFailure({
        code: "project_not_found",
        message: `Project '${thread.projectId}' was not found.`,
      });
    const projectWorkspaceRoot = project.value.workspaceRoot;
    yield* git.invalidateLocalStatus(projectWorkspaceRoot);
    const status = yield* git
      .localStatus({ cwd: projectWorkspaceRoot })
      .pipe(Effect.mapError(operationFailed));
    if (!status.isRepo)
      return yield* new WorktreeMcpFailure({
        code: "invalid_request",
        message: `Project workspace '${projectWorkspaceRoot}' is not a git repository.`,
      });
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const continuation = yield* bind({
      command: {
        type: "thread.metadata.update",
        commandId: CommandId.make(`workspace-root:${uuid}`),
        threadId,
        branch: status.refName,
        worktreePath: null,
        expectedWorktreePath: thread.worktreePath,
      },
      ...input,
      continuationCommandId: CommandId.make(`workspace-root-continuation:${uuid}`),
      continuationMessageId: MessageId.make(`workspace-root-continuation:${uuid}`),
      projectId: thread.projectId,
      provenance,
    });
    return {
      projectWorkspaceRoot,
      worktreePath: null,
      branch: status.refName,
      continuation,
      note: "Moved to the project's main checkout. Changing the workspace detaches the live provider session, so the current turn ends shortly after this call. The conversation resumes there on the next message. The previous worktree is kept.",
    } satisfies WorktreeReturnToRootResult;
  });

  return ThreadWorkspaceService.of({ bind, returnToRoot });
});

export const layer = Layer.effect(ThreadWorkspaceService, make);
