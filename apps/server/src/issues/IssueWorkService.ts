import { pendingSubagentRequestsByThread } from "@t3tools/shared/pendingSubagentRequests";
import { issueQueueMailbox, QUEUED_ISSUE_START_PREFIX } from "./IssueQueueStore.ts";
import {
  CommandId,
  type EnvironmentId,
  CLOSED_ISSUE_SUSPENSION_REASON,
  resolveModelRoles,
  ThreadId,
  type IssueQueueInput,
  type OrchestrationV2ServerCommand,
  DEFAULT_REPOSITORY_WORK_SETTINGS,
  repositoryPhase,
  repositoryAdmitsWork,
  type IssueSuspensionKind,
  IssueWorkError,
  type RepositoryIssueRef,
  type IssueWorkStartInput,
  type IssueWorkCancelInput,
  type IssueWorkCloseOutInput,
  type IssueWorkRequested,
  type RepositoryWorkRestoreInput,
  type IssueWorkStartResult,
  type IssueWorkStatusResult,
  type RepositoryWorkInput,
  type RepositoryWorkControlInput,
  RepositoryWorkerLimitInput,
  RepositoryReadOnlyLimitInput,
  type RepositoryHandoffInput,
  type RepositoryOrchestratorInput,
  type IssueRepositoryRef,
  isMovableRepositoryRegistration,
  isRepositoryOrchestratorEligible,
  hasRepositoryControllerModes,
  type RepositoryHandoffRequestInput,
  type RepositoryWorkResult,
  type RepositoryChildrenStatus,
  type RepositoryOrchestration,
  type ProjectId,
  type IssueWorkRead,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import {
  resolveThreadActivityGroup,
  threadActivityFromShell,
  threadQuietMinutes,
  visibleOpenPullRequest,
} from "@t3tools/shared/threadActivity";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as Context from "effect/Context";
import { agentWorktreeName } from "@t3tools/shared/forkAgentWorktreeName";
import {
  OrchestratorCommandRejectedError,
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
  type OrchestratorV2DispatchResult,
} from "../orchestration-v2/Orchestrator.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { issueRepositoryOf } from "./issueRepositoryOf.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as Layer from "effect/Layer";
import { IssueService, makeLiveReadCache } from "./IssueService.ts";
import { IssueWorkStore, missingOwnerMessage } from "./IssueWorkStore.ts";
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
import { modelRoleStatuses, providerCreditStatuses } from "../provider/modelRolePolicy.ts";
import {
  issueEligibility,
  isUnmanagedIssueRole,
  sameIssueRepository,
  supportsManagedIssueWork,
  issueScopeExpansionError,
  openBlockerSuspensionReason,
  unreadableRelationshipsSuspensionReason,
  isAutomaticIssueSuspension,
} from "./IssueEligibility.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  automaticHandoffThreadId,
  REPOSITORY_HANDOFF_VERIFICATION_TIMEOUT_MS,
} from "../orchestration-v2/AutomaticRepositoryHandoff.ts";

