import {
  CommandId,
  IssueWorkError,
  type IssueRef,
  type IssueWorkStartInput,
  type IssueWorkStartResult,
  type IssueWorkStatusResult,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
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
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { delegatedTaskProgress } from "../orchestration-v2/SubagentProjection.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { checkDelegateTarget } from "../mcp/delegateTaskTarget.ts";

export class IssueWorkService extends Context.Service<
  IssueWorkService,
  {
    readonly start: (
      input: IssueWorkStartInput,
    ) => Effect.Effect<IssueWorkStartResult, IssueWorkError>;
    readonly workStatus: (input: IssueRef) => Effect.Effect<IssueWorkStatusResult, IssueWorkError>;
  }
>()("t3/issues/IssueWorkService") {}

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
    const mapError = (cause: unknown) =>
      new IssueWorkError({
        code: "orchestration-error",
        message: cause instanceof Error ? cause.message : String(cause),
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

    return IssueWorkService.of({
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
              root === null
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
            };
          }
          return {
            issue: input,
            projectId: root?.projectId ?? null,
            rootThreadId: root?.rootThreadId ?? null,
            threadId: owner,
            status: (yield* progressFor(owner, root?.paused ?? false)).status,
            publishing: yield* store.publishing(owner, issue),
          };
        }),
      start: (input) =>
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
              status: "queued_preparing",
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
          let root = yield* store.repositoryOwner(issue);
          if (root !== null && root.projectId !== input.projectId)
            return yield* new IssueWorkError({
              code: "invalid-request",
              message:
                "This repository already uses another project. Select the registered orchestrator project.",
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
          const capableIds = new Set(yield* adapters.list());
          let selection: ModelSelection | undefined;
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
          }
          if (selection === undefined)
            return yield* new IssueWorkError({
              code: "invalid-request",
              message: "No available target in the selected model role.",
            });
          let createdRoot = false;
          if (root === null) {
            const project = yield* projects
              .getById(input.projectId)
              .pipe(Effect.mapError(mapError));
            const identity = Option.isSome(project) ? project.value.repositoryIdentity : null;
            const repository =
              identity?.originRepository ?? sourceControlRepositorySelector(identity);
            const upstream = sourceControlRepositorySelector(identity);
            if (
              identity?.provider !== "github" ||
              pullRequestHostOf(identity, "github").toLowerCase() !== issue.host.toLowerCase() ||
              (repository?.toLowerCase() !== issue.repository.toLowerCase() &&
                upstream?.toLowerCase() !== issue.repository.toLowerCase())
            )
              return yield* new IssueWorkError({
                code: "invalid-request",
                message: "Select a project whose GitHub repository matches this issue.",
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
                workspaceStrategy: { type: "root" },
                repositoryOrchestration: {
                  host: issue.host,
                  repository: issue.repository,
                  repositoryId: issue.repositoryId,
                  projectId: input.projectId,
                  workspace: input.workspace,
                  launchCommandId: commandId,
                  revision: 1,
                  paused: false,
                  workerLimit: 4,
                  publishStatusComments: true,
                  publishCloseoutComments: true,
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
          const rootShell = yield* threads
            .getThreadShell(root.rootThreadId)
            .pipe(Effect.mapError(mapError));
          if (rootShell === null || rootShell.archivedAt !== null || rootShell.deletedAt !== null)
            return yield* new IssueWorkError({
              code: "invalid-request",
              message:
                "The registered repository orchestrator is unavailable. Restore it to resume issue work.",
            });
          const dispatched = yield* threads
            .dispatch({
              type: "issue.work.start",
              commandId: input.clientRequestId,
              threadId: root.rootThreadId,
              issue,
              workerModelSelection: selection,
              workspace: input.workspace,
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.mapError(mapError));
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
        }),
    });
  }),
);
