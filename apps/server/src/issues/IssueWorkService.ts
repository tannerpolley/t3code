import {
  CommandId,
  ThreadId,
  type IssueQueueInput,
  type OrchestrationV2ServerCommand,
  DEFAULT_REPOSITORY_WORK_SETTINGS,
  IssueWorkError,
  type IssueRef,
  type IssueWorkStartInput,
  type IssueWorkCancelInput,
  type IssueWorkRequested,
  type RepositoryWorkRestoreInput,
  type IssueWorkStartResult,
  type IssueWorkStatusResult,
  type ModelSelection,
  type RepositoryWorkInput,
  type RepositoryWorkControlInput,
  RepositoryWorkerLimitInput,
  type RepositoryHandoffInput,
  type RepositoryHandoffRequestInput,
  type RepositoryWorkResult,
  type RepositoryOrchestration,
  type ProjectId,
  type IssueWorkRead,
  type ThreadLinkedIssue,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import { agentWorktreeName } from "@t3tools/shared/git";
import {
  OrchestratorCommandRejectedError,
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
  type OrchestratorV2DispatchResult,
} from "../orchestration-v2/Orchestrator.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { pullRequestHostOf } from "@t3tools/contracts";
import { ProjectService } from "../project/ProjectService.ts";
import * as Layer from "effect/Layer";
import { IssueService } from "./IssueService.ts";
import { IssueWorkStore } from "./IssueWorkStore.ts";
import { deriveIssueWorkStatus } from "./IssueWorkStatus.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import {
  ThreadManagementService,
  ThreadManagementProviderInstanceDisabledError,
} from "../orchestration-v2/ThreadManagementService.ts";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { checkDelegateTarget } from "../mcp/delegateTaskTarget.ts";
import {
  issueEligibility,
  sameIssueRepository,
  supportsManagedIssueWork,
  issueScopeExpansionError,
  openBlockerSuspensionReason,
} from "./IssueEligibility.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

