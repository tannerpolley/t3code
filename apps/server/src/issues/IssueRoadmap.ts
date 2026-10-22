import {
  backgroundWorkHoldsCompletion,
  isBackgroundTurnItemType,
  pendingBackgroundTurnItems,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  type IssueDetailInput,
  type IssueDetailResult,
  type IssueReadError,
  IssueWorkError,
  type IssueListInput,
  type IssueListResult,
  type IssueStatusBatchInput,
  type IssueStatusBatchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IssueService from "./IssueService.ts";
import * as IssueLinks from "./IssueLinks.ts";

/** Combines the GitHub list and local work in one existing RPC and refresh cadence. */
export class IssueRoadmap extends Context.Service<
  IssueRoadmap,
  {
    readonly linkRefreshes: Stream.Stream<number, IssueWorkError>;
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueReadError>;
    /** The issue with the same local work its list row carries. */
    readonly detail: (input: IssueDetailInput) => Effect.Effect<IssueDetailResult, IssueReadError>;
    readonly statusBatch: (
      input: IssueStatusBatchInput,
    ) => Effect.Effect<IssueStatusBatchResult, IssueReadError>;
  }
>()("t3/issues/IssueRoadmap") {}

export const layer = Layer.effect(
  IssueRoadmap,
  Effect.gen(function* () {
    const issues = yield* IssueService.IssueService;
    const links = yield* IssueLinks.IssueLinks;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return IssueRoadmap.of({
      linkRefreshes: Stream.merge(
        links.refreshes.pipe(Stream.drop(1)),
        Stream.suspend(() => {
          const workStates = new Map<string, string>();
          return orchestrator.streamDomainEvents.pipe(
            Stream.filter((event) => {
              const state: readonly [string, string] | undefined =
                event.type === "provider-thread.updated"
                  ? [
                      `provider:${event.payload.id}`,
                      String(
                        backgroundWorkHoldsCompletion(event.payload.pendingBackgroundTasks ?? []),
                      ),
                    ]
                  : event.type === "subagent.updated"
                    ? [
                        `subagent:${event.payload.id}`,
                        `${event.payload.status}:${event.payload.childThreadId ?? ""}`,
                      ]
                    : event.type === "runtime-request.updated"
                      ? [
                          `request:${event.payload.id}`,
                          `${event.payload.kind}:${event.payload.status}:${event.payload.responseCapability.type}`,
                        ]
                      : event.type === "run.created" || event.type === "run.updated"
                        ? [
                            `run:${event.payload.id}`,
                            `${event.payload.status}:${event.payload.queueHeld === true}`,
                          ]
                        : event.type === "turn-item.updated" &&
                            isBackgroundTurnItemType(event.payload.type)
                          ? [
                              `item:${event.payload.id}`,
                              String(
                                pendingBackgroundTurnItems({ turnItems: [event.payload] }).length >
                                  0,
                              ),
                            ]
                          : undefined;
              if (state !== undefined) {
                const [key, value] = state;
                if (workStates.get(key) === value) return false;
                workStates.set(key, value);
              }
              return (
                event.type === "thread.created" ||
                event.type === "thread.metadata-updated" ||
                event.type === "thread.archived" ||
                event.type === "thread.unarchived" ||
                event.type === "thread.deleted" ||
                event.type === "thread.pull-request-synced" ||
                event.type === "thread.pull-request-link-updated" ||
                event.type === "issue.work.requested" ||
                event.type === "issue.work.cancelled" ||
                event.type === "issue.queue.updated" ||
                event.type === "repository.work.restored" ||
                event.type === "runtime-request.updated" ||
                event.type === "provider-thread.updated" ||
                event.type === "subagent.updated" ||
                (event.type === "turn-item.updated" &&
                  (event.payload.type === "secret_request" ||
                    isBackgroundTurnItemType(event.payload.type))) ||
                event.type === "run.created" ||
                event.type === "run.updated"
              );
            }),
            Stream.mapError(
              () =>
                new IssueWorkError({
                  code: "orchestration-error",
                  message: "Could not follow issue work changes.",
                }),
            ),
          );
        }),
      ).pipe(
        // One command often commits ownership, thread and run events together.
        Stream.groupedWithin(128, "250 millis"),
        Stream.scan(
          () => 0,
          (revision) => revision + 1,
        ),
      ),
      statusBatch: Effect.fn("IssueRoadmap.statusBatch")(function* (input) {
        const statuses = yield* issues.statusBatch(input);
        const repositories = new Map<string, (typeof statuses)[number][]>();
        for (const status of statuses) {
          const key = `${status.host.toLowerCase()}/${status.repository.toLowerCase()}`;
          const group = repositories.get(key) ?? [];
          group.push(status);
          repositories.set(key, group);
        }
        const result: Array<IssueStatusBatchResult[number]> = [];
        for (const group of repositories.values()) {
          const list = {
            repository: { host: group[0]!.host, repository: group[0]!.repository },
            issues: group.map((status) => ({ ...status, pullRequestRefs: status.pullRequests })),
          };
          const enriched = yield* links.enrich(list).pipe(Effect.orElseSucceed(() => list));
          for (const status of enriched.issues) {
            const compactPr = ({
              host,
              repository,
              number,
              state,
              updatedAt,
            }: (typeof status.pullRequests)[number]) => ({
              host,
              repository,
              number,
              state,
              updatedAt,
            });
            result.push({
              host: status.host,
              nodeId: status.nodeId,
              state: status.state,
              stateReason: status.stateReason,
              blockedBy: status.blockedBy,
              pullRequests: status.pullRequests.map(compactPr),
              closingPullRequests: (status.closingPullRequests ?? status.pullRequests).map(
                compactPr,
              ),
              liveWork: status.liveWork?.map(({ threadId, inherited, status }) => ({
                threadId,
                inherited,
                status,
              })),
            });
          }
        }
        return result;
      }),
      list: (input) =>
        issues.list(input).pipe(
          Effect.flatMap((list) =>
            input.roadmap !== true
              ? Effect.succeed(list)
              : links.enrich(list).pipe(
                  Effect.orElseSucceed(() => ({
                    ...list,
                    issues: list.issues.map(({ pullRequestRefs: _refs, ...issue }) => ({
                      ...issue,
                      liveWork: [],
                    })),
                  })),
                ),
          ),
        ),
      detail: (input) =>
        issues.detail(input).pipe(
          Effect.flatMap((detail) =>
            links
              .enrich({
                ...detail,
                milestones: [],
                nextCursor: null,
                issuesComplete: true,
                milestonesComplete: true,
                issues: [
                  {
                    ...detail.issue,
                    pullRequests: detail.linkedPullRequests
                      .filter((pr) => pr.closesIssue)
                      .map((pr) => ({ ...pr, host: detail.repository.host })),
                    // The list associates threads through closing pull requests; so does this.
                    pullRequestRefs: detail.linkedPullRequests
                      .filter((pr) => pr.closesIssue)
                      .map((pr) => ({
                        host: detail.repository.host,
                        repository: pr.repository,
                        number: pr.number,
                      })),
                  },
                ],
              })
              .pipe(
                Effect.map((list) => ({ ...detail, issue: list.issues[0] ?? detail.issue })),
                Effect.orElseSucceed(() => detail),
              ),
          ),
        ),
    });
  }),
);
