import {
  CommandId,
  MessageId,
  type NodeId,
  type RepositoryIssueRef,
  type ThreadId,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as TrackerIssues from "../issue/IssueService.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ARCHIVE_REMINDER_GRACE_MS,
  finishedWorkerAt,
  finishedWorkers,
  reminderRecipient,
} from "./WorkerArchiveCandidates.ts";
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

const githubIssueRef = (link: ThreadIssueLink): RepositoryIssueRef | null => {
  const number = Number(link.key);
  return link.tracker === "github" &&
    /^\d+$/u.test(link.key) &&
    Number.isSafeInteger(number) &&
    number > 0
    ? { host: link.host.toLowerCase(), repository: link.scope.toLowerCase(), number }
    : null;
};
const sharesParentBranch = (worker: ProjectionStore.ProjectionSettlementCandidate) =>
  worker.workerTemporaryCompletedAt !== undefined && worker.workerSharesParentCheckout === true;

/** Issue links that are the worker's own work, not inherited from its parent's branch. */
const ownIssues = (worker: ProjectionStore.ProjectionSettlementCandidate) =>
  sharesParentBranch(worker) ? [] : (worker.issues ?? []);

interface ReminderChild {
  readonly id: ThreadId;
  readonly title: string;
  readonly taskId: NodeId;
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const branchDiscovery = yield* makeBranchPullRequestDiscovery;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const issues = yield* IssueService.IssueService;
  const trackerIssues = yield* TrackerIssues.IssueService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;

  const readIssues = Effect.fn("WorkerRetention.readIssues")(function* (
    workers: ReadonlyArray<ProjectionStore.ProjectionSettlementCandidate>,
    now: DateTime.Utc,
    refresh: boolean,
  ) {
    const refs = workers.flatMap((worker) =>
      isIdleWorker(worker, now) && finishedWorkerAt(worker, now) === null
        ? ownIssues(worker).flatMap((link) => githubIssueRef(link) ?? [])
        : [],
    );
    const statuses = refs.length === 0 ? [] : yield* issues.issueStatuses(refs, refresh);
    return new Map(statuses.map((status) => [IssueService.completionIssueKey(status), status]));
  });

  const completion = Effect.fn("WorkerRetention.completion")(function* (
    worker: ProjectionStore.ProjectionSettlementCandidate,
    now: DateTime.Utc,
    discoverBranch: typeof branchDiscovery.discover,
    statuses: Effect.Success<ReturnType<typeof readIssues>>,
  ) {
    if (!isIdleWorker(worker, now)) return null;
    const deliveredAt = finishedWorkerAt(worker, now);
    if (deliveredAt !== null) return deliveredAt;
    const temporary = worker.workerTemporaryCompletedAt !== undefined;
    const ownsBranchLinks = !sharesParentBranch(worker);
    const preserveOpenWork = temporary;
    let completedAt = worker.workerTemporaryCompletedAt ?? null;
    if (completedAt !== null && !workerCompletionIsCurrent(worker, completedAt)) completedAt = null;

    // During archiving, a finished link cannot override another link that still needs work.
    const recordCompletion = (endedAt: number | "unknown" | null) => {
      if (typeof endedAt !== "number" || !Number.isFinite(endedAt)) {
        return preserveOpenWork ? null : undefined;
      }
      if (!workerCompletionIsCurrent(worker, endedAt)) return undefined;
      completedAt = Math.max(completedAt ?? -Infinity, endedAt);
      return preserveOpenWork ? undefined : completedAt;
    };
    const issueCompletion = (link: ThreadIssueLink) => {
      if (link.tracker === "github") {
        const ref = githubIssueRef(link);
        const status =
          ref === null ? undefined : statuses.get(IssueService.completionIssueKey(ref));
        return Effect.succeed(
          status?.state === "closed" ? Date.parse(status.closedAt ?? "") : null,
        );
      }
      return trackerIssues.detail(link).pipe(
        Effect.map((issue) =>
          issue.state.category === "closed" ? Date.parse(issue.closedAt ?? "") : null,
        ),
        Effect.orElseSucceed(() => null),
      );
    };
    if (preserveOpenWork) {
      for (const link of ownIssues(worker)) {
        const decision = recordCompletion(yield* issueCompletion(link));
        if (decision !== undefined) return decision;
      }
    }
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

    for (const reference of [
      worker.linkedPullRequest,
      ownsBranchLinks ? worker.branchPullRequest : null,
    ]) {
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
      ownsBranchLinks &&
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
    if (!preserveOpenWork) {
      for (const link of ownIssues(worker)) {
        const decision = recordCompletion(yield* issueCompletion(link));
        if (decision !== undefined) return decision;
      }
    }
    return completedAt;
  });

  const remindMissedArchives = Effect.fn("WorkerRetention.remindMissedArchives")(function* () {
    const now = yield* DateTime.now;
    const dueBy = DateTime.toEpochMillis(now) - ARCHIVE_REMINDER_GRACE_MS;
    const finished = yield* finishedWorkers(projections, now);

    const parents = new Map<ThreadId, ThreadId | null>();
    const byRecipient = new Map<ThreadId, ReminderChild[]>();
    for (const worker of finished.values()) {
      if (worker.workerResult === undefined || worker.workerResult.availableAt > dueBy) continue;
      const recipient = yield* reminderRecipient(
        projections,
        worker.lineage.parentThreadId,
        parents,
        finished,
      );
      if (recipient === null) continue;
      const child = { id: worker.id, title: worker.title, taskId: worker.workerResult.taskId };
      const group = byRecipient.get(recipient);
      if (group === undefined) byRecipient.set(recipient, [child]);
      else group.push(child);
    }

    for (const [threadId, workers] of byRecipient) {
      const hash = yield* digest.digest(
        Digest.sha256,
        new TextEncoder().encode(
          workers.map(({ taskId }) => `${taskId.length}:${taskId}`).join("|"),
        ),
      );
      const id = `missed-worker-archive:${threadId}:${Hex.encode(hash)}`;
      const summary = `Finished children still visible (${workers.length})`;
      const children = workers
        .map((worker) => `- ${worker.title.replace(/\s+/g, " ").trim()} (${worker.id})`)
        .join("\n");
      const detail = `${summary}\n\n${children}`;
      yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: `${detail}\n\nUse t3_thread_organize with action archive, delegatedWorker true and the child thread ID for each child. The tool checks whether it is still eligible.`,
          notification: { source: { kind: "system" }, outcome: "updated", summary, detail },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not remind parent to archive finished children", {
              threadId,
              cause,
            }),
          ),
        );
    }
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
    // A reopened issue must not authorize deletion through a cached closed state.
    const statuses = yield* readIssues(workers, now, true);
    for (const worker of workers) {
      if (worker.archivedAt === null || worker.workerArchiveSequence === undefined) continue;
      const completedAt = yield* completion(worker, now, discoverBranch, statuses);
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
    let deleteCursor: ThreadId | undefined;
    yield* forkParked(
      Effect.gen(function* () {
        yield* remindMissedArchives().pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Worker archive reminder sweep failed", { cause }),
          ),
        );
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

  return { remindMissedArchives, removeExpired, start };
});

export class WorkerRetention extends Context.Service<
  WorkerRetention,
  Effect.Success<typeof make>
>()("t3/orchestration-v2/WorkerRetention") {}

export const layer = Layer.effect(WorkerRetention, make).pipe(Layer.provide(Digest.layerWebCrypto));