const decodeWorkerLimit = Schema.decodeEffect(RepositoryWorkerLimitInput);
const encodeToolArgument = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class IssueWorkService extends Context.Service<
  IssueWorkService,
  {
    readonly queueIssue: (
      input: IssueQueueInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly unqueueIssue: (
      input: IssueQueueInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly start: (
      input: IssueWorkStartInput,
    ) => Effect.Effect<IssueWorkStartResult, IssueWorkError>;
    readonly startWorker: (
      command: Extract<
        OrchestrationV2ServerCommand,
        { type: "issue.work.start" | "delegated_task.request" }
      >,
    ) => Effect.Effect<
      OrchestratorV2DispatchResult,
      IssueWorkError | ThreadManagementProviderInstanceDisabledError
    >;
    /** User-only recovery. Cancellation never interrupts a claimed worker. */
    readonly cancelRequest: (
      input: IssueWorkCancelInput,
    ) => Effect.Effect<IssueWorkRequested, IssueWorkError>;
    readonly restoreRoot: (
      input: RepositoryWorkRestoreInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly workStatus: (input: IssueRef) => Effect.Effect<IssueWorkStatusResult, IssueWorkError>;
    readonly workMilestone: (
      input: RepositoryWorkInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly repositoryStatus: (
      input: Pick<IssueRef, "host" | "repository">,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly setWorkerLimit: (
      input: RepositoryWorkerLimitInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly setPaused: (
      input: RepositoryWorkControlInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly assertCurrentCaller: (threadId: ThreadId) => Effect.Effect<void, IssueWorkError>;
    readonly requestHandoff: (
      threadId: ThreadId,
      input: RepositoryHandoffRequestInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    /** User-only entry point. MCP can request a transfer, but cannot approve it. */
    readonly handoff: (
      input: RepositoryHandoffInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly reconcile: (rootThreadId: ThreadId) => Effect.Effect<void, IssueWorkError>;
  }
>()("t3/issues/IssueWorkService") {}

const isIssueWorkError = Schema.is(IssueWorkError);
const isCommandRejectedError = Schema.is(OrchestratorCommandRejectedError);
const isPreviouslyRejectedError = Schema.is(OrchestratorCommandPreviouslyRejectedError);
const isDispatchError = Schema.is(OrchestratorDispatchError);
const isProviderDisabledError = Schema.is(ThreadManagementProviderInstanceDisabledError);

export const layer = Layer.effect(
  IssueWorkService,
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    const issues = yield* IssueService;
    const store = yield* IssueWorkStore;
    const launch = yield* ThreadLaunchService;
    const threads = yield* ThreadManagementService;
    const settings = yield* ServerSettingsService;
    const providers = yield* ProviderRegistry;
    const adapters = yield* ProviderAdapterRegistryV2;
    const ids = yield* IdAllocatorV2;
    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const mapError = (cause: unknown) =>
      isIssueWorkError(cause)
        ? cause
        : new IssueWorkError({
            code:
              isCommandRejectedError(cause) ||
              isPreviouslyRejectedError(cause) ||
              (isDispatchError(cause) &&
                (cause.detail !== undefined || typeof cause.cause === "string"))
                ? "invalid-request"
                : "orchestration-error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const assertRootCheckout = (input: {
      projectId: ProjectId;
      commandId: CommandId;
      worktreePath: string | null;
    }) =>
      Effect.gen(function* () {
        const expectedBranch = yield* launch
          .readDefaultBranch(input)
          .pipe(Effect.mapError(mapError));
        if (
          input.worktreePath !== null ||
          (yield* launch.readCheckoutBranch(input).pipe(Effect.mapError(mapError))) !==
            expectedBranch
        )
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: `The repository orchestrator requires the main checkout on the default branch (${expectedBranch}).`,
          });
        return expectedBranch;
      });
    const progressFor = (threadId: Parameters<typeof threads.getThreadShell>[0], paused: boolean) =>
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(threadId);
        const projection = yield* threads.getThreadRecords(threadId, [
          "runs",
          "messages",
          "subagents",
          "runtimeRequests",
        ]);
        const progress = delegatedTaskProgress({
          ...projection,
          pendingBackgroundTasks: shell?.pendingBackgroundTasks ?? [],
        });
        return {
          shell,
          progress,
          status: deriveIssueWorkStatus({
            shell,
            paused,
            runtimeRequests: projection.runtimeRequests,
            waitingOnSubIssues: progress.state === "waiting_for_children",
            resultAvailable: progress.state === "result_available",
          }),
        };
      }).pipe(Effect.mapError(mapError));

    const assertProjectRepository = Effect.fn("IssueWorkService.assertProjectRepository")(
      function* (
        projectId: import("@t3tools/contracts").ProjectId,
        repositoryRef: Pick<IssueRef, "host" | "repository">,
      ) {
        const project = yield* projects.getById(projectId).pipe(Effect.mapError(mapError));
        const identity = Option.isSome(project) ? project.value.repositoryIdentity : null;
        const repository =
          identity?.origin?.displayName ?? sourceControlRepositorySelector(identity);
        const upstream = sourceControlRepositorySelector(identity);
        if (
          identity?.provider !== "github" ||
          pullRequestHostOf(identity, SourceControlProviderKind.make("github")).toLowerCase() !==
            repositoryRef.host.toLowerCase() ||
          (repository?.toLowerCase() !== repositoryRef.repository.toLowerCase() &&
            upstream?.toLowerCase() !== repositoryRef.repository.toLowerCase())
        )
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "Select a project whose GitHub repository matches this issue.",
          });
      },
    );

    const ensureRoot = (
      input: Pick<
        IssueWorkStartInput,
        | "projectId"
        | "modelRoleId"
        | "orchestratorThreadId"
        | "createOrchestrator"
        | "clientRequestId"
      >,
      issue: Pick<ThreadLinkedIssue, "host" | "repository" | "repositoryId">,
      requireExplicitRoot = false,
    ) =>
      Effect.gen(function* () {
        if (input.orchestratorThreadId !== undefined && input.createOrchestrator === true)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "Choose either an existing orchestrator or creation of the first one.",
          });
        let root = yield* store.repositoryOwner(issue);
        if (root !== null && root.projectId !== input.projectId)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message:
              "This repository already uses another project. Select the registered orchestrator project.",
          });
        if (
          root !== null &&
          input.orchestratorThreadId !== undefined &&
          input.orchestratorThreadId !== root.rootThreadId
        )
          return yield* new IssueWorkError({
            code: "repository-owner-conflict",
            message:
              "A different repository orchestrator is already registered. Use it, or explicitly restore ownership first.",
          });
        if (root?.paused)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "Repository work is paused.",
          });
        const roles = (yield* settings.getSettings.pipe(Effect.mapError(mapError))).modelRoles;
        const role = roles.find((entry) => entry.id === input.modelRoleId);
        if (role === undefined)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "The selected model role no longer exists.",
          });
        const availableProviders = yield* providers.getProviders;
        const capableIds = new Set<import("@t3tools/contracts").ProviderInstanceId>();
        for (const instanceId of yield* adapters.list()) {
          const adapter = yield* adapters.get(instanceId).pipe(Effect.mapError(mapError));
          if (supportsManagedIssueWork(adapter.driver)) capableIds.add(instanceId);
        }
        let selection: ModelSelection | undefined;
        let rejection: string | undefined;
        for (const target of role.targets) {
          const model = checkDelegateTarget({
            providers: availableProviders,
            orchestrationCapableInstanceIds: capableIds,
            instanceId: target.providerInstanceId,
            requestedModel: target.model,
            inheritedModel: undefined,
            options: target.options,
          });
          if (typeof model === "string") {
            selection = {
              instanceId: target.providerInstanceId,
              model,
              ...(target.options === undefined ? {} : { options: target.options }),
            };
            break;
          }
          rejection = model.message;
        }
        if (selection === undefined)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: `Managed issue work requires an available Codex or Claude target in the selected model role${rejection === undefined ? "" : ` (${rejection})`}.`,
          });
        if (
          root === null &&
          requireExplicitRoot &&
          input.orchestratorThreadId === undefined &&
          input.createOrchestrator !== true
        )
          return yield* new IssueWorkError({
            code: "invalid-request",
            message:
              "Select an existing repository orchestrator or explicitly create the first one before starting issue work.",
          });
        if (root === null && input.orchestratorThreadId !== undefined) {
          const selectedLead = input.orchestratorThreadId;
          // Scoped to this Start request, so a fresh request re-checks a corrected lead.
          yield* restoreRoot({
            ...issue,
            projectId: input.projectId,
            expectedRootThreadId: null,
            expectedRevision: null,
            targetThreadId: selectedLead,
            reason: "User selected this existing lead for issue work",
            clientRequestId: CommandId.make(`${input.clientRequestId}:adopt-root`),
          }).pipe(
            // A concurrent Start that registered the same lead is this request's success too.
            Effect.catch((error) =>
              store
                .repositoryOwner(issue)
                .pipe(
                  Effect.flatMap((owner) =>
                    owner?.rootThreadId === selectedLead ? Effect.void : Effect.fail(error),
                  ),
                ),
            ),
          );
          root = yield* store.repositoryOwner(issue);
          if (root?.rootThreadId !== input.orchestratorThreadId)
            return yield* new IssueWorkError({
              code: "repository-owner-conflict",
              message: "Repository ownership changed while registering the selected lead.",
            });
        }
        let createdRoot = false;
        if (root === null) {
          yield* assertProjectRepository(input.projectId, issue);
          const rootBranch = yield* assertRootCheckout({
            projectId: input.projectId,
            commandId: input.clientRequestId,
            worktreePath: null,
          });
          // All projects pointing at this repository share a command identity. The
          // serialized receipt and unique projected repository key are the lock.
          const commandId = CommandId.make(`issue-root:${issue.host}:${issue.repositoryId}`);
          const orchestratorRole = roles.find((entry) => entry.id === "orchestrator");
          let rootSelection = selection;
          for (const target of orchestratorRole?.targets ?? []) {
            const model = checkDelegateTarget({
              providers: availableProviders,
              orchestrationCapableInstanceIds: capableIds,
              instanceId: target.providerInstanceId,
              requestedModel: target.model,
              inheritedModel: undefined,
              options: target.options,
            });
            if (typeof model === "string") {
              rootSelection = {
                instanceId: target.providerInstanceId,
                model,
                ...(target.options === undefined ? {} : { options: target.options }),
              };
              break;
            }
          }
          const launched = yield* launch
            .launch({
              commandId,
              threadId: ids.derive.delegatedTaskThread({ commandId }),
              projectId: input.projectId,
              title: `${issue.repository} orchestrator`,
              modelSelection: rootSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root", branch: rootBranch },
              repositoryOrchestration: {
                host: issue.host,
                repository: issue.repository,
                repositoryId: issue.repositoryId,
                projectId: input.projectId,
                launchCommandId: commandId,
                revision: 1,
                paused: false,
                ...DEFAULT_REPOSITORY_WORK_SETTINGS,
                milestones: [],
                suspendedIssues: [],
              },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const recovered = yield* store.repositoryOwner(issue);
                  if (recovered === null) return yield* mapError(error);
                  return { threadId: recovered.rootThreadId, resumed: true };
                }),
              ),
              Effect.mapError(mapError),
            );
          root = yield* store.repositoryOwner(issue);
          if (root === null)
            return yield* new IssueWorkError({
              code: "orchestration-error",
              message: "Root creation did not record repository ownership.",
            });
          if (root.projectId !== input.projectId)
            return yield* new IssueWorkError({
              code: "invalid-request",
              message:
                "A concurrent start registered another project. Select the registered orchestrator project.",
            });
          createdRoot = !launched.resumed;
        }
        return { root, selection, createdRoot };
      });

    // Every issue admission prepares its own default-branch worktree after commit.
    const startWorker: IssueWorkService["Service"]["startWorker"] = Effect.fn(
      "IssueWorkService.startWorker",
    )(function* (command) {
      if (command.issue === undefined)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Managed workers require an issue.",
        });
      const owner = yield* store.repositoryOwner(command.issue);
      const config = owner === null ? null : yield* store.configuration(owner.rootThreadId);
      if (owner === null || config === null)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "The repository orchestrator is unavailable.",
        });
      let worktree: { baseRef: string; branch: string } | undefined;
      if (!(yield* threads.hasReceipt(command.commandId))) {
        const baseRef = yield* launch
          .readDefaultBranch({ commandId: command.commandId, projectId: config.projectId })
          .pipe(Effect.mapError(mapError));
        worktree = {
          baseRef,
          branch: agentWorktreeName(command.issue.title, command.issue.number),
        };
      }
      const dispatched = yield* threads
        .dispatch({
          ...command,
          ...(worktree === undefined
            ? {}
            : command.type === "issue.work.start"
              ? { issueWorktree: worktree }
              : { workspaceStrategy: { type: "worktree" as const, ...worktree } }),
        })
        .pipe(
          Effect.mapError((cause) => (isProviderDisabledError(cause) ? cause : mapError(cause))),
        );
      const childId = dispatched.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      )?.event;
      if (childId?.type === "subagent.updated" && childId.payload.childThreadId !== null) {
        const child = yield* threads
          .getThreadRecords(childId.payload.childThreadId, ["runs"])
          .pipe(Effect.mapError(mapError));
        const run = child.runs.find(
          (candidate) =>
            candidate.status === "preparing" && candidate.workspacePreparation !== undefined,
        );
        if (run?.workspacePreparation !== undefined)
          yield* launch.prepareRun({
            commandId: run.workspacePreparationCommandId ?? command.commandId,
            threadId: child.thread.id,
            runId: run.id,
          });
      }
      return dispatched;
    });

    const start = (
      input: IssueWorkStartInput,
    ): Effect.Effect<IssueWorkStartResult, IssueWorkError> =>
      Effect.gen(function* () {
        // An accepted operation remains replayable even if GitHub changed afterward.
        const accepted = yield* store.request(input.clientRequestId);
        if (accepted === null) {
          const read = yield* issues.workRead(input).pipe(Effect.mapError(mapError));
          if (issueEligibility(read) !== "eligible")
            return yield* new IssueWorkError({
              code: "issue-unavailable",
              message: "Issue work is closed, blocked, or its eligibility is unknown.",
            });
          const seen = new Set([read.issue.id]);
          let ancestor = read;
          const ancestors: IssueWorkRead[] = [];
          while (ancestor.parent !== null) {
            if (!sameIssueRepository(ancestor.parent, read.issue))
              return yield* new IssueWorkError({
                code: "invalid-request",
                message: issueScopeExpansionError,
              });
            // An ancestor owned only by a retired root's subtree gets a successor under the current root.
            if ((yield* store.currentIssueOwner(ancestor.parent)) !== null) break;
            ancestor = yield* issues.workRead(ancestor.parent).pipe(Effect.mapError(mapError));
            if (
              seen.has(ancestor.issue.id) ||
              seen.size > 32 ||
              ancestor.issue.host !== read.issue.host ||
              ancestor.issue.repositoryId !== read.issue.repositoryId ||
              ancestor.milestoneNumber !== read.milestoneNumber
            )
              return yield* new IssueWorkError({
                code: "invalid-request",
                message: issueScopeExpansionError,
              });
            seen.add(ancestor.issue.id);
            ancestors.push(ancestor);
          }
          for (const parent of ancestors.reverse())
            yield* start({
              ...input,
              number: parent.issue.number,
              clientRequestId: CommandId.make(
                `${input.clientRequestId}:ancestor:${parent.issue.id}`,
              ),
            });
        }
        return yield* startAccepted(input);
      });
    const startAccepted = (
      input: IssueWorkStartInput,
    ): Effect.Effect<IssueWorkStartResult, IssueWorkError> =>
      Effect.gen(function* () {
        const accepted = yield* store.request(input.clientRequestId);
        if (accepted !== null) {
          const repository = yield* store.repositoryOwner(accepted.issue);
          if (repository !== null && repository.projectId !== input.projectId)
            return yield* new IssueWorkError({
              code: "invalid-request",
              message:
                "This repository already uses another project. Select the registered orchestrator project.",
            });
          if (
            accepted.issue.host.toLowerCase() !== input.host.toLowerCase() ||
            accepted.issue.repository.toLowerCase() !== input.repository.toLowerCase() ||
            accepted.issue.number !== input.number
          )
            return yield* new IssueWorkError({
              code: "invalid-request",
              message: "This request id was already used for a different issue.",
            });
          return {
            rootThreadId: accepted.rootThreadId,
            issueThreadId: accepted.issueThreadId,
            status: accepted.cancellation === undefined ? "queued_preparing" : "cancelled",
            createdRoot: false,
          };
        }
        const detail = yield* issues.detail(input).pipe(Effect.mapError(mapError));
        if (detail.issue.state !== "open")
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "Only open issues can start work.",
          });
        const issue = yield* issues.resolveLinkedIssue(input).pipe(Effect.mapError(mapError));
        const { root, selection, createdRoot } = yield* ensureRoot(input, issue, true);
        const rootShell = yield* threads
          .getThreadShell(root.rootThreadId)
          .pipe(Effect.mapError(mapError));
        if (rootShell === null || rootShell.archivedAt !== null || rootShell.deletedAt !== null)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message:
              "The registered repository orchestrator is unavailable. Restore it to resume issue work.",
          });
        const dispatched = yield* startWorker({
          type: "issue.work.start",
          commandId: input.clientRequestId,
          threadId: root.rootThreadId,
          issue,
          workerModelSelection: selection,
          createdBy: "user",
          creationSource: "web",
        }).pipe(Effect.mapError(mapError));
        const requestEvent = dispatched.storedEvents.find(
          (stored) => stored.event.type === "issue.work.requested",
        );
        if (requestEvent?.event.type !== "issue.work.requested")
          return yield* new IssueWorkError({
            code: "orchestration-error",
            message: "Start did not record its accepted request.",
          });
        const issueThreadId = requestEvent.event.payload.issueThreadId;
        return {
          rootThreadId: root.rootThreadId,
          issueThreadId,
          status:
            issueThreadId === null
              ? "queued_preparing"
              : (yield* progressFor(issueThreadId, false)).status,
          createdRoot,
        };
      });

    const repositoryStatus: IssueWorkService["Service"]["repositoryStatus"] = (input) =>
      Effect.gen(function* () {
        const owner = yield* store.repositoryOwnerByRef(input);
        return {
          rootThreadId: owner?.rootThreadId ?? null,
          orchestration: owner === null ? null : yield* store.configuration(owner.rootThreadId),
          slotsInUse: owner === null ? 0 : yield* store.slotsInUse(owner.rootThreadId),
          queue: yield* store.queue(input),
        };
      });
    const deliverQueuedIssue = (rootThreadId: ThreadId, key: string) =>
      threads
        .dispatch({
          type: "issue.queue.deliver",
          commandId: CommandId.make(`issue-queue-delivery:${rootThreadId}:${key}`),
          threadId: rootThreadId,
        })
        .pipe(Effect.mapError(mapError), Effect.asVoid);
    const changeQueue = Effect.fn("IssueWorkService.changeQueue")(function* (
      input: IssueQueueInput,
      queued: boolean,
    ) {
      const receipt = yield* commandReceipts
        .getByCommandId(input.clientRequestId)
        .pipe(Effect.mapError(mapError));
      const issue = yield* issues.resolveLinkedIssue(input).pipe(Effect.mapError(mapError));
      if (queued && Option.isNone(receipt)) {
        const detail = yield* issues.detail(input).pipe(Effect.mapError(mapError));
        if (detail.issue.state !== "open")
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "Only open issues can be queued.",
          });
      }
      const owner = yield* store.repositoryOwner(issue);
      // A repository mailbox persists requests before its first orchestrator exists.
      const threadId = Option.isSome(receipt)
        ? receipt.value.threadId
        : (owner?.rootThreadId ?? ThreadId.make(`issue-queue:${issue.host}:${issue.repositoryId}`));
      yield* threads
        .dispatch({
          type: "issue.queue.change",
          commandId: input.clientRequestId,
          threadId,
          issue,
          queued,
        })
        .pipe(Effect.mapError(mapError));
      if (owner !== null)
        yield* deliverQueuedIssue(owner.rootThreadId, input.clientRequestId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Issue queue delivery deferred", {
              root: owner.rootThreadId,
              cause,
            }),
          ),
        );
      return yield* repositoryStatus(input);
    });
    const update = (
      rootThreadId: ThreadId,
      config: RepositoryOrchestration,
      commandId: CommandId,
      resumeBlockedIssueId?: string,
    ) =>
      threads
        .dispatch({
          type: "repository.work.update",
          threadId: rootThreadId,
          commandId,
          expectedRevision: config.revision,
          orchestration: config,
          ...(resumeBlockedIssueId === undefined ? {} : { resumeBlockedIssueId }),
        })
        .pipe(Effect.mapError(mapError), Effect.asVoid);
    const assertCurrentCaller = Effect.fn("IssueWorkService.assertCurrentCaller")(function* (
      threadId: ThreadId,
    ) {
      const shell = (yield* threads.getThreadRecords(threadId, []).pipe(Effect.mapError(mapError)))
        .thread;
      const repository = shell.repositoryOrchestration ?? shell.linkedIssue;
      if (repository === undefined) return;
      const owner = yield* store.repositoryOwner(repository);
      if (owner?.rootThreadId !== shell.lineage.rootThreadId)
        return yield* new IssueWorkError({
          code: "retired-root",
          message: `This repository orchestrator has retired. Route orchestration work to the current root ${owner?.rootThreadId ?? "(unavailable)"}.`,
        });
    });
    const inventory = Effect.fn("IssueWorkService.handoffInventory")(function* (
      config: RepositoryOrchestration,
    ) {
      const sections = new Map<string, string[]>([
        [
          "Milestones",
          config.milestones.map(
            (plan) => `#${plan.number}: ${plan.status}; worker role ${plan.modelRoleId}`,
          ),
        ],
        ["Completed attempts", []],
        ["Remaining issues", []],
        ["Remaining issue requests", []],
        [
          "Pending changes",
          config.suspendedIssues.map((issue) => `Issue ${issue.id}: ${issue.reason}`),
        ],
      ]);
      for (const entry of yield* store.recoveryInventory(config))
        sections.get(entry.section)!.push(entry.detail);
      for (const plan of config.milestones) {
        const listing = yield* issues
          .milestoneIssues({
            host: config.host,
            repository: config.repository,
            milestoneNumber: plan.number,
          })
          .pipe(Effect.mapError(mapError));
        if (listing.missing) continue;
        if (!listing.complete)
          return yield* new IssueWorkError({
            code: "issue-unavailable",
            message:
              "Handoff inventory is incomplete. Restore GitHub access before transferring ownership.",
          });
        for (const issue of listing.issues)
          if (issue.state === "open" && issue.milestone?.number === plan.number)
            sections.get("Remaining issues")!.push(`#${issue.number} ${issue.title}\n${issue.url}`);
      }
      return [...sections]
        .map(
          ([name, entries]) =>
            `${name}:\n${entries.length === 0 ? "None recorded." : entries.join("\n\n")}`,
        )
        .join("\n\n");
    });
    /** Runs one pass per root at a time; callers arriving mid-pass share one more pass after it. */
    const coalescedPerRoot = <E>(pass: (rootThreadId: ThreadId) => Effect.Effect<void, E>) => {
      const passes = new Map<ThreadId, { pending: boolean; done: Deferred.Deferred<void, E> }>();
      return (rootThreadId: ThreadId) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const { state, leader } = yield* Effect.sync(() => {
              const existing = passes.get(rootThreadId);
              if (existing !== undefined) {
                existing.pending = true;
                return { state: existing, leader: false };
              }
              const state = { pending: false, done: Deferred.makeUnsafe<void, E>() };
              passes.set(rootThreadId, state);
              return { state, leader: true };
            });
            if (!leader) return yield* restore(Deferred.await(state.done));
            yield* restore(
              Effect.gen(function* () {
                do {
                  state.pending = false;
                  yield* pass(rootThreadId);
                } while (state.pending);
              }),
            ).pipe(
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  passes.delete(rootThreadId);
                  yield* Deferred.done(state.done, exit);
                }),
              ),
            );
          }),
        );
    };
    // A draining root lets queued turns and final deliveries finish through their original lineage;
    // new requests and milestone admissions wait until the ownership pointer moves. Reconcile and
    // the event loop both drain, so each pass re-reads the configuration the last one changed.
    const drainHandoff = coalescedPerRoot((rootThreadId) =>
      Effect.gen(function* () {
        const config = yield* store.configuration(rootThreadId);
        const handoff = config?.handoff;
        if (config === null || handoff?.status !== "draining") return;
        yield* threads
          .dispatch({
            type: "repository.work.continue",
            threadId: rootThreadId,
            commandId: CommandId.make(`handoff-drain:${handoff.requestId}:${config.revision}`),
          })
          .pipe(Effect.mapError(mapError));
        if (!(yield* store.subtreeDrained(rootThreadId))) return;
        yield* threads
          .dispatch({
            type: "repository.work.handoff",
            threadId: rootThreadId,
            // Rejected decide attempts have durable receipts. A retry needs a new
            // command id; the prepared thread id and atomic commit prevent duplicates.
            commandId: yield* ids.allocate
              .command({ fixtureName: "repository-handoff", commandName: "complete" })
              .pipe(Effect.mapError(mapError)),
            expectedRevision: config.revision,
            inventory: yield* inventory(config),
          })
          .pipe(Effect.mapError(mapError));
      }),
    );
    const continueLocal = (
      rootThreadId: ThreadId,
      refreshRequests = false,
      eventSequence?: number,
    ) =>
      Effect.gen(function* () {
        const config = yield* store.configuration(rootThreadId);
        if (config === null || config.retiredToThreadId !== undefined) return;
        const draining = config.handoff?.status === "draining";
        if (config.paused && !draining) return;
        const suspended = new Map(config.suspendedIssues.map((entry) => [entry.id, entry.reason]));
        for (const threadId of yield* store.workerThreads(rootThreadId)) {
          const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(mapError));
          if (
            shell?.linkedIssue === undefined ||
            shell.activeRunId === null ||
            !(yield* store.canAdmit(shell.linkedIssue, threadId))
          )
            continue;
          const run = (yield* threads
            .getThreadRecords(threadId, ["runs"], { runIds: [shell.activeRunId] })
            .pipe(Effect.mapError(mapError))).runs[0];
          if (run?.status === "preparing" && run.workspacePreparation !== undefined)
            yield* launch.prepareRun({
              commandId:
                run.workspacePreparationCommandId ?? CommandId.make(`issue-prepare:${run.id}`),
              threadId,
              runId: run.id,
            });
        }
        if (draining) return yield* drainHandoff(rootThreadId);
        if ((yield* store.queue(config)).some((entry) => entry.state === "queued"))
          yield* deliverQueuedIssue(
            rootThreadId,
            eventSequence === undefined
              ? `reconcile:${yield* ids.allocate.command({ fixtureName: "issue-queue", commandName: "reconcile" }).pipe(Effect.mapError(mapError))}`
              : String(eventSequence),
          );
        // Once an ancestor has a durable thread, deliver its selected sub-issues there.
        for (const request of yield* store.pendingRequests(rootThreadId)) {
          const read = refreshRequests
            ? yield* issues.workRead(request.issue).pipe(Effect.option)
            : Option.none();
          if (
            refreshRequests &&
            (Option.isNone(read) || issueEligibility(read.value) !== "eligible")
          )
            continue;
          const parent = Option.isSome(read) ? read.value.parent : request.parent;
          if (parent == null || !sameIssueRepository(parent, request.issue)) continue;
          if (suspended.has(request.issue.id) || suspended.has(parent.id)) continue;
          const parentOwner = yield* store.currentIssueOwner(parent);
          if (parentOwner === null) {
            // The parent's last attempt drained under a retired root. Start its successor here;
            // this request is delivered once that successor owns the parent.
            if ((yield* store.issueOwner(parent)) !== null)
              yield* startWorker({
                type: "issue.work.start",
                commandId: CommandId.make(
                  `issue-ancestor-successor:${request.requestId}:${rootThreadId}:${config.revision}`,
                ),
                threadId: rootThreadId,
                issue: parent,
                workerModelSelection: request.modelSelection,
                createdBy: "agent",
                creationSource: "server",
              }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Could not start the successor parent attempt", { cause }),
                ),
              );
            continue;
          }
          yield* startWorker({
            type: "issue.work.start",
            commandId: CommandId.make(`issue-child-start:${request.requestId}:${parentOwner}`),
            threadId: rootThreadId,
            issue: request.issue,
            workerModelSelection: request.modelSelection,
            createdBy: "agent",
            creationSource: "server",
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not start the pending sub-issue", { cause }),
            ),
          );
        }
        yield* threads
          .dispatch({
            type: "repository.work.continue",
            threadId: rootThreadId,
            commandId: CommandId.make(
              `issue-admission:${rootThreadId}:${config.revision}${eventSequence === undefined ? "" : `:event:${eventSequence}`}`,
            ),
          })
          .pipe(Effect.mapError(mapError));
      });

    const reconcilePass = (rootThreadId: ThreadId) =>
      Effect.gen(function* () {
        let config = yield* store.configuration(rootThreadId);
        if (
          config === null ||
          config.retiredToThreadId !== undefined ||
          (config.paused && config.handoff?.status !== "draining")
        )
          return;
        const suspended = new Map(config.suspendedIssues.map((entry) => [entry.id, entry.reason]));
        for (const threadId of yield* store.workerThreads(rootThreadId)) {
          const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(mapError));
          if (
            shell?.linkedIssue === undefined ||
            (suspended.get(shell.linkedIssue.id) !== openBlockerSuspensionReason &&
              shell.activeRunId === null &&
              shell.status !== "queued" &&
              (shell.pendingBackgroundTasks?.length ?? 0) === 0 &&
              (yield* store.resultAvailable(threadId)))
          )
            continue;
          // User-decision suspensions remain until the user explicitly resumes repository work.
          const priorReason = suspended.get(shell.linkedIssue.id);
          if (priorReason !== undefined && priorReason !== openBlockerSuspensionReason) continue;
          const read = yield* issues.workRead(shell.linkedIssue).pipe(Effect.result);
          let reason: string | null = null;
          if (read._tag === "Failure" || issueEligibility(read.success) === "unknown")
            reason = "Issue relationships are unreadable. Restore access before resuming.";
          else if (read.success.state === "closed")
            reason =
              "Issue closed during work. Decide whether to resume or close out the retained result.";
          else if (issueEligibility(read.success) === "blocked")
            reason = openBlockerSuspensionReason;
          else {
            const parent =
              read.success.parent === null
                ? rootThreadId
                : yield* store.issueOwner(read.success.parent);
            if (parent !== shell.lineage.parentThreadId)
              reason =
                "Issue was re-parented. Cancel or finish this attempt before starting a successor under its new parent.";
          }
          if (reason === null) {
            if (
              suspended.get(shell.linkedIssue.id) !== openBlockerSuspensionReason ||
              config.paused ||
              config.handoff?.status === "draining"
            )
              continue;
            const resumedIssueId = shell.linkedIssue.id;
            suspended.delete(resumedIssueId);
            yield* update(
              rootThreadId,
              {
                ...config,
                suspendedIssues: config.suspendedIssues.filter(
                  (entry) => entry.id !== resumedIssueId,
                ),
              },
              CommandId.make(`issue-resume:${rootThreadId}:${config.revision}:${resumedIssueId}`),
              resumedIssueId,
            );
            config = (yield* store.configuration(rootThreadId))!;
            continue;
          }
          if (suspended.get(shell.linkedIssue.id) === reason) continue;
          suspended.set(shell.linkedIssue.id, reason);
          config = {
            ...config,
            suspendedIssues: [...suspended].map(([id, reason]) => ({ id, reason })),
          };
          yield* update(
            rootThreadId,
            config,
            CommandId.make(
              `issue-suspend:${rootThreadId}:${config.revision}:${shell.linkedIssue.id}`,
            ),
          );
          config = (yield* store.configuration(rootThreadId))!;
        }
        yield* continueLocal(rootThreadId, true);
        if (config.handoff?.status === "draining" || config.milestones.length === 0) return;
        const plans: RepositoryOrchestration["milestones"][number][] = [];
        for (const plan of config.milestones) {
          const listing = yield* issues
            .milestoneIssues({
              host: config.host,
              repository: config.repository,
              milestoneNumber: plan.number,
            })
            .pipe(Effect.result);
          if (listing._tag === "Success" && listing.success.missing) {
            yield* update(
              rootThreadId,
              { ...config, milestones: config.milestones.filter((p) => p.number !== plan.number) },
              CommandId.make(`milestone-drop:${rootThreadId}:${config.revision}:${plan.number}`),
            );
            config = (yield* store.configuration(rootThreadId))!;
            continue;
          }
          if (listing._tag === "Failure" || !listing.success.complete) {
            plans.push({ ...plan, status: "unreadable", fingerprint: "unreadable" });
            continue;
          }
          const selected = listing.success.issues.filter(
            (issue) => issue.milestone?.number === plan.number && issue.state === "open",
          );
          let unreadable = false,
            blocked = false,
            awaiting = false,
            running = false;
          const fingerprint: string[] = [];
          for (const issue of selected) {
            const readResult = yield* issues
              .workRead({
                host: config.host,
                repository: config.repository,
                number: issue.number,
              })
              .pipe(Effect.result);
            if (readResult._tag === "Failure") {
              unreadable = true;
              fingerprint.push(`${issue.number}:unknown`);
              continue;
            }
            const read = readResult.success;
            const eligibility = issueEligibility(read);
            const owner = yield* store.issueOwner(read.issue);
            fingerprint.push(
              `${read.issue.id}:${eligibility}:${read.parent?.id ?? "root"}:${owner ?? "unclaimed"}`,
            );
            if (eligibility === "unknown") {
              unreadable = true;
              continue;
            }
            if (eligibility === "blocked") {
              blocked = true;
              continue;
            }
            if (eligibility === "closed") continue;
            if (suspended.has(read.issue.id)) {
              awaiting = true;
              continue;
            }
            if (owner !== null) {
              const shell = yield* threads.getThreadShell(owner).pipe(Effect.mapError(mapError));
              if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) {
                unreadable = true;
                continue;
              }
              if (shell.status === "queued") running = true;
              else if (shell.pendingRuntimeRequest !== null) awaiting = true;
              else if (shell.activeRunId === null && (yield* store.resultAvailable(owner)))
                awaiting = true;
              else running = true;
              continue;
            }
            const firstCommandId = `milestone-issue:${rootThreadId}:${plan.number}:${read.issue.id}:first`;
            let clientRequestId = CommandId.make(firstCommandId);
            // Rejected commands are immutable; only a rejected attempt gets a new identity. Retries
            // wait 1 minute after a rejection, doubling up to a day, so a lasting rejection (a
            // deleted model role, an unavailable provider) adds a few receipts, not one per pass.
            const now = yield* Clock.currentTimeMillis;
            for (let retry = 1; ; retry++) {
              const receipt = yield* commandReceipts
                .getByCommandId(clientRequestId)
                .pipe(Effect.mapError(mapError));
              if (Option.isNone(receipt) || receipt.value.status !== "rejected") break;
              const waitMs = Math.min(2 ** (retry - 1), 1440) * 60_000;
              if (now < receipt.value.acceptedAt.epochMilliseconds + waitMs) break;
              clientRequestId = CommandId.make(`${firstCommandId}:retry:${retry}`);
            }
            const started = yield* start({
              host: config.host,
              repository: config.repository,
              number: issue.number,
              projectId: config.projectId,
              modelRoleId: plan.modelRoleId,
              clientRequestId,
            }).pipe(Effect.result);
            if (started._tag === "Failure") {
              if (started.failure.code === "invalid-request") awaiting = true;
              else unreadable = true;
            } else running = true;
          }
          const status = unreadable
            ? "unreadable"
            : running
              ? "running"
              : awaiting
                ? "awaiting_approval"
                : blocked
                  ? "blocked"
                  : "complete";
          plans.push({ ...plan, status, fingerprint: fingerprint.sort().join("|") });
        }
        if (
          plans.some(
            (plan, index) =>
              plan.fingerprint !== config!.milestones[index]?.fingerprint ||
              plan.status !== config!.milestones[index]?.status,
          )
        )
          yield* update(
            rootThreadId,
            { ...config, milestones: plans },
            CommandId.make(`milestone-reconcile:${rootThreadId}:${config.revision}`),
          );
      });

    const reconcile: IssueWorkService["Service"]["reconcile"] = coalescedPerRoot(reconcilePass);

    const workMilestone: IssueWorkService["Service"]["workMilestone"] = (input) =>
      Effect.gen(function* () {
        const listing = yield* issues.milestoneIssues(input).pipe(Effect.result);
        if (listing._tag === "Success" && listing.success.missing)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: `Milestone #${input.milestoneNumber} does not exist in ${input.repository}.`,
          });
        let owner = yield* store.repositoryOwnerByRef(input);
        if (owner === null) {
          const repository = yield* issues
            .repositoryIdentity(input)
            .pipe(Effect.mapError(mapError));
          owner = (yield* ensureRoot(input, repository)).root;
        }
        if (owner.projectId !== input.projectId)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "Select the registered repository orchestrator's project.",
          });
        const config = (yield* store.configuration(owner.rootThreadId))!;
        if (!config.milestones.some((plan) => plan.number === input.milestoneNumber))
          yield* update(
            owner.rootThreadId,
            {
              ...config,
              milestones: [
                ...config.milestones,
                {
                  number: input.milestoneNumber,
                  modelRoleId: input.modelRoleId,
                  status: "running",
                  fingerprint: "",
                },
              ],
            },
            input.clientRequestId,
          );
        yield* reconcile(owner.rootThreadId);
        return yield* repositoryStatus(input);
      });
    const setWorkerLimit: IssueWorkService["Service"]["setWorkerLimit"] = (input) =>
      Effect.gen(function* () {
        yield* decodeWorkerLimit(input).pipe(
          Effect.mapError(
            () =>
              new IssueWorkError({
                code: "invalid-request",
                message:
                  "Use an integer worker limit from 1 to 32 and the current repository revision.",
              }),
          ),
        );
        const owner = yield* store.repositoryOwnerByRef(input);
        if (owner === null)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "This repository has no registered orchestrator.",
          });
        const config = (yield* store.configuration(owner.rootThreadId))!;
        if (config.revision !== input.expectedRevision)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "Repository ownership changed. Refresh before updating work.",
          });
        if (config.handoff?.status === "draining")
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "A handoff is draining. Cancel the handoff before changing the worker limit.",
          });
        if (input.workerLimit !== config.workerLimit)
          yield* update(
            owner.rootThreadId,
            { ...config, workerLimit: input.workerLimit },
            input.clientRequestId,
          );
        if (input.workerLimit > config.workerLimit && !config.paused)
          yield* reconcile(owner.rootThreadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Issue queue continuation after worker limit change failed", {
                rootThreadId: owner.rootThreadId,
                cause,
              }),
            ),
          );
        return yield* repositoryStatus(input);
      });
    const setPaused: IssueWorkService["Service"]["setPaused"] = (input) =>
      Effect.gen(function* () {
        const owner = yield* store.repositoryOwnerByRef(input);
        if (owner === null)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "This repository has no registered orchestrator.",
          });
        const config = (yield* store.configuration(owner.rootThreadId))!;
        if (config.handoff?.status === "draining")
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "A handoff is draining. Cancel the handoff before changing the pause state.",
          });
        // Resume is an explicit decision to re-check suspended work. Admission still validates GitHub.
        if (config.paused !== input.paused || (!input.paused && config.suspendedIssues.length > 0))
          yield* update(
            owner.rootThreadId,
            {
              ...config,
              paused: input.paused,
              suspendedIssues: input.paused ? config.suspendedIssues : [],
            },
            input.clientRequestId,
          );
        if (!input.paused) {
          yield* reconcile(owner.rootThreadId);
        }
        return yield* repositoryStatus(input);
      });

    const prepareHandoff = Effect.fn("IssueWorkService.prepareHandoff")(function* (
      input: RepositoryHandoffRequestInput,
      status: "awaiting_approval" | "draining",
      callerThreadId?: ThreadId,
    ) {
      const owner = yield* store.repositoryOwnerByRef(input);
      if (callerThreadId !== undefined) yield* assertCurrentCaller(callerThreadId);
      if (owner === null || (callerThreadId !== undefined && callerThreadId !== owner.rootThreadId))
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Only the registered repository root can request a handoff.",
        });
      const config = (yield* store.configuration(owner.rootThreadId))!;
      if (config.handoff?.requestId === input.clientRequestId && config.handoff.status === status)
        return yield* repositoryStatus(input);
      if (config.revision !== input.expectedRevision)
        return yield* new IssueWorkError({
          code: "repository-owner-conflict",
          message:
            "Repository ownership changed. Refresh before requesting or approving a handoff.",
        });
      if (
        config.handoff !== undefined &&
        (status !== "draining" || config.handoff.status !== "awaiting_approval")
      )
        return yield* new IssueWorkError({
          code: "repository-owner-conflict",
          message: "This repository already has a pending handoff. Approve or cancel it first.",
        });
      const root = yield* threads
        .getThreadShell(owner.rootThreadId)
        .pipe(Effect.mapError(mapError));
      if (root === null || root.archivedAt !== null || root.deletedAt !== null)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Restore the repository root before handing it off.",
        });
      const selection =
        input.modelSelection ?? config.handoff?.modelSelection ?? root.modelSelection;
      if (
        config.handoff !== undefined &&
        (input.summary !== config.handoff.summary ||
          (yield* encodeToolArgument(selection).pipe(Effect.mapError(mapError))) !==
            (yield* encodeToolArgument(config.handoff.modelSelection).pipe(
              Effect.mapError(mapError),
            )))
      )
        return yield* new IssueWorkError({
          code: "repository-owner-conflict",
          message:
            "The handoff proposal changed. Review its current summary and model before approving.",
        });
      const target = checkDelegateTarget({
        providers: yield* providers.getProviders,
        orchestrationCapableInstanceIds: new Set(yield* adapters.list()),
        instanceId: selection.instanceId,
        requestedModel: selection.model,
        inheritedModel: undefined,
        options: selection.options,
      });
      if (typeof target !== "string")
        return yield* new IssueWorkError({ code: "invalid-request", message: target.message });
      const adapter = yield* adapters.get(selection.instanceId).pipe(Effect.mapError(mapError));
      if (adapter.driver !== "codex" && adapter.driver !== "claudeAgent")
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Repository orchestration supports Codex and Claude only.",
        });
      const requestId = config.handoff?.requestId ?? input.clientRequestId;
      yield* update(
        owner.rootThreadId,
        {
          ...config,
          paused: status === "draining" ? true : config.paused,
          handoff: {
            requestId,
            nextThreadId: ids.derive.delegatedTaskThread({
              commandId: CommandId.make(`repository-handoff:${requestId}`),
            }),
            summary: input.summary,
            modelSelection: selection,
            status,
            wasPaused: config.paused,
          },
        },
        input.clientRequestId,
      );
      if (status === "draining") yield* reconcile(owner.rootThreadId);
      return yield* repositoryStatus(input);
    });
    const handoff: IssueWorkService["Service"]["handoff"] = (input) =>
      input.action === "approve"
        ? prepareHandoff(input, "draining")
        : Effect.gen(function* () {
            const owner = yield* store.repositoryOwnerByRef(input);
            const config = owner === null ? null : yield* store.configuration(owner.rootThreadId);
            if (
              owner === null ||
              config?.handoff === undefined ||
              config.revision !== input.expectedRevision
            )
              return yield* new IssueWorkError({
                code: "repository-owner-conflict",
                message: "Repository ownership or the handoff changed. Refresh before cancelling.",
              });
            yield* update(
              owner.rootThreadId,
              {
                ...config,
                paused:
                  config.handoff.status === "draining" ? config.handoff.wasPaused : config.paused,
                handoff: undefined,
              },
              input.clientRequestId,
            );
            if (config.handoff.status === "draining" && !config.handoff.wasPaused)
              yield* reconcile(owner.rootThreadId);
            return yield* repositoryStatus(input);
          });

    const cancelRequest: IssueWorkService["Service"]["cancelRequest"] = (input) =>
      Effect.gen(function* () {
        const request = yield* store.request(input.requestId);
        const config = yield* store.configuration(input.expectedRootThreadId);
        if (
          request === null ||
          config?.projectId !== input.projectId ||
          request.rootThreadId !== input.expectedRootThreadId ||
          request.issue.host.toLowerCase() !== input.host.toLowerCase() ||
          request.issue.repository.toLowerCase() !== input.repository.toLowerCase()
        )
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "The request does not belong to the selected repository, project and root.",
          });
        const dispatched = yield* threads
          .dispatch({
            type: "issue.work.cancel",
            commandId: input.clientRequestId,
            threadId: input.expectedRootThreadId,
            projectId: input.projectId,
            requestId: input.requestId,
            reason: input.reason,
          })
          .pipe(Effect.mapError(mapError));
        if (
          !dispatched.storedEvents.some(
            (stored) =>
              stored.event.type === "issue.work.cancelled" &&
              stored.event.payload.requestedRequestId === input.requestId,
          )
        )
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "This command id was already used for another recovery operation.",
          });
        return (yield* store.request(input.requestId))!;
      });

    const restoreRoot: IssueWorkService["Service"]["restoreRoot"] = (input) =>
      Effect.gen(function* () {
        yield* assertProjectRepository(input.projectId, input);
        const target = yield* threads
          .getThreadShell(input.targetThreadId)
          .pipe(Effect.mapError(mapError));
        if (target !== null && target.lineage.parentThreadId === null)
          yield* assertRootCheckout({
            projectId: input.projectId,
            commandId: input.clientRequestId,
            worktreePath: target.worktreePath,
          });
        if (input.expectedRootThreadId === null) {
          const identity = yield* issues.repositoryIdentity(input).pipe(Effect.mapError(mapError));
          if (
            identity.host !== input.host ||
            identity.repositoryId !== input.repositoryId ||
            identity.repository.toLowerCase() !== input.repository.toLowerCase()
          )
            return yield* new IssueWorkError({
              code: "invalid-request",
              message: "The selected repository identity does not match this registration.",
            });
        }
        const dispatched = yield* threads
          .dispatch({
            type: "repository.work.restore",
            commandId: input.clientRequestId,
            threadId: input.expectedRootThreadId ?? input.targetThreadId,
            expectedRootThreadId: input.expectedRootThreadId,
            projectId: input.projectId,
            host: input.host,
            repository: input.repository,
            repositoryId: input.repositoryId,
            expectedRevision: input.expectedRevision,
            targetThreadId: input.targetThreadId,
            reason: input.reason,
          })
          .pipe(Effect.mapError(mapError));
        if (
          !dispatched.storedEvents.some(
            (stored) =>
              stored.event.type === "repository.work.restored" &&
              stored.event.payload.targetThreadId === input.targetThreadId &&
              stored.event.payload.previousRootThreadId === input.expectedRootThreadId &&
              stored.event.payload.expectedRevision === input.expectedRevision,
          )
        )
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "This command id was already used for another recovery operation.",
          });
        return yield* repositoryStatus(input);
      });

    const service = IssueWorkService.of({
      workStatus: (input) =>
        Effect.gen(function* () {
          const request = yield* store.latestRequest(input);
          const issue = (yield* store.linkedIssue(input)) ?? request?.issue ?? null;
          if (issue === null) {
            const repository = yield* store.repositoryOwnerByRef(input);
            return {
              issue: input,
              projectId: repository?.projectId ?? null,
              rootThreadId: repository?.rootThreadId ?? null,
              threadId: null,
              status: null,
              publishing: "absent",
            };
          }
          const root = yield* store.repositoryOwner(issue);
          const owner = yield* store.issueOwner(issue);
          const suspended =
            root !== null &&
            (yield* store.configuration(root.rootThreadId))?.suspendedIssues.some(
              (entry) => entry.id === issue.id,
            ) === true;
          if (owner === null || request?.attemptKey === owner) {
            const rootShell =
              root === null
                ? null
                : yield* threads.getThreadShell(root.rootThreadId).pipe(Effect.mapError(mapError));
            const rootRequests =
              root === null || rootShell === null
                ? []
                : (yield* threads
                    .getThreadRecords(root.rootThreadId, ["runtimeRequests"])
                    .pipe(Effect.mapError(mapError))).runtimeRequests;
            const status =
              request?.cancellation !== undefined
                ? "cancelled"
                : root === null || request === null
                  ? null
                  : deriveIssueWorkStatus({
                      shell: rootShell,
                      paused: root.paused,
                      runtimeRequests: rootRequests,
                      waitingOnSubIssues: false,
                      queued: true,
                    });
            return {
              issue: input,
              projectId: root?.projectId ?? null,
              rootThreadId: root?.rootThreadId ?? null,
              threadId: null,
              status,
              publishing:
                root === null ? "absent" : yield* store.publishing(root.rootThreadId, issue),
              pendingRequestId:
                request !== null &&
                request.cancellation === undefined &&
                request.issueThreadId === null &&
                request.rootThreadId === root?.rootThreadId
                  ? request.requestId
                  : null,
            };
          }
          return {
            issue: input,
            projectId: root?.projectId ?? null,
            rootThreadId: root?.rootThreadId ?? null,
            threadId: owner,
            status: (yield* progressFor(owner, (root?.paused ?? false) || suspended)).status,
            publishing: yield* store.publishing(owner, issue),
          };
        }),
      queueIssue: (input) => changeQueue(input, true),
      unqueueIssue: (input) => changeQueue(input, false),
      start: (input) => start(input),
      startWorker,
      cancelRequest,
      restoreRoot,
      workMilestone,
      repositoryStatus,
      setPaused,
      setWorkerLimit,
      assertCurrentCaller,
      requestHandoff: (threadId, input) => prepareHandoff(input, "awaiting_approval", threadId),
      handoff,
      reconcile,
    });
    const scheduler = yield* Effect.serviceOption(Scheduler.Scheduler);
    if (Option.isSome(scheduler)) {
      let nextReadAt = 0;
      yield* scheduler.value.register(
        "repository-issue-work",
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (now < nextReadAt) return;
          nextReadAt = now + 60_000;
          for (const root of yield* store.activeRoots()) yield* reconcile(root);
        }),
      );
    }
    const sink = yield* Effect.serviceOption(EventSink.EventSinkV2);
    if (Option.isSome(sink)) {
      const pendingRoots = new Map<ThreadId, number>();
      const wake = yield* Queue.sliding<void>(1);
      yield* Effect.gen(function* () {
        while (true) {
          yield* Queue.take(wake);
          for (const [root, eventSequence] of pendingRoots) {
            pendingRoots.delete(root);
            yield* continueLocal(root, false, eventSequence).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Issue queue continuation failed", { root, cause }),
              ),
            );
          }
        }
      }).pipe(Effect.forkScoped);
      const sequence = yield* sink.value.latestSequence().pipe(Effect.orDie);
      yield* sink.value.stream({ afterSequence: sequence }).pipe(
        Stream.filter(
          (stored) =>
            !String(stored.commandId).startsWith("command:runtime-reconcile:") &&
            (stored.event.type === "thread.created" ||
              (stored.event.type === "thread.metadata-updated" &&
                stored.event.payload.repositoryOrchestration !== undefined) ||
              stored.event.type === "thread.unarchived" ||
              stored.event.type === "thread.settled" ||
              stored.event.type === "repository.work.restored" ||
              (stored.event.type === "issue.queue.updated" &&
                stored.event.payload.state === "queued" &&
                stored.event.payload.noticeRunId === undefined) ||
              (stored.event.type === "subagent.updated" &&
                ["completed", "failed", "interrupted", "cancelled"].includes(
                  stored.event.payload.status,
                )) ||
              (stored.event.type === "runtime-request.updated" &&
                stored.event.payload.status !== "pending") ||
              (stored.event.type === "provider-thread.updated" &&
                (stored.event.payload.pendingBackgroundTasks?.length ?? 0) === 0) ||
              ((stored.event.type === "run.updated" || stored.event.type === "run.created") &&
                ["queued", "preparing", "completed", "failed", "interrupted", "cancelled"].includes(
                  stored.event.payload.status,
                ))),
        ),
        Stream.runForEach((stored) =>
          Effect.gen(function* () {
            if (stored.event.type === "thread.metadata-updated") {
              const receipt =
                stored.commandId == null
                  ? Option.none()
                  : yield* commandReceipts.getByCommandId(stored.commandId);
              if (
                Option.isNone(receipt) ||
                ![
                  "repository.work.update",
                  "repository.work.handoff",
                  "repository.work.restore",
                ].includes(receipt.value.commandType)
              )
                return;
            }
            // A notice's failure batch must not immediately remind itself again.
            const noticeRunId =
              (stored.event.type === "run.updated" || stored.event.type === "run.created") &&
              stored.event.payload.status !== "completed"
                ? stored.event.payload.id
                : stored.event.type === "provider-thread.updated"
                  ? stored.event.runId
                  : undefined;
            if (
              noticeRunId !== undefined &&
              (yield* store.isQueueNoticeRun(stored.event.threadId, noticeRunId))
            )
              return;
            const shell = yield* threads
              .getThreadShell(stored.event.threadId)
              .pipe(Effect.mapError(mapError));
            const repository =
              (stored.event.type === "issue.queue.updated"
                ? stored.event.payload.issue
                : shell?.linkedIssue) ?? (yield* store.configuration(stored.event.threadId));
            if (repository == null) return;
            const owner = yield* store.repositoryOwner(repository);
            // Root availability also releases one queued notice.
            if (
              owner !== null &&
              (shell?.linkedIssue === undefined ||
                stored.event.type === "subagent.updated" ||
                stored.event.type === "runtime-request.updated" ||
                stored.event.type === "provider-thread.updated") &&
              (yield* store.configuration(owner.rootThreadId))?.handoff?.status !== "draining" &&
              (yield* store.queue(repository)).length === 0
            )
              return;
            if (owner !== null) {
              pendingRoots.set(owner.rootThreadId, stored.sequence);
              yield* Queue.offer(wake, undefined);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Issue plan continuation failed", { cause }),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }
    // Recover persisted notices once; further attempts are driven by availability events.
    if (Option.isSome(sink)) {
      for (const root of yield* store.queuedRoots())
        yield* deliverQueuedIssue(
          root,
          `startup:${yield* sink.value.latestSequence().pipe(Effect.orDie)}`,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Issue queue recovery failed", { root, cause }),
          ),
        );
    }
    return service;
  }),
);
