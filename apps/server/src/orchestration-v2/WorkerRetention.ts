import { CommandId, type ThreadId } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as IssueService from "../issue/IssueService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeBranchPullRequestDiscovery } from "./ThreadPullRequestService.ts";
import { isIdleWorker, workerCompletionIsCurrent } from "./ThreadSettlementService.ts";

function pullRequestCompletionAt(
  snapshot: {
    readonly state: string;
    readonly mergedAt?: string | null | undefined;
    readonly closedAt?: string | null | undefined;
  } | null,
) {
  if (snapshot === null) return "unknown" as const;
  if (snapshot.state !== "merged" && snapshot.state !== "closed") return null;
  const endedAt = Date.parse(
    (snapshot.state === "merged" ? snapshot.mergedAt : snapshot.closedAt) ?? "",
  );
  return Number.isFinite(endedAt) ? endedAt : ("unknown" as const);
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const branchDiscovery = yield* makeBranchPullRequestDiscovery;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const issues = yield* IssueService.IssueService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const random = yield* SecureRandom.SecureRandom;

  const completion = Effect.fn("WorkerRetention.completion")(function* (
    worker: ProjectionStore.ProjectionSettlementCandidate,
    now: DateTime.Utc,
    discoverBranch: typeof branchDiscovery.discover,
  ) {
    if (!isIdleWorker(worker, now)) return null;
    const temporary = worker.workerTemporaryCompletedAt !== undefined;
    const preserveOpenWork = worker.archivedAt === null || temporary;
    let completedAt = worker.workerTemporaryCompletedAt ?? null;
    if (completedAt !== null && !workerCompletionIsCurrent(worker, completedAt)) completedAt = null;
    if (temporary && worker.archivedAt === null && completedAt === null) return null;

    // During archiving, a finished link cannot override another link that still needs work.
    const recordCompletion = (endedAt: number | "unknown" | null) => {
      if (typeof endedAt !== "number" || !Number.isFinite(endedAt)) {
        return preserveOpenWork ? null : undefined;
      }
      if (!workerCompletionIsCurrent(worker, endedAt)) return undefined;
      completedAt = Math.max(completedAt ?? -Infinity, endedAt);
      return preserveOpenWork ? undefined : completedAt;
    };
    const allLinks = worker.pullRequests ?? [];
    const readPullRequest = (reference: NonNullable<typeof worker.linkedPullRequest>) =>
      pullRequests
        .summary(reference, {
          recoverTransientFailure: false,
          bypassCache: worker.archivedAt !== null,
        })
        .pipe(
          Effect.map(pullRequestCompletionAt),
          Effect.orElseSucceed(() => "unknown" as const),
        );
    for (const link of visibleThreadPullRequests(allLinks)) {
      const recorded = pullRequestCompletionAt(link.snapshot);
      const endedAt =
        recorded === "unknown" ||
        link.snapshot?.state === "closed" ||
        (worker.archivedAt !== null && link.snapshot?.state !== "merged")
          ? yield* readPullRequest({ ...link, projectId: worker.projectId })
          : recorded;
      const decision = recordCompletion(endedAt);
      if (decision !== undefined) return decision;
    }

    for (const reference of [worker.linkedPullRequest, worker.branchPullRequest]) {
      if (
        reference == null ||
        allLinks.some(
          (link) =>
            link.number === reference.number &&
            link.repository.toLowerCase() === reference.repository.toLowerCase(),
        )
      )
        continue;
      const endedAt = yield* readPullRequest(reference);
      const decision = recordCompletion(endedAt);
      if (decision !== undefined) return decision;
    }
    if (
      (!temporary || worker.worktreePath !== null) &&
      worker.linkedPullRequest == null &&
      worker.branchPullRequest == null &&
      allLinks.length === 0 &&
      worker.branch !== null
    ) {
      const project = yield* projects.getShell(worker.projectId);
      const pullRequest =
        project._tag === "None"
          ? null
          : yield* discoverBranch(project.value, worker, {
              refresh: worker.archivedAt !== null,
            }).pipe(Effect.option);
      if (pullRequest?._tag !== "Some") {
        if (preserveOpenWork) return null;
      } else if (pullRequest.value?.detected != null) {
        const endedAt = pullRequestCompletionAt(pullRequest.value.detected);
        const decision = recordCompletion(endedAt);
        if (decision !== undefined) return decision;
      }
    }
    for (const link of worker.issues ?? []) {
      const issue = yield* issues.detail(link).pipe(Effect.option);
      const endedAt =
        issue._tag === "Some" && issue.value.state.category === "closed"
          ? Date.parse(issue.value.closedAt ?? "")
          : null;
      const decision = recordCompletion(endedAt);
      if (decision !== undefined) return decision;
    }
    return completedAt;
  });

  const archive = Effect.fn("WorkerRetention.archive")(function* (
    worker: ProjectionStore.ProjectionSettlementCandidate,
  ) {
    if (worker.workerArchiveSequence === undefined) return false;
    const result = yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`worker-archive:${yield* random.uuidV4()}`),
      threadId: worker.id,
      workerArchiveSequence: worker.workerArchiveSequence,
    });
    return result.storedEvents.some(({ event }) => event.type === "thread.archived");
  });

  const autoArchive = Effect.fn("WorkerRetention.autoArchive")(function* (
    threadId?: ThreadId,
    afterThreadId?: ThreadId,
  ) {
    const workers = yield* projections.getSettlementCandidates(
      threadId,
      afterThreadId === undefined ? {} : { afterThreadId },
    );
    const now = yield* DateTime.now;
    const discoverBranch = yield* branchDiscovery.forPass(false);
    let archived = 0;
    let failed = 0;
    for (const worker of workers) {
      const attempt = yield* Effect.result(
        completion(worker, now, discoverBranch).pipe(
          Effect.flatMap((completedAt) =>
            completedAt === null ? Effect.succeed(false) : archive(worker),
          ),
        ),
      );
      if (attempt._tag === "Failure") failed++;
      else if (attempt.success) archived++;
    }
    return { cursor: workers.at(-1)?.id, archived, failed };
  });

  const removeExpired = Effect.fn("WorkerRetention.removeExpired")(function* (
    afterThreadId?: ThreadId,
  ) {
    const { archivedWorkerRetentionDays } = yield* settings.getSettings;
    if (archivedWorkerRetentionDays === null) return;
    const now = yield* DateTime.now;
    const workers = yield* projections.getSettlementCandidates(undefined, {
      ...(afterThreadId === undefined ? {} : { afterThreadId }),
      archivedBefore: DateTime.subtract(now, { days: archivedWorkerRetentionDays }),
    });
    const discoverBranch = yield* branchDiscovery.forPass(true);
    for (const worker of workers) {
      if (worker.archivedAt === null || worker.workerArchiveSequence === undefined) continue;
      const completedAt = yield* completion(worker, now, discoverBranch);
      if (typeof completedAt !== "number") continue;
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`worker-retention:${yield* random.uuidV4()}`),
        threadId: worker.id,
        workerDeleteArchivedAt: worker.archivedAt,
        workerArchiveSequence: worker.workerArchiveSequence,
        workerCompletedAt: completedAt,
      });
    }
    return workers.at(-1)?.id;
  });

  const start = Effect.fn("WorkerRetention.start")(function* () {
    let archiveCursor: ThreadId | undefined;
    let archived = 0;
    let failed = 0;
    let deleteCursor: ThreadId | undefined;
    yield* forkParked(
      Effect.gen(function* () {
        const page = yield* autoArchive(undefined, archiveCursor).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Worker archive sweep failed", { cause }).pipe(Effect.as(null)),
          ),
        );
        if (page !== null) {
          archiveCursor = page.cursor;
          archived += page.archived;
          failed += page.failed;
          if (archiveCursor === undefined && (archived > 0 || failed > 0)) {
            const log = failed > 0 ? Effect.logWarning : Effect.logInfo;
            yield* log("Worker archive sweep completed", { archived, failed });
            archived = 0;
            failed = 0;
          }
        }
        deleteCursor = yield* removeExpired(deleteCursor).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Worker retention sweep failed", { cause }).pipe(
              Effect.as(deleteCursor),
            ),
          ),
        );
      }).pipe(Effect.repeat(Schedule.spaced("1 minute"))),
    );
  });

  return { autoArchive, removeExpired, start };
});

export class WorkerRetention extends Context.Service<
  WorkerRetention,
  Effect.Success<typeof make>
>()("t3/orchestration-v2/WorkerRetention") {}

export const layer = Layer.effect(WorkerRetention, make);
