import {
  CommandId,
  MessageId,
  IssueWorkError,
  type IssueRef,
  type IssueWorkStartInput,
  type IssueWorkStartResult,
  type IssueWorkStatusResult,
  type ModelSelection,
  type RepositoryWorkInput,
  type RepositoryWorkControlInput,
  type RepositoryWorkResult,
  type RepositoryOrchestration,
  type ThreadId,
  type IssueWorkRead,
  type ThreadLinkedIssue,
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
import {
  issueEligibility,
  sameIssueRepository,
  supportsManagedIssueWork,
  issueScopeExpansionError,
} from "./IssueEligibility.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

const encodeToolArgument = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class IssueWorkService extends Context.Service<
  IssueWorkService,
  {
    readonly start: (
      input: IssueWorkStartInput,
    ) => Effect.Effect<IssueWorkStartResult, IssueWorkError>;
    readonly workStatus: (input: IssueRef) => Effect.Effect<IssueWorkStatusResult, IssueWorkError>;
    readonly workMilestone: (
      input: RepositoryWorkInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly repositoryStatus: (
      input: Pick<IssueRef, "host" | "repository">,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly setPaused: (
      input: RepositoryWorkControlInput,
    ) => Effect.Effect<RepositoryWorkResult, IssueWorkError>;
    readonly reconcile: (rootThreadId: ThreadId) => Effect.Effect<void, IssueWorkError>;
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

    const ensureRoot = (
      input: Pick<IssueWorkStartInput, "projectId" | "modelRoleId" | "workspace">,
      issue: Pick<ThreadLinkedIssue, "host" | "repository" | "repositoryId">,
    ) =>
      Effect.gen(function* () {
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
        const capableIds = new Set<import("@t3tools/contracts").ProviderInstanceId>();
        for (const instanceId of yield* adapters.list()) {
          const adapter = yield* adapters.get(instanceId).pipe(Effect.mapError(mapError));
          if (supportsManagedIssueWork(adapter.driver)) capableIds.add(instanceId);
        }
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
            message:
              "Managed issue work requires an available Codex or Claude target in the selected model role; other adapters allow untracked native children.",
          });
        let createdRoot = false;
        if (root === null) {
          const project = yield* projects.getById(input.projectId).pipe(Effect.mapError(mapError));
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
            if ((yield* store.issueOwner(ancestor.parent)) !== null) break;
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
        const { root, selection, createdRoot } = yield* ensureRoot(input, issue);
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
      });

    const repositoryStatus: IssueWorkService["Service"]["repositoryStatus"] = (input) =>
      Effect.gen(function* () {
        const owner = yield* store.repositoryOwnerByRef(input);
        return {
          rootThreadId: owner?.rootThreadId ?? null,
          orchestration: owner === null ? null : yield* store.configuration(owner.rootThreadId),
        };
      });
    const update = (
      rootThreadId: ThreadId,
      config: RepositoryOrchestration,
      commandId: CommandId,
    ) =>
      threads
        .dispatch({
          type: "repository.work.update",
          threadId: rootThreadId,
          commandId,
          expectedRevision: config.revision,
          orchestration: config,
        })
        .pipe(Effect.mapError(mapError), Effect.asVoid);
    const continueLocal = (
      rootThreadId: ThreadId,
      refreshRequests = false,
      eventSequence?: number,
    ) =>
      Effect.gen(function* () {
        const config = yield* store.configuration(rootThreadId);
        if (config === null || config.paused) return;
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
            yield* launch
              .prepareDeferredRun({
                commandId:
                  run.workspacePreparationCommandId ?? CommandId.make(`issue-prepare:${run.id}`),
                projectId: shell.projectId,
                threadId,
                runId: run.id,
                workspaceStrategy: run.workspacePreparation,
              })
              .pipe(Effect.mapError(mapError));
        }
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
          const parentOwner = yield* store.issueOwner(parent);
          if (parentOwner === null || suspended.has(request.issue.id) || suspended.has(parent.id))
            continue;
          const parentShell = yield* threads
            .getThreadShell(parentOwner)
            .pipe(Effect.mapError(mapError));
          if (parentShell?.lineage.rootThreadId !== rootThreadId) continue;
          const issueArgument = yield* encodeToolArgument(request.issue).pipe(
            Effect.mapError(mapError),
          );
          const targetArgument = yield* encodeToolArgument({
            providerInstanceId: request.modelSelection.instanceId,
            model: request.modelSelection.model,
            ...(request.modelSelection.options === undefined
              ? {}
              : { options: request.modelSelection.options }),
          }).pipe(Effect.mapError(mapError));
          yield* threads
            .sendToThread({
              projectId: config.projectId,
              threadId: parentOwner,
              commandId: CommandId.make(`issue-parent-start:${request.requestId}:${parentOwner}`),
              messageId: MessageId.make(`issue-parent-start:${request.requestId}:${parentOwner}`),
              text: `Start your authorized sub-issue #${request.issue.number}: ${request.issue.title}\n${request.issue.url}\nDelegate through delegate_task with issue=${issueArgument}, mode=async, workspace=${request.workspace === "worktree" ? "worktree" : "inherit"}, target=${targetArgument}. Finish your turn while children work.`,
              attachments: [],
              mode: "queue",
              createdBy: "agent",
              creationSource: "server",
            })
            .pipe(Effect.mapError(mapError));
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
        if (config === null || config.paused) return;
        const suspended = new Map(config.suspendedIssues.map((entry) => [entry.id, entry.reason]));
        for (const threadId of yield* store.workerThreads(rootThreadId)) {
          const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(mapError));
          if (
            shell?.linkedIssue === undefined ||
            (shell.activeRunId === null &&
              shell.status !== "queued" &&
              (shell.pendingBackgroundTasks?.length ?? 0) === 0 &&
              (yield* store.resultAvailable(threadId)))
          )
            continue;
          const read = yield* issues.workRead(shell.linkedIssue).pipe(Effect.result);
          let reason: string | null = null;
          if (read._tag === "Failure" || issueEligibility(read.success) === "unknown")
            reason = "Issue relationships are unreadable. Restore access before resuming.";
          else if (read.success.state === "closed")
            reason =
              "Issue closed during work. Decide whether to resume or close out the retained result.";
          else if (issueEligibility(read.success) === "blocked")
            reason = "A GitHub blocker is open. Resolve it before resuming.";
          else {
            const parent =
              read.success.parent === null
                ? rootThreadId
                : yield* store.issueOwner(read.success.parent);
            if (parent !== shell.lineage.parentThreadId)
              reason =
                "Issue was re-parented. Cancel or finish this attempt before starting a successor under its new parent.";
          }
          if (reason === null) continue;
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
        if (config.milestones.length === 0) return;
        const plans: RepositoryOrchestration["milestones"][number][] = [];
        for (const plan of config.milestones) {
          const listing = yield* issues
            .milestoneIssues({
              host: config.host,
              repository: config.repository,
              milestoneNumber: plan.number,
            })
            .pipe(Effect.result);
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
            const started = yield* start({
              host: config.host,
              repository: config.repository,
              number: issue.number,
              projectId: config.projectId,
              modelRoleId: plan.modelRoleId,
              workspace: plan.workspace,
              clientRequestId: CommandId.make(
                `milestone-issue:${rootThreadId}:${plan.number}:${read.issue.id}:first`,
              ),
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

    const reconciliations = new Map<
      ThreadId,
      {
        pending: boolean;
        done: Deferred.Deferred<void, IssueWorkError>;
      }
    >();
    const reconcile: IssueWorkService["Service"]["reconcile"] = (rootThreadId) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const { state, leader } = yield* Effect.sync(() => {
            const existing = reconciliations.get(rootThreadId);
            if (existing !== undefined) {
              existing.pending = true;
              return { state: existing, leader: false };
            }
            const state = { pending: false, done: Deferred.makeUnsafe<void, IssueWorkError>() };
            reconciliations.set(rootThreadId, state);
            return { state, leader: true };
          });
          if (!leader) return yield* restore(Deferred.await(state.done));
          yield* restore(
            Effect.gen(function* () {
              do {
                state.pending = false;
                yield* reconcilePass(rootThreadId);
              } while (state.pending);
            }),
          ).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                reconciliations.delete(rootThreadId);
                yield* Deferred.done(state.done, exit);
              }),
            ),
          );
        }),
      );

    const workMilestone: IssueWorkService["Service"]["workMilestone"] = (input) =>
      Effect.gen(function* () {
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
                  workspace: input.workspace,
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
    const setPaused: IssueWorkService["Service"]["setPaused"] = (input) =>
      Effect.gen(function* () {
        const owner = yield* store.repositoryOwnerByRef(input);
        if (owner === null)
          return yield* new IssueWorkError({
            code: "invalid-request",
            message: "This repository has no registered orchestrator.",
          });
        const config = (yield* store.configuration(owner.rootThreadId))!;
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
          for (const threadId of yield* store.workerThreads(owner.rootThreadId))
            yield* threads
              .dispatch({
                type: "queue.resume",
                threadId,
                commandId: CommandId.make(`${input.clientRequestId}:queue:${threadId}`),
              })
              .pipe(Effect.mapError(mapError));
        }
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
            status: (yield* progressFor(owner, (root?.paused ?? false) || suspended)).status,
            publishing: yield* store.publishing(owner, issue),
          };
        }),
      start: (input) => start(input),
      workMilestone,
      repositoryStatus,
      setPaused,
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
              ((stored.event.type === "run.updated" || stored.event.type === "run.created") &&
                ["queued", "preparing", "completed", "failed", "interrupted", "cancelled"].includes(
                  stored.event.payload.status,
                ))),
        ),
        Stream.runForEach((stored) =>
          Effect.gen(function* () {
            const shell = yield* threads
              .getThreadShell(stored.event.threadId)
              .pipe(Effect.mapError(mapError));
            if (shell?.linkedIssue === undefined) return;
            const owner = yield* store.repositoryOwner(shell.linkedIssue);
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