const decodeLimit = Schema.decodeEffect(
  Schema.Union([RepositoryWorkerLimitInput, RepositoryReadOnlyLimitInput]),
);
const encodeToolArgument = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class IssueWorkService extends Context.Service<
  IssueWorkService,
  {
    readonly assignOrchestrator: (
      input: RepositoryOrchestratorInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly ensureOrchestrator: (
      input: IssueRepositoryRef,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
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
    readonly workStatus: (
      input: RepositoryIssueRef,
    ) => Effect.Effect<IssueWorkStatusResult, IssueWorkError>;
    readonly workMilestone: (
      input: RepositoryWorkInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly childrenStatus: (
      rootThreadId: ThreadId,
      threadLink: (threadId: ThreadId, title: string, environmentId?: EnvironmentId) => string,
    ) => Effect.Effect<RepositoryChildrenStatus, IssueWorkError>;
    readonly repositoryStatus: (
      input: Pick<RepositoryIssueRef, "host" | "repository">,
      options?: { readonly verifyIdentity?: boolean },
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly setWorkerLimit: (
      input: RepositoryWorkerLimitInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly setReadOnlyLimit: (
      input: RepositoryReadOnlyLimitInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly closeOut: (
      input: IssueWorkCloseOutInput,
      callerThreadId?: ThreadId,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly endRepository: (
      input: import("@t3tools/contracts").RepositoryWorkEndInput,
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
    const assignments = yield* KeyedLock.make<string>();
    const projects = yield* ProjectService;
    const issues = yield* IssueService;
    const store = yield* IssueWorkStore;
    const sql = yield* SqlClient.SqlClient;
    const launch = yield* ThreadLaunchService;
    const threads = yield* ThreadManagementService;
    const settings = yield* ServerSettingsService;
    const handoffThreshold = (projectId: ProjectId) =>
      Effect.map(settings.getSettings, (current) => {
        const override =
          current.projectSettingsOverrides[projectId]?.orchestratorHandoffCompactions;
        return override === undefined ? current.orchestratorHandoffCompactions : override;
      });
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
    const assertRootCheckout = Effect.fn("IssueWorkService.assertRootCheckout")(function* (input: {
      projectId: ProjectId;
      commandId: CommandId;
      worktreePath: string | null;
    }) {
      const expectedBranch = yield* launch.readDefaultBranch(input).pipe(Effect.mapError(mapError));
      if (
        input.worktreePath !== null ||
        (yield* launch.readCheckoutBranch(input).pipe(Effect.mapError(mapError))) !== expectedBranch
      )
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: `The repository orchestrator requires the main checkout on the default branch (${expectedBranch}).`,
        });
      return expectedBranch;
    });
    const progressFor = Effect.fn("IssueWorkService.progressFor")(function* (
      threadId: Parameters<typeof threads.getThreadShell>[0],
      paused: boolean,
    ) {
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
    }, Effect.mapError(mapError));

    const assertProjectRepository = Effect.fn("IssueWorkService.assertProjectRepository")(
      function* (
        projectId: import("@t3tools/contracts").ProjectId,
        repositoryRef: Pick<RepositoryIssueRef, "host" | "repository">,
      ) {
        const project = yield* projects.getById(projectId).pipe(Effect.mapError(mapError));
        const identity = Option.isSome(project) ? project.value.repositoryIdentity : null;
        const repository =
          identity?.origin?.displayName ?? sourceControlDefinitions.repositorySelector(identity);
        const upstream = sourceControlDefinitions.repositorySelector(identity);
        if (
          issueRepositoryOf(identity)?.host !== repositoryRef.host.toLowerCase() ||
          (repository?.toLowerCase() !== repositoryRef.repository.toLowerCase() &&
            upstream?.toLowerCase() !== repositoryRef.repository.toLowerCase())
        )
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "Select a project whose GitHub repository matches this issue.",
          });
      },
    );

    const ensureRoot = Effect.fn("IssueWorkService.ensureRoot")(function* (
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
    ) {
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
      const serverSettings = yield* settings.getSettings.pipe(Effect.mapError(mapError));
      const availableProviders = yield* providers.getProviders;
      const capableIds = new Set<import("@t3tools/contracts").ProviderInstanceId>();
      for (const instanceId of yield* adapters.list()) {
        const adapter = yield* adapters.get(instanceId).pipe(Effect.mapError(mapError));
        if (supportsManagedIssueWork(adapter.driver)) capableIds.add(instanceId);
      }
      const now = yield* Clock.currentTimeMillis;
      const roles = modelRoleStatuses(
        resolveModelRoles(serverSettings),
        availableProviders,
        capableIds,
        now,
        providerCreditStatuses(availableProviders, serverSettings.providerCreditsApproved, now),
      );
      const role = roles.find((entry) => entry.id === input.modelRoleId);
      if (role === undefined)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "The selected model role no longer exists.",
        });
      const select = ({ providerInstanceId, model, options }: (typeof role.targets)[number]) => ({
        instanceId: providerInstanceId,
        model,
        ...(options === undefined ? {} : { options }),
      });
      const [worker] = role.targets;
      if (worker.unavailableReason !== null)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: `Managed issue work requires an available Codex or Claude target in the selected model role (${worker.unavailableReason}).`,
        });
      const selection = select(worker);
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
        yield* restoreRoot(
          {
            ...issue,
            projectId: input.projectId,
            expectedRootThreadId: null,
            expectedRevision: null,
            targetThreadId: selectedLead,
            reason: "User selected this existing lead for issue work",
            clientRequestId: CommandId.make(`${input.clientRequestId}:adopt-root`),
          },
          { verifyStatusIdentity: false },
        ).pipe(
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
        let commandId = CommandId.make(`issue-root:${issue.host}:${issue.repositoryId}`);
        for (;;) {
          const previous = yield* store.configuration(
            ids.derive.delegatedTaskThread({ commandId }),
          );
          if (previous === null || repositoryPhase(previous) !== "retired") break;
          commandId = CommandId.make(`${commandId}:restart`);
        }
        const orchestrator = roles.find(
          (entry) => entry.role === "orchestrator" && entry.level === "complex",
        )!.targets[0];
        if (orchestrator.unavailableReason !== null)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: `The Orchestrator role is unavailable (${orchestrator.unavailableReason}).`,
          });
        const rootSelection = select(orchestrator);
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

    // Workspace preparation claims a slot after the worker is admitted.
    const startWorker: IssueWorkService["Service"]["startWorker"] = Effect.fn(
      "IssueWorkService.startWorker",
    )(function* (command) {
      if (command.type === "delegated_task.request" && isUnmanagedIssueRole(command.role))
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Writers and read-only children use ordinary delegation and issue links.",
        });
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
          message: yield* missingOwnerMessage(
            store,
            command.issue,
            "The repository orchestrator is unavailable.",
          ),
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

    const start = Effect.fn("IssueWorkService.start")(function* (
      input: IssueWorkStartInput,
    ): Effect.fn.Return<IssueWorkStartResult, IssueWorkError> {
      // An accepted operation remains replayable even if GitHub changed afterward.
      const accepted = yield* store.request(input.clientRequestId);
      let read: IssueWorkRead | undefined;
      if (accepted === null) {
        read = yield* issues.workRead(input).pipe(Effect.mapError(mapError));
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
            clientRequestId: CommandId.make(`${input.clientRequestId}:ancestor:${parent.issue.id}`),
          });
        // Starting an ancestor can leave enough time for the requested issue to change.
        if (ancestors.length > 0) read = undefined;
      }
      return yield* startAccepted(input, read);
    });
    const startAccepted = Effect.fn("IssueWorkService.startAccepted")(function* (
      input: IssueWorkStartInput,
      verifiedRead: IssueWorkRead | undefined,
    ): Effect.fn.Return<IssueWorkStartResult, IssueWorkError> {
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
      const read = verifiedRead ?? (yield* issues.workRead(input).pipe(Effect.mapError(mapError)));
      if (read.state !== "open")
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Only open issues can start work.",
        });
      const { issue } = read;
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

    // Status is polled, a rename is rare, and only registered repositories reach this cache.
    const liveIdentity = makeLiveReadCache<{ readonly repositoryId: string }>(10 * 60_000);
    const readRepositoryStatus = Effect.fn("IssueWorkService.readRepositoryStatus")(
      function* (input: IssueRepositoryRef) {
        const owner = yield* store.repositoryOwnerByRef(input);
        const orchestration =
          owner === null ? null : yield* store.configuration(owner.rootThreadId);
        return {
          phase: orchestration === null ? null : repositoryPhase(orchestration),
          rootThreadId: owner?.rootThreadId ?? null,
          orchestration,
          slotsInUse: owner === null ? 0 : yield* store.slotsInUse(owner.rootThreadId),
          readOnlySlotsInUse:
            owner === null ? 0 : yield* store.readOnlySlotsInUse(owner.rootThreadId),
          queue: yield* store.queue(input),
        };
      },
      (reads) => sql.withTransaction(reads).pipe(NodeSqliteClient.readOnly),
      Effect.mapError(mapError),
    );
    const repositoryStatus: IssueWorkService["Service"]["repositoryStatus"] = Effect.fn(
      "IssueWorkService.repositoryStatus",
    )(function* (input, options) {
      const snapshot = yield* readRepositoryStatus(input);
      if (snapshot.orchestration === null) return snapshot;
      const threshold = yield* handoffThreshold(snapshot.orchestration.projectId).pipe(
        Effect.option,
      );
      const status = Option.isSome(threshold)
        ? { ...snapshot, orchestratorHandoffCompactions: threshold.value }
        : snapshot;
      if (options?.verifyIdentity === false) return status;
      // A host that cannot answer must not hide the registration, so only a successful read can report a mismatch.
      const live = yield* Effect.exit(
        liveIdentity(
          `${input.host}/${input.repository}`.toLowerCase(),
          issues.repositoryIdentity(input),
          undefined,
        ),
      );
      return live._tag === "Success" &&
        live.value.repositoryId !== snapshot.orchestration.repositoryId
        ? {
            ...status,
            idMismatch: {
              registeredRepositoryId: snapshot.orchestration.repositoryId,
              liveRepositoryId: live.value.repositoryId,
            },
          }
        : status;
    });
    const childrenStatus: IssueWorkService["Service"]["childrenStatus"] = Effect.fn(
      "IssueWorkService.childrenStatus",
    )(function* (rootThreadId, threadLink) {
      const { summaries, remoteTasks, readShells } = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if (!(yield* store.isRepositoryOrchestrator(rootThreadId))) {
              return yield* new IssueWorkError({
                code: "invalid-request",
                message: "Only the registered repository orchestrator can read its child status.",
              });
            }
            const summaries = yield* store.childTaskSummaries(rootThreadId);
            const remoteTasks = yield* store.remoteChildTasks(rootThreadId);
            const readShells =
              summaries.length === 0
                ? null
                : yield* threads.readShellSnapshot({
                    location: "active",
                    familyOf: rootThreadId,
                  });
            return { summaries, remoteTasks, readShells };
          }),
        )
        .pipe(NodeSqliteClient.readOnly);

      const groups: {
        [Group in keyof RepositoryChildrenStatus]: RepositoryChildrenStatus[Group][number][];
      } = { working: [], "needs-you": [], "ready-for-review": [] };
      const now = yield* Clock.currentTimeMillis;
      for (const task of remoteTasks) {
        const group = resolveThreadActivityGroup({
          interactionMode: "default",
          hasActionableProposedPlan: false,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          latestRun: null,
          runtime: { status: task.status === "pending" ? "queued" : task.status },
          pullRequests: [],
        });
        if (group === null) continue;
        const end = task.completedAt === null ? now : Date.parse(task.completedAt);
        groups[group].push({
          threadId: task.threadId,
          title: task.title,
          link: threadLink(task.threadId, task.title, task.environmentId),
          issue: null,
          pullRequestUrl: null,
          lastSummary: task.lastSummary,
          elapsedMs: task.startedAt === null ? 0 : Math.max(0, end - Date.parse(task.startedAt)),
        });
      }
      if (readShells === null) return groups;

      const { threads: family } = yield* readShells;
      const clock = { nowMs: now, quietMinutes: (yield* settings.getSettings).quietThreadMinutes };
      const pendingRequests = pendingSubagentRequestsByThread(family);
      const summariesById = new Map(
        summaries.map(({ threadId, lastSummary }) => [threadId, lastSummary]),
      );
      for (const child of family) {
        if (!summariesById.has(child.id)) continue;
        const activity = threadActivityFromShell(child);
        const pullRequests = child.pullRequests ?? [];
        const pendingRequest = pendingRequests.get(child.id);
        const childActivity = {
          ...activity,
          pullRequests,
          pendingSubagentRequest:
            pendingRequest === "user_only_input"
              ? ("user_input" as const)
              : (pendingRequest ?? null),
        };
        const group = resolveThreadActivityGroup(childActivity, clock);
        const quietMinutes = threadQuietMinutes(childActivity, clock);
        if (group === null) continue;
        const { latestRun } = activity;
        const start = Date.parse(
          latestRun?.startedAt ?? latestRun?.requestedAt ?? DateTime.formatIso(child.createdAt),
        );
        const end =
          group === "working" || latestRun?.completedAt == null
            ? now
            : Date.parse(latestRun.completedAt);
        const issue =
          child.linkedIssue === undefined
            ? (child.issues?.[0] ?? null)
            : {
                displayKey: `#${child.linkedIssue.number}`,
                title: child.linkedIssue.title,
                url: child.linkedIssue.url,
              };
        groups[group].push({
          threadId: child.id,
          title: child.title,
          link: threadLink(child.id, child.title),
          issue,
          pullRequestUrl:
            (
              visibleOpenPullRequest(pullRequests) ??
              pullRequests.find((pr) => pr.source !== "stack-dismissed")
            )?.url ?? null,
          lastSummary: summariesById.get(child.id) ?? child.lastError ?? null,
          ...(quietMinutes === null ? {} : { quietMinutes }),
          elapsedMs: Math.max(0, end - start),
        });
      }
      return groups;
    }, Effect.mapError(mapError));
    // Rejected commands are immutable; only a rejected attempt gets a new identity. Retries
    // wait 1 minute after a rejection, doubling up to a day, so a lasting rejection (a
    // deleted model role, an unavailable provider) adds a few receipts, not one per pass.
    const admissionCommandId = Effect.fn("IssueWorkService.admissionCommandId")(function* (
      first: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      let commandId = CommandId.make(first);
      for (let retry = 1; ; retry++) {
        const receipt = yield* commandReceipts
          .getByCommandId(commandId)
          .pipe(Effect.mapError(mapError));
        if (Option.isNone(receipt) || receipt.value.status !== "rejected") return commandId;
        const waitMs = Math.min(2 ** (retry - 1), 1440) * 60_000;
        if (now < receipt.value.acceptedAt.epochMilliseconds + waitMs) return commandId;
        commandId = CommandId.make(`${first}:retry:${retry}`);
      }
    });
    // Queued issues start like milestone issues; their workers wait for a slot ahead of milestone workers.
    const startQueuedIssues = Effect.fn("IssueWorkService.startQueuedIssues")(function* (
      rootThreadId: ThreadId,
    ) {
      const config = yield* store.configuration(rootThreadId);
      // The same phases that admit milestone issues; a draining root takes no new work.
      if (
        config === null ||
        !repositoryAdmitsWork(config) ||
        repositoryPhase(config) === "draining"
      )
        return;
      const suspended = new Set(config.suspendedIssues.map((entry) => entry.id));
      const modelRoleId =
        config.milestones.find((plan) => plan.status === "running")?.modelRoleId ??
        "implementor-complex";
      // shortcut: the entry is re-read after the slow issue-host read, not checked inside the
      // start command, so a withdrawal in the last moment can still start; cancel that worker.
      const stillQueued = (requestId: CommandId) =>
        Effect.map(store.queue(config), (queue) =>
          queue.some((current) => current.requestId === requestId),
        );
      for (const entry of yield* store.queue(config)) {
        if (suspended.has(entry.issue.id)) continue;
        const workState = yield* store.queueWorkState(entry.issue);
        if (workState === "suspending") continue;
        const read =
          workState === "working"
            ? Option.none()
            : yield* issues.workRead(entry.issue).pipe(Effect.option);
        const eligibility =
          Option.isSome(read) &&
          sameIssueRepository(read.value.issue, entry.issue) &&
          read.value.issue.id === entry.issue.id
            ? issueEligibility(read.value)
            : "unknown";
        if (workState === "working" || eligibility === "closed") {
          if (!(yield* stillQueued(entry.requestId))) continue;
          yield* threads
            .dispatch({
              type: "issue.queue.change",
              // Keyed by root, so a removal rejected under a former root is not replayed here.
              commandId: CommandId.make(`issue-queue-settled:${rootThreadId}:${entry.requestId}`),
              threadId: rootThreadId,
              issue: entry.issue,
              queued: false,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not remove a settled queued issue", {
                  issue: entry.issue.number,
                  cause,
                }),
              ),
            );
          continue;
        }
        if (eligibility !== "eligible" || !(yield* stillQueued(entry.requestId))) continue;
        yield* start({
          host: entry.issue.host,
          repository: entry.issue.repository,
          number: entry.issue.number,
          projectId: config.projectId,
          modelRoleId,
          clientRequestId: yield* admissionCommandId(
            `${QUEUED_ISSUE_START_PREFIX}${entry.requestId}`,
          ),
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not start a queued issue", {
              issue: entry.issue.number,
              cause,
            }),
          ),
        );
      }
    });
    const changeQueue = Effect.fn("IssueWorkService.changeQueue")(function* (
      input: IssueQueueInput,
      queued: boolean,
    ) {
      const receipt = yield* commandReceipts
        .getByCommandId(input.clientRequestId)
        .pipe(Effect.mapError(mapError));
      const issue = yield* issues.resolveLinkedIssue(input).pipe(Effect.mapError(mapError));
      if (queued && Option.isNone(receipt)) {
        const read = yield* issues.workRead(input).pipe(Effect.mapError(mapError));
        if (read.state !== "open")
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "Only open issues can be queued.",
          });
      }
      const owner = yield* store.repositoryOwner(issue);
      // A repository mailbox persists requests before its first orchestrator exists.
      const threadId = Option.isSome(receipt)
        ? receipt.value.threadId
        : (owner?.rootThreadId ?? issueQueueMailbox(issue));
      yield* threads
        .dispatch({
          type: "issue.queue.change",
          commandId: input.clientRequestId,
          threadId,
          issue,
          queued,
        })
        .pipe(Effect.mapError(mapError));
      if (owner !== null && queued) {
        const config = (yield* store.configuration(owner.rootThreadId))!;
        if (config.suspendedIssues.some((entry) => entry.id === issue.id))
          yield* resumeWork(
            owner.rootThreadId,
            CommandId.make(`issue-queue-resume:${input.clientRequestId}`),
            issue.id,
          );
      }
      if (owner !== null && queued)
        yield* startQueuedIssues(owner.rootThreadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Queued issue start deferred", {
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
      options?: Pick<
        Extract<OrchestrationV2ServerCommand, { type: "repository.work.update" }>,
        "resumeBlockedIssueId" | "requireControllerModes"
      >,
    ) =>
      threads
        .dispatch({
          type: "repository.work.update",
          threadId: rootThreadId,
          commandId,
          expectedRevision: config.revision,
          orchestration: config,
          ...options,
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
    /** Runs updates and passes serially per root; callers arriving mid-pass share the next pass. */
    const coalescedPerRoot = <E>(pass: (rootThreadId: ThreadId) => Effect.Effect<void, E>) => {
      const passes = new Map<
        ThreadId,
        {
          pending: boolean;
          updates: Array<Effect.Effect<void, E>>;
          done: Deferred.Deferred<void, E>;
        }
      >();
      return (rootThreadId: ThreadId, update?: Effect.Effect<void, E>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const { state, leader } = yield* Effect.sync(() => {
              const existing = passes.get(rootThreadId);
              if (existing !== undefined) {
                existing.pending = true;
                if (update !== undefined) existing.updates.push(update);
                return { state: existing, leader: false };
              }
              const state = {
                pending: false,
                updates: update === undefined ? [] : [update],
                done: Deferred.makeUnsafe<void, E>(),
              };
              passes.set(rootThreadId, state);
              return { state, leader: true };
            });
            if (!leader) return yield* restore(Deferred.await(state.done));
            yield* restore(
              Effect.gen(function* () {
                do {
                  state.pending = false;
                  for (const update of state.updates.splice(0)) yield* update;
                  yield* pass(rootThreadId);
                  // Check and release in one step, so a caller joining now cannot be dropped.
                } while (
                  yield* Effect.sync(() => {
                    if (state.pending) return true;
                    passes.delete(rootThreadId);
                    return false;
                  })
                );
              }),
            ).pipe(
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  if (passes.get(rootThreadId) === state) passes.delete(rootThreadId);
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
        if (config === null || handoff === undefined || repositoryPhase(config) !== "draining")
          return;
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
    const considerAutomaticHandoff = coalescedPerRoot((rootThreadId) =>
      Effect.gen(function* () {
        const config = yield* store.configuration(rootThreadId);
        if (
          config === null ||
          config.handoff !== undefined ||
          repositoryPhase(config) === "retired"
        )
          return;
        const readThreshold = handoffThreshold(config.projectId);
        const attempt = config.automaticHandoff;
        const targetId = automaticHandoffThreadId(rootThreadId);
        let automatic: NonNullable<
          Extract<OrchestrationV2ServerCommand, { type: "repository.work.handoff" }>["automatic"]
        >;
        let brief = "";
        if (attempt?.status === "verifying") {
          const threshold = yield* readThreshold;
          const successor = yield* threads.getThreadShell(targetId).pipe(Effect.mapError(mapError));
          const expired =
            (yield* Clock.currentTimeMillis) - Date.parse(attempt.startedAt) >=
            REPOSITORY_HANDOFF_VERIFICATION_TIMEOUT_MS;
          if (
            threshold !== null &&
            !expired &&
            successor?.pendingRuntimeRequest == null &&
            !(yield* store.subtreeDrained(targetId))
          )
            return;
          automatic = { type: "verify", enabled: threshold !== null };
        } else {
          if ((yield* readThreshold) == null) return;
          const root = yield* threads.getThreadShell(rootThreadId).pipe(Effect.mapError(mapError));
          if (
            root === null ||
            root.archivedAt !== null ||
            root.deletedAt !== null ||
            root.activeRunId !== null ||
            root.pendingRuntimeRequest !== null ||
            root.latestRunId === null ||
            root.latestRunId === attempt?.sourceRunId ||
            root.status !== "completed"
          )
            return;
          const compactions = yield* store.contextFullCompactionCount(rootThreadId);
          // Read after the count so a setting changed meanwhile is the one that applies.
          const threshold = yield* readThreshold;
          if (
            threshold == null ||
            compactions < threshold ||
            !(yield* store.subtreeDrained(rootThreadId)) ||
            !(yield* store.handoffSafe(rootThreadId)) ||
            !(yield* store.subtreeDrained(targetId))
          )
            return;
          const successor = yield* threads.getThreadShell(targetId).pipe(Effect.mapError(mapError));
          if (successor !== null && (successor.archivedAt !== null || successor.deletedAt !== null))
            return;
          automatic = { type: "start", sourceRunId: root.latestRunId, threshold };
          brief = yield* inventory(config);
        }
        yield* threads
          .dispatch({
            type: "repository.work.handoff",
            commandId: yield* ids.allocate
              .command({
                fixtureName: "repository-handoff",
                commandName: automatic.type,
              })
              .pipe(Effect.mapError(mapError)),
            threadId: rootThreadId,
            expectedRevision: config.revision,
            inventory: brief,
            automatic,
          })
          .pipe(Effect.mapError(mapError));
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not continue automatic repository handoff", {
            rootThreadId,
            cause,
          }),
        ),
      ),
    );
    const continueLocal = Effect.fn("IssueWorkService.continueLocal")(function* (
      rootThreadId: ThreadId,
      refreshRequests = false,
      eventSequence?: number,
    ) {
      yield* considerAutomaticHandoff(rootThreadId);
      const config = yield* store.configuration(rootThreadId);
      if (config === null || !repositoryAdmitsWork(config)) return;
      const draining = repositoryPhase(config) === "draining";
      const suspended = new Map(config.suspendedIssues.map((entry) => [entry.id, entry.reason]));
      for (const threadId of yield* store.admissionThreads(rootThreadId)) {
        const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(mapError));
        if (shell == null || shell.activeRunId === null) continue;
        if (
          !isUnmanagedIssueRole(shell.role) &&
          (shell.linkedIssue === undefined || !(yield* store.canAdmit(shell.linkedIssue, threadId)))
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
      // A former worker's queued run would wait forever and hold a drain; cancelling settles
      // its task through the parent.
      for (const run of yield* store.strandedQueuedRuns(rootThreadId))
        yield* threads
          .dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`stranded-queued-run-cancel:${run.runId}`),
            threadId: run.threadId,
            runId: run.runId,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not cancel a queued run its root can never start", {
                cause,
              }),
            ),
          );
      if (draining) return yield* drainHandoff(rootThreadId);
      // Once an ancestor has a durable thread, deliver its selected sub-issues there.
      for (const request of yield* store.pendingRequests(rootThreadId)) {
        const read = refreshRequests
          ? yield* issues.workRead(request.issue).pipe(Effect.option)
          : Option.none();
        if (refreshRequests && (Option.isNone(read) || issueEligibility(read.value) !== "eligible"))
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

    const reconcilePass = Effect.fn("IssueWorkService.reconcilePass")(function* (
      rootThreadId: ThreadId,
    ) {
      yield* considerAutomaticHandoff(rootThreadId);
      let config = yield* store.configuration(rootThreadId);
      if (config?.handoff?.status === "awaiting_approval") {
        const root = yield* threads.getThreadShell(rootThreadId).pipe(Effect.mapError(mapError));
        if (root !== null && hasRepositoryControllerModes(root)) {
          yield* update(
            rootThreadId,
            {
              ...config,
              paused: true,
              handoff: { ...config.handoff, status: "draining", wasPaused: config.paused },
            },
            yield* ids.allocate
              .command({ fixtureName: "repository-handoff", commandName: "resume" })
              .pipe(Effect.mapError(mapError)),
            { requireControllerModes: true },
          );
          config = yield* store.configuration(rootThreadId);
        }
      }
      if (config === null || !repositoryAdmitsWork(config)) return;
      const suspended = new Map(config.suspendedIssues.map((entry) => [entry.id, entry]));
      for (const threadId of yield* store.workerThreads(rootThreadId)) {
        const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(mapError));
        if (
          shell?.linkedIssue === undefined ||
          (!isAutomaticIssueSuspension(suspended.get(shell.linkedIssue.id)) &&
            shell.activeRunId === null &&
            shell.status !== "queued" &&
            (shell.pendingBackgroundTasks?.length ?? 0) === 0 &&
            ((yield* store.resultAvailable(threadId)) ||
              (yield* progressFor(threadId, false)).progress.state === "result_available"))
        )
          continue;
        // Closed and re-parented attempts still require an explicit Resume decision.
        const priorReason = suspended.get(shell.linkedIssue.id);
        if (priorReason !== undefined && !isAutomaticIssueSuspension(priorReason)) continue;
        const read = yield* issues
          .workRead(shell.linkedIssue, { cached: true })
          .pipe(Effect.result);
        let reason: string | null = null;
        let kind: IssueSuspensionKind = "reparented";
        if (read._tag === "Failure") {
          if (read.failure.code !== "inaccessible" && read.failure.code !== "unauthenticated")
            continue;
          kind = "unreadable";
          reason = unreadableRelationshipsSuspensionReason;
        } else if (issueEligibility(read.success) === "unknown") continue;
        else if (read.success.state === "closed") {
          kind = "closed";
          reason = CLOSED_ISSUE_SUSPENSION_REASON;
        } else if (issueEligibility(read.success) === "blocked") {
          kind = "blocked";
          reason = openBlockerSuspensionReason;
        } else {
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
            !isAutomaticIssueSuspension(suspended.get(shell.linkedIssue.id)) ||
            config.paused ||
            repositoryPhase(config) === "draining"
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
            { resumeBlockedIssueId: resumedIssueId },
          );
          config = (yield* store.configuration(rootThreadId))!;
          continue;
        }
        if (
          suspended.get(shell.linkedIssue.id)?.reason === reason &&
          suspended.get(shell.linkedIssue.id)?.kind === kind
        )
          continue;
        suspended.set(shell.linkedIssue.id, { id: shell.linkedIssue.id, reason, kind });
        config = {
          ...config,
          suspendedIssues: [...suspended.values()],
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
      // Queued issues start before continueLocal promotes waiting milestone workers into free slots.
      yield* startQueuedIssues(rootThreadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Queued issue starts failed", { rootThreadId, cause }),
        ),
      );
      yield* continueLocal(rootThreadId, true);
      config = (yield* store.configuration(rootThreadId))!;
      if (
        !repositoryAdmitsWork(config) ||
        repositoryPhase(config) === "draining" ||
        config.milestones.length === 0
      )
        return;
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
        const reads = yield* issues
          .workReads(
            config,
            selected.map((issue) => issue.number),
          )
          .pipe(Effect.option);
        let unreadable = false,
          blocked = false,
          awaiting = false,
          running = false;
        const fingerprint: string[] = [];
        for (const issue of selected) {
          const read = reads._tag === "Some" ? reads.value.get(issue.number) : undefined;
          if (read === undefined) {
            unreadable = true;
            fingerprint.push(`${issue.number}:unknown`);
            continue;
          }
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
          const clientRequestId = yield* admissionCommandId(
            `milestone-issue:${rootThreadId}:${plan.number}:${read.issue.id}:first`,
          );
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

    const reconcile = coalescedPerRoot(reconcilePass);

    const workMilestone = Effect.fn("IssueWorkService.workMilestone")(function* (
      input: Parameters<IssueWorkService["Service"]["workMilestone"]>[0],
    ) {
      if (!(yield* issues.capabilities(input.host)).milestones)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: `The issue host for ${input.repository} does not support milestones.`,
        });
      const listing = yield* issues.milestoneIssues(input).pipe(Effect.result);
      if (listing._tag === "Success" && listing.success.missing)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: `Milestone #${input.milestoneNumber} does not exist in ${input.repository}.`,
        });
      let owner = yield* store.repositoryOwnerByRef(input);
      if (owner === null) {
        const repository = yield* issues.repositoryIdentity(input).pipe(Effect.mapError(mapError));
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
    const setLimit = Effect.fn("IssueWorkService.setLimit")(function* (
      input: RepositoryWorkerLimitInput | RepositoryReadOnlyLimitInput,
    ) {
      yield* decodeLimit(input).pipe(
        Effect.mapError(
          () =>
            new IssueWorkError({
              code: "invalid-request",
              message: "Use an integer limit from 1 to 32 and the current repository revision.",
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
      if (repositoryPhase(config) === "draining")
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "A handoff is draining. Cancel the handoff before changing the limit.",
        });
      const field = "workerLimit" in input ? "workerLimit" : "readOnlyLimit";
      const limit = "workerLimit" in input ? input.workerLimit : input.readOnlyLimit;
      if (limit !== config[field])
        yield* update(owner.rootThreadId, { ...config, [field]: limit }, input.clientRequestId);
      if (limit > config[field] && !config.paused)
        yield* reconcile(owner.rootThreadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Issue queue continuation after limit change failed", {
              rootThreadId: owner.rootThreadId,
              cause,
            }),
          ),
        );
      return yield* repositoryStatus(input);
    });
    const closeOut = Effect.fn("IssueWorkService.closeOut")(function* (
      input: IssueWorkCloseOutInput,
      callerThreadId?: ThreadId,
    ) {
      const owner = yield* store.repositoryOwnerByRef(input);
      if (owner === null)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "This repository has no registered orchestrator.",
        });
      if (callerThreadId !== undefined && owner.rootThreadId !== callerThreadId)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Only the registered repository orchestrator can close out an issue attempt.",
        });
      const workerId = yield* store.retainedWorkerThread(owner.rootThreadId, input.issueId);
      const worker =
        workerId === null
          ? null
          : yield* threads.getThreadShell(workerId).pipe(Effect.mapError(mapError));
      if (worker?.linkedIssue?.id !== input.issueId)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "The issue has no current attempt under this repository orchestrator.",
        });
      yield* threads
        .dispatch({
          type: "issue.work.close-out",
          commandId: input.clientRequestId,
          threadId: owner.rootThreadId,
          issueThreadId: worker.id,
          issue: worker.linkedIssue,
          expectedRevision: input.expectedRevision,
        })
        .pipe(Effect.mapError(mapError));
      return yield* repositoryStatus(input);
    });

    const resumeWork = Effect.fn("IssueWorkService.resumeWork")(
      function* (rootThreadId: ThreadId, commandId: CommandId, issueId?: string) {
        const config = (yield* store.configuration(rootThreadId))!;
        if (repositoryPhase(config) === "draining")
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "A handoff is draining. Cancel the handoff before resuming work.",
          });
        const suspendedIssues =
          issueId === undefined
            ? []
            : config.suspendedIssues.filter((entry) => entry.id !== issueId);
        const paused = issueId === undefined ? false : config.paused;
        // Explicit Resume removes only the chosen suspensions; reconcile still validates GitHub.
        if (paused === config.paused && suspendedIssues.length === config.suspendedIssues.length)
          return;
        const publish = update(rootThreadId, { ...config, paused, suspendedIssues }, commandId);
        if (paused === config.paused) return yield* publish;
        // Terminal reactions can try to fill a slot between unpausing and admitting queued issues.
        yield* store.withQueuedIssuePriority(
          rootThreadId,
          publish.pipe(Effect.andThen(startQueuedIssues(rootThreadId))),
        );
      },
      (effect, rootThreadId) => reconcile(rootThreadId, effect),
    );

    const endRepository: IssueWorkService["Service"]["endRepository"] = Effect.fn(
      "IssueWorkService.endRepository",
    )(function* (input) {
      const owner = yield* store.repositoryOwnerByRef(input);
      if (owner === null)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "This repository has no registered orchestrator.",
        });
      yield* threads
        .dispatch({
          type: "repository.work.end",
          commandId: input.clientRequestId,
          threadId: owner.rootThreadId,
          expectedRevision: input.expectedRevision,
        })
        .pipe(Effect.mapError(mapError));
      return yield* repositoryStatus(input);
    });

    const setPaused: IssueWorkService["Service"]["setPaused"] = Effect.fn(
      "IssueWorkService.setPaused",
    )(function* (input) {
      const owner = yield* store.repositoryOwnerByRef(input);
      if (owner === null)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "This repository has no registered orchestrator.",
        });
      const config = (yield* store.configuration(owner.rootThreadId))!;
      if (repositoryPhase(config) === "draining")
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "A handoff is draining. Cancel the handoff before changing the pause state.",
        });
      if (input.paused) {
        if (!config.paused)
          yield* update(owner.rootThreadId, { ...config, paused: true }, input.clientRequestId);
      } else {
        yield* resumeWork(owner.rootThreadId, input.clientRequestId);
      }
      return yield* repositoryStatus(input);
    });

    const validateLead = Effect.fn("IssueWorkService.validateLead")(function* (
      input: RepositoryOrchestratorInput,
      moveTo?: RepositoryWorkRestoreInput,
      moveUnpaused = false,
    ) {
      yield* assertProjectRepository(input.projectId, input);
      const target = yield* threads
        .getThreadShell(input.targetThreadId)
        .pipe(Effect.mapError(mapError));
      const adapter =
        target === null
          ? undefined
          : yield* adapters.get(target.modelSelection.instanceId).pipe(Effect.mapError(mapError));
      const registered =
        target === null ? undefined : ((yield* store.configuration(target.id)) ?? undefined);
      const movable =
        moveTo !== undefined &&
        isMovableRepositoryRegistration(registered, moveTo, moveUnpaused) &&
        // An unpaused record with queued issues is refused before any command is stored.
        (registered.paused || (yield* store.queue(registered)).length === 0);
      if (
        target === null ||
        !isRepositoryOrchestratorEligible(
          { ...target, repositoryOrchestration: movable ? undefined : registered },
          adapter?.driver,
          input,
        )
      )
        return yield* new IssueWorkError({
          code: "invalid-request",
          message:
            "Select an existing active top-level Orchestrator thread in the same repository project using Codex or Claude.",
        });
      yield* assertRootCheckout({
        projectId: input.projectId,
        commandId: input.clientRequestId,
        worktreePath: target.worktreePath,
      });
      return target;
    });
    const prepareHandoff = Effect.fn("IssueWorkService.prepareHandoff")(function* (
      input: RepositoryHandoffRequestInput,
      callerThreadId?: ThreadId,
    ) {
      const owner = yield* store.repositoryOwnerByRef(input);
      if (callerThreadId !== undefined) yield* assertCurrentCaller(callerThreadId);
      if (owner === null || (callerThreadId !== undefined && callerThreadId !== owner.rootThreadId))
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Only the registered repository root can request a handoff.",
        });
      if (input.targetThreadId === owner.rootThreadId)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Choose a different thread for the repository handoff.",
        });
      const config = (yield* store.configuration(owner.rootThreadId))!;
      if (config.automaticHandoff?.status === "verifying")
        return yield* new IssueWorkError({
          code: "repository-owner-conflict",
          message: "This repository already has an automatic handoff in verification.",
        });
      if (
        config.handoff?.requestId === input.clientRequestId &&
        config.handoff.status === "draining"
      )
        return yield* repositoryStatus(input);
      if (config.revision !== input.expectedRevision)
        return yield* new IssueWorkError({
          code: "repository-owner-conflict",
          message: "Repository ownership changed. Refresh before starting a handoff.",
        });
      if (
        config.handoff !== undefined &&
        (callerThreadId !== undefined || config.handoff.status !== "awaiting_approval")
      )
        return yield* new IssueWorkError({
          code: "repository-owner-conflict",
          message: "This repository already has a pending handoff. Wait or cancel it first.",
        });
      const root = yield* threads
        .getThreadShell(owner.rootThreadId)
        .pipe(Effect.mapError(mapError));
      if (root === null || root.archivedAt !== null || root.deletedAt !== null)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Restore the repository root before handing it off.",
        });
      const existingTarget =
        input.targetThreadId === undefined
          ? undefined
          : yield* validateLead({
              ...input,
              projectId: owner.projectId,
              targetThreadId: input.targetThreadId,
            });
      const selection =
        existingTarget?.modelSelection ??
        input.modelSelection ??
        config.handoff?.modelSelection ??
        root.modelSelection;
      if (
        config.handoff !== undefined &&
        ((input.targetThreadId !== undefined &&
          input.targetThreadId !== config.handoff.nextThreadId) ||
          input.summary !== config.handoff.summary ||
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
          paused: true,
          handoff: {
            requestId,
            nextThreadId:
              input.targetThreadId ??
              config.handoff?.nextThreadId ??
              ids.derive.delegatedTaskThread({
                commandId: CommandId.make(`repository-handoff:${requestId}`),
              }),
            summary: input.summary,
            modelSelection: selection,
            status: "draining",
            wasPaused: config.paused,
            // A proposal from before requestedAt existed stays undated rather than dated at approval.
            requestedAt:
              config.handoff === undefined
                ? DateTime.formatIso(yield* DateTime.now)
                : config.handoff.requestedAt,
          },
        },
        input.clientRequestId,
        callerThreadId === undefined ? undefined : { requireControllerModes: true },
      );
      yield* reconcile(owner.rootThreadId);
      return yield* repositoryStatus(input);
    });
    const handoff: IssueWorkService["Service"]["handoff"] = (input) =>
      input.action === "approve"
        ? prepareHandoff(input)
        : Effect.gen(function* () {
            const owner = yield* store.repositoryOwnerByRef(input);
            const config = owner === null ? null : yield* store.configuration(owner.rootThreadId);
            const refuse = (message: string) =>
              new IssueWorkError({ code: "repository-owner-conflict", message });
            if (owner === null || config === null)
              return yield* refuse(
                `No repository orchestrator is registered for ${input.host}/${input.repository}.`,
              );
            if (config.handoff === undefined)
              return yield* refuse(`${input.repository} has no pending handoff to cancel.`);
            if (config.revision !== input.expectedRevision)
              return yield* refuse(
                `Repository work changed (revision ${config.revision}, expected ${input.expectedRevision}). Refresh before cancelling.`,
              );
            yield* update(
              owner.rootThreadId,
              {
                ...config,
                paused:
                  repositoryPhase(config) === "draining" ? config.handoff.wasPaused : config.paused,
                handoff: undefined,
              },
              input.clientRequestId,
            );
            if (repositoryPhase(config) === "draining" && !config.handoff.wasPaused)
              yield* reconcile(owner.rootThreadId);
            return yield* repositoryStatus(input);
          });

    const cancelRequest = Effect.fn("IssueWorkService.cancelRequest")(function* (
      input: Parameters<IssueWorkService["Service"]["cancelRequest"]>[0],
    ) {
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

    const restoreRoot = Effect.fn("IssueWorkService.restoreRoot")(function* (
      input: Parameters<IssueWorkService["Service"]["restoreRoot"]>[0],
      options?: {
        readonly verifyStatusIdentity?: boolean;
        // No screen shows a project's previous repository, so a user assignment cannot pause it first.
        readonly moveUnpaused?: boolean;
      },
    ) {
      const moveUnpaused = options?.moveUnpaused ?? false;
      yield* validateLead(
        input,
        input.expectedRootThreadId === null ? input : undefined,
        moveUnpaused,
      );
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
          ...(moveUnpaused ? { moveUnpaused } : {}),
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
      return yield* repositoryStatus(input, {
        verifyIdentity: options?.verifyStatusIdentity ?? true,
      });
    });

    const assignOrchestrator = Effect.fn("IssueWorkService.assignOrchestrator")(
      function* (input: RepositoryOrchestratorInput) {
        const owner = yield* store.repositoryOwnerByRef(input);
        if (owner?.rootThreadId === input.targetThreadId) {
          yield* validateLead(input);
          return yield* repositoryStatus(input);
        }
        if (owner !== null) {
          if (owner.projectId !== input.projectId)
            return yield* new IssueWorkError({
              code: "repository-owner-conflict",
              message: "Select a thread in the registered repository orchestrator's project.",
            });
          return yield* handoff({
            ...input,
            action: "approve",
            expectedRevision: owner.revision,
            summary: `User selected existing thread ${input.targetThreadId} as repository orchestrator.`,
          });
        }
        const identity = yield* issues.repositoryIdentity(input).pipe(Effect.mapError(mapError));
        return yield* restoreRoot(
          {
            ...input,
            repositoryId: identity.repositoryId,
            expectedRootThreadId: null,
            expectedRevision: null,
            reason: "User selected this existing lead for repository orchestration",
          },
          { moveUnpaused: true },
        );
      },
      (effect, input) =>
        assignments.withLock(
          `${input.host.toLowerCase()}/${input.repository.toLowerCase()}`,
          effect,
        ),
    );
    const ensureOrchestrator = Effect.fn("IssueWorkService.ensureOrchestrator")(
      function* (input: IssueRepositoryRef) {
        const current = yield* repositoryStatus(input);
        if (current.rootThreadId !== null) return current;
        const candidates = [];
        for (const project of yield* projects.listShells().pipe(Effect.mapError(mapError))) {
          const identity = project.repositoryIdentity;
          const names = [
            identity?.origin?.displayName,
            sourceControlDefinitions.repositorySelector(identity),
          ];
          if (
            issueRepositoryOf(identity)?.host !== input.host.toLowerCase() ||
            !names.some((name) => name?.toLowerCase() === input.repository.toLowerCase())
          )
            continue;
          for (const entry of yield* threads
            .listProjectThreads({ projectId: project.id, includeSubagents: false })
            .pipe(Effect.mapError(mapError))) {
            const thread = yield* threads.getThreadShell(entry.id).pipe(Effect.mapError(mapError));
            if (thread === null || (yield* store.configuration(thread.id)) !== null) continue;
            const adapter = yield* adapters
              .get(thread.modelSelection.instanceId)
              .pipe(Effect.option);
            if (
              isRepositoryOrchestratorEligible(
                thread,
                Option.isSome(adapter) ? adapter.value.driver : undefined,
                { ...input, projectId: project.id },
              )
            )
              candidates.push(thread);
          }
        }
        candidates.sort(
          (a, b) =>
            DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
            b.id.localeCompare(a.id),
        );
        const target = candidates[0];
        if (target === undefined) return current;
        const identity = yield* issues.repositoryIdentity(input).pipe(Effect.mapError(mapError));
        yield* restoreRoot({
          ...input,
          repositoryId: identity.repositoryId,
          projectId: target.projectId,
          targetThreadId: target.id,
          expectedRootThreadId: null,
          expectedRevision: null,
          reason: "Repository work needs an orchestrator",
          clientRequestId: yield* ids.allocate
            .command({ fixtureName: "repository-auto-root", commandName: target.id })
            .pipe(Effect.mapError(mapError)),
        }).pipe(
          Effect.catch((error) =>
            store
              .repositoryOwnerByRef(input)
              .pipe(
                Effect.flatMap((owner) =>
                  owner !== null || error.code === "invalid-request"
                    ? Effect.void
                    : Effect.fail(error),
                ),
              ),
          ),
        );
        return yield* repositoryStatus(input);
      },
      (effect, input) =>
        assignments.withLock(
          `${input.host.toLowerCase()}/${input.repository.toLowerCase()}`,
          effect,
        ),
    );

    const service = IssueWorkService.of({
      assignOrchestrator,
      ensureOrchestrator,
      workStatus: Effect.fn("IssueWorkService.workStatus")(function* (
        input: Parameters<IssueWorkService["Service"]["workStatus"]>[0],
      ) {
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
      queueIssue: Effect.fn("IssueWorkService.queueIssue")((input) => changeQueue(input, true)),
      unqueueIssue: Effect.fn("IssueWorkService.unqueueIssue")((input) =>
        changeQueue(input, false),
      ),
      start: Effect.fn("IssueWorkService.start")((input) => start(input)),
      startWorker,
      cancelRequest,
      restoreRoot,
      workMilestone,
      childrenStatus,
      repositoryStatus,
      endRepository,
      setPaused,
      closeOut,
      setWorkerLimit: setLimit,
      setReadOnlyLimit: setLimit,
      assertCurrentCaller,
      requestHandoff: Effect.fn("IssueWorkService.requestHandoff")((threadId, input) =>
        prepareHandoff(input, threadId),
      ),
      handoff,
      reconcile,
    });
    const savedSprintRoots = yield* store
      .usageSprintRoots()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read saved usage sprints", { cause }).pipe(Effect.as([])),
        ),
      );
    for (const rootThreadId of savedSprintRoots) {
      yield* Effect.gen(function* () {
        const config = yield* store.configuration(rootThreadId);
        if (config?.usageSprint === undefined) return;
        const { usageSprint, ...rest } = config;
        const children: Array<{ threadId: ThreadId; issue?: ThreadLinkedIssue }> = [];
        for (const threadId of yield* store.runningLineageChildren(rootThreadId)) {
          const issue = (yield* threads.getThreadShell(threadId))?.linkedIssue;
          children.push({ threadId, ...(issue === undefined ? {} : { issue }) });
        }
        const now = yield* DateTime.now;
        yield* update(
          rootThreadId,
          {
            ...rest,
            usageSprintHistory: [
              ...(config.usageSprintHistory ?? []),
              {
                providerInstanceId: usageSprint.providerInstanceId,
                startedAt: usageSprint.startedAt,
                endedAt: DateTime.formatIso(now),
                reason: "stopped",
                children,
              },
            ],
          },
          CommandId.make(`retire-usage-sprint:${rootThreadId}:${config.revision}`),
        );
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not retire saved usage sprint", { rootThreadId, cause }),
        ),
      );
    }
    const scheduler = yield* Effect.serviceOption(Scheduler.Scheduler);
    if (Option.isSome(scheduler)) {
      let nextReadAt = 0;
      yield* scheduler.value.register(
        "repository-issue-work",
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (now < nextReadAt) return;
          nextReadAt = now + 60_000;
          for (const root of yield* store.handoffRoots()) yield* considerAutomaticHandoff(root);
          for (const root of yield* store.activeRoots()) {
            yield* reconcile(root).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Repository reconcile failed", { root, cause }),
              ),
            );
          }
        }),
      );
    }
    const sink = yield* Effect.serviceOption(EventSink.EventSinkV2);
    if (Option.isSome(sink)) {
      const pendingRoots = new Map<ThreadId, number | null>();
      const wake = yield* Queue.sliding<void>(1);
      const queueHandoffCheck = (root: ThreadId) => {
        if (!pendingRoots.has(root)) pendingRoots.set(root, null);
        return Queue.offer(wake, undefined);
      };
      yield* Effect.gen(function* () {
        while (true) {
          yield* Queue.take(wake);
          for (const [root, eventSequence] of pendingRoots) {
            pendingRoots.delete(root);
            yield* (
              eventSequence === null
                ? considerAutomaticHandoff(root)
                : continueLocal(root, false, eventSequence)
            ).pipe(
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
                (stored.event.payload.repositoryOrchestration !== undefined ||
                  String(stored.commandId).startsWith("storage-cleanup:release-slot:"))) ||
              stored.event.type === "thread.unarchived" ||
              stored.event.type === "thread.archived" ||
              stored.event.type === "thread.deleted" ||
              stored.event.type === "thread.settled" ||
              stored.event.type === "repository.work.restored" ||
              (stored.event.type === "issue.queue.updated" &&
                stored.event.payload.state === "queued") ||
              (stored.event.type === "subagent.updated" &&
                ["completed", "failed", "interrupted", "cancelled"].includes(
                  stored.event.payload.status,
                )) ||
              stored.event.type === "runtime-request.updated" ||
              (stored.event.type === "turn-item.updated" &&
                stored.event.payload.type === "compaction" &&
                stored.event.payload.status === "completed" &&
                stored.event.payload.contextFullCompactionId !== undefined) ||
              (stored.event.type === "provider-thread.updated" &&
                (stored.event.payload.pendingBackgroundTasks?.length ?? 0) === 0) ||
              ((stored.event.type === "run.updated" || stored.event.type === "run.created") &&
                ["queued", "preparing", "completed", "failed", "interrupted", "cancelled"].includes(
                  stored.event.payload.status,
                ))),
        ),
        Stream.runForEach((stored) =>
          Effect.gen(function* () {
            if (
              stored.event.type === "thread.metadata-updated" &&
              !String(stored.commandId).startsWith("storage-cleanup:release-slot:")
            ) {
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
            const shell = yield* threads
              .getThreadShell(stored.event.threadId)
              .pipe(Effect.mapError(mapError));
            const predecessor = shell?.handoffFromThreadId;
            if (
              predecessor !== undefined &&
              (stored.event.type === "run.updated" ||
                stored.event.type === "runtime-request.updated" ||
                stored.event.type === "thread.archived" ||
                stored.event.type === "thread.unarchived" ||
                stored.event.type === "thread.deleted")
            ) {
              yield* queueHandoffCheck(predecessor);
            }
            const repository =
              (stored.event.type === "issue.queue.updated"
                ? stored.event.payload.issue
                : shell?.linkedIssue) ??
              (yield* store.configuration(shell?.lineage.rootThreadId ?? stored.event.threadId));
            if (repository == null) return;
            if (
              stored.event.type === "issue.queue.updated" &&
              (yield* store.queue(repository)).length > 0 &&
              (yield* store.repositoryOwner(repository)) === null
            ) {
              const adopted = (yield* ensureOrchestrator(repository)).rootThreadId;
              // Forked: a slow issue-host read must not hold up other repositories' events.
              if (adopted !== null)
                yield* reconcile(adopted).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Queued issue starts after adoption failed", {
                      root: adopted,
                      cause,
                    }),
                  ),
                  Effect.forkDetach,
                );
            }
            const owner = yield* store.repositoryOwner(repository);
            if (owner !== null && stored.event.type !== "thread.metadata-updated") {
              yield* queueHandoffCheck(owner.rootThreadId);
            }
            if (
              owner !== null &&
              !isUnmanagedIssueRole(shell?.role) &&
              (shell?.linkedIssue === undefined ||
                stored.event.type === "subagent.updated" ||
                stored.event.type === "runtime-request.updated" ||
                stored.event.type === "provider-thread.updated") &&
              ((config) => config === null || repositoryPhase(config) !== "draining")(
                yield* store.configuration(owner.rootThreadId),
              )
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
    return service;
  }),
);
