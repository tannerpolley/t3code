import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  ThreadId,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeReturnToRootInput,
  type WorktreeReturnToRootResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

type BindingInput = {
  readonly command: Extract<OrchestrationV2Command, { type: "thread.metadata.update" }>;
  readonly continuationPrompt?: string | undefined;
  readonly continuationMessageId: MessageId;
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
  const random = yield* SecureRandom.SecureRandom;

  // The same command changes the workspace and queues its continuation before detach.
  const bind = Effect.fn("ThreadWorkspaceService.bind")(function* (input: BindingInput) {
    const continuation =
      input.continuationPrompt === undefined
        ? undefined
        : {
            messageId: input.continuationMessageId,
            text: input.continuationPrompt,
            ...input.provenance,
          };
    const binding = yield* threads
      .dispatch({
        ...input.command,
        ...(continuation === undefined ? {} : { continuation }),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(operationFailed(Cause.squash(cause))),
        ),
        Effect.uninterruptible,
      );
    if (continuation === undefined) return { status: "skipped" } as const;
    return {
      status: "scheduled",
      delivery: binding.storedEvents.some(
        ({ event }) => event.type === "run.created" && event.payload.status !== "queued",
      )
        ? "started"
        : "queued",
    } as const;
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
    const uuid = yield* random.uuidV4().pipe(Effect.orDie);
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
      continuationMessageId: MessageId.make(`workspace-root-continuation:${uuid}`),
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
