import {
  CommandId,
  type ThreadId,
  WorkerArchiveError,
  type WorkerArchiveInput,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

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

const isWorkerArchiveError = Schema.is(WorkerArchiveError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const discoverBranch = yield* makeBranchPullRequestDiscovery;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const issues = yield* IssueService.IssueService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const random = yield* SecureRandom.SecureRandom;
  const confirmation = yield* Semaphore.make(1);
  const backlog = Effect.map(
    sql<{ readonly cutoff: string; readonly completed: number }>`
      SELECT cutoff, completed FROM worker_archive_backlog WHERE id = 1
    `,
    ([row]) => row!,
  );
  const { cutoff } = yield* backlog;
  const cutoffMs = Date.parse(cutoff);

  const completion = Effect.fn("WorkerRetention.completion")(function* (
    worker: ProjectionStore.ProjectionSettlementCandidate,
    now: DateTime.Utc,
    period?: "backlog" | "automatic",
  ) {
    if (!isIdleWorker(worker, now)) return null;
    const qualifies = (endedAt: number) =>
      workerCompletionIsCurrent(worker, endedAt) &&
      (period === undefined || (period === "automatic" ? endedAt > cutoffMs : endedAt <= cutoffMs));
    let unknown = false;
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
        recorded === "unknown" || (worker.archivedAt !== null && link.snapshot?.state !== "merged")
          ? yield* readPullRequest({ ...link, projectId: worker.projectId })
          : recorded;
      if (typeof endedAt === "number" && qualifies(endedAt)) return endedAt;
      if (endedAt === "unknown") unknown = true;
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
      if (typeof endedAt === "number" && qualifies(endedAt)) return endedAt;
      if (endedAt === "unknown") unknown = true;
    }
    if (
      worker.linkedPullRequest == null &&
      worker.branchPullRequest == null &&
      allLinks.length === 0 &&
      worker.branch !== null
    ) {
      const project = yield* projects.getShell(worker.projectId);
      if (project._tag === "None") {
        unknown = true;
      } else {
        const pullRequest = yield* discoverBranch(project.value, worker, {
          refresh: worker.archivedAt !== null,
        }).pipe(Effect.option);
        const endedAt =
          pullRequest._tag === "Some"
            ? pullRequest.value?.detected == null
              ? null
              : pullRequestCompletionAt(pullRequest.value.detected)
            : "unknown";
        if (typeof endedAt === "number" && qualifies(endedAt)) return endedAt;
        if (endedAt === "unknown") unknown = true;
      }
    }
    for (const link of worker.issues ?? []) {
      const issue = yield* issues.detail(link).pipe(Effect.option);
      if (issue._tag === "None") {
        unknown = true;
      } else if (issue.value.state.category === "closed") {
        const endedAt = Date.parse(issue.value.closedAt ?? "");
        if (qualifies(endedAt)) return endedAt;
        if (!Number.isFinite(endedAt)) unknown = true;
      }
    }
    return unknown ? ("unknown" as const) : null;
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
    for (const worker of workers) {
      if (typeof (yield* completion(worker, now, "automatic")) === "number") yield* archive(worker);
    }
    return workers.at(-1)?.id;
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
    for (const worker of workers) {
      if (worker.archivedAt === null || worker.workerArchiveSequence === undefined) continue;
      const completedAt = yield* completion(worker, now);
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

  let preview:
    | {
        readonly token: string;
        readonly unknown: number;
        readonly workers: ReadonlyArray<{ readonly id: ThreadId; readonly title: string }>;
      }
    | undefined;

  const archiveBacklog = Effect.fn("WorkerRetention.archiveBacklog")(
    function* (input: WorkerArchiveInput) {
      if ((yield* backlog).completed !== 0) return { kind: "completed" } as const;
      const now = yield* DateTime.now;
      if (input.kind === "preview") {
        const workers: Array<{ id: ThreadId; title: string }> = [];
        let unknown = 0;
        let cursor: ThreadId | undefined;
        do {
          const page = yield* projections.getSettlementCandidates(
            undefined,
            cursor === undefined ? {} : { afterThreadId: cursor },
          );
          for (const worker of page) {
            if (DateTime.toEpochMillis(worker.createdAt) > cutoffMs) continue;
            const completedAt = yield* completion(worker, now, "backlog");
            if (typeof completedAt === "number")
              workers.push({ id: worker.id, title: worker.title ?? worker.id });
            if (completedAt === "unknown") unknown++;
          }
          cursor = page.at(-1)?.id;
        } while (cursor !== undefined);
        preview = { token: yield* random.uuidV4(), workers, unknown };
        return { kind: "preview", ...preview } as const;
      }
      if (preview?.token !== input.token)
        return yield* new WorkerArchiveError({ reason: "preview-expired" });
      let archived = 0;
      let unknown = preview.unknown;
      for (const { id } of preview.workers) {
        const [worker] = yield* projections.getSettlementCandidates(id, {});
        if (worker === undefined) continue;
        const completedAt = yield* completion(worker, now, "backlog");
        if (completedAt === "unknown") unknown++;
        if (typeof completedAt === "number") {
          if (yield* archive(worker)) archived++;
          else unknown++;
        }
      }
      if (unknown === 0) yield* sql`UPDATE worker_archive_backlog SET completed = 1 WHERE id = 1`;
      preview = undefined;
      return { kind: "archived", archived, unknown } as const;
    },
    (effect) =>
      effect.pipe(
        confirmation.withPermits(1),
        Effect.mapError((cause) =>
          isWorkerArchiveError(cause)
            ? cause
            : new WorkerArchiveError({ reason: "operation-failed", cause }),
        ),
      ),
  );

  const start = Effect.fn("WorkerRetention.start")(function* () {
    let archiveCursor: ThreadId | undefined;
    let deleteCursor: ThreadId | undefined;
    yield* forkParked(
      Effect.gen(function* () {
        archiveCursor = yield* autoArchive(undefined, archiveCursor).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Worker archive sweep failed", { cause }).pipe(
              Effect.as(archiveCursor),
            ),
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

  return { autoArchive, archiveBacklog, removeExpired, start };
});

export class WorkerRetention extends Context.Service<
  WorkerRetention,
  Effect.Success<typeof make>
>()("t3/orchestration-v2/WorkerRetention") {}

export const layer = Layer.effect(WorkerRetention, make);
