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
import * as ProjectionStore from "./ProjectionStore.ts";
import { isIdleWorker } from "./ThreadSettlementService.ts";

const isWorkerArchiveError = Schema.is(WorkerArchiveError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
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

  const isFinished = Effect.fn("WorkerRetention.isFinished")(function* (
    worker: ProjectionStore.ProjectionSettlementCandidate,
    now: DateTime.Utc,
    includeBacklog: boolean,
  ) {
    if (!isIdleWorker(worker, now)) return false;
    const createdAt = DateTime.toEpochMillis(worker.createdAt);
    if (includeBacklog && createdAt > Date.parse(cutoff)) return false;
    const after = Math.max(
      includeBacklog ? Number.NEGATIVE_INFINITY : Date.parse(cutoff),
      worker.workerUnarchivedAt === undefined
        ? Number.NEGATIVE_INFINITY
        : Date.parse(worker.workerUnarchivedAt),
    );
    const workedSince =
      createdAt > after ||
      (worker.latestRunRequestedAt != null &&
        DateTime.toEpochMillis(worker.latestRunRequestedAt) > after);
    for (const link of visibleThreadPullRequests(worker.pullRequests ?? [])) {
      const snapshot = link.snapshot;
      if (snapshot?.state !== "closed" && snapshot?.state !== "merged") continue;
      const endedAt = snapshot.state === "merged" ? snapshot.mergedAt : snapshot.closedAt;
      if (workedSince || Date.parse(link.linkedAt) > after || Date.parse(endedAt ?? "") > after) {
        return true;
      }
    }
    const legacyLink = worker.linkedPullRequest;
    if (
      legacyLink != null &&
      !(worker.pullRequests ?? []).some(
        (link) =>
          link.number === legacyLink.number &&
          link.repository.toLowerCase() === legacyLink.repository.toLowerCase(),
      )
    ) {
      const summary = yield* pullRequests
        .summary(legacyLink, { recoverTransientFailure: false })
        .pipe(Effect.option);
      if (
        summary._tag === "Some" &&
        ((summary.value.state === "merged" &&
          (workedSince || Date.parse(summary.value.mergedAt ?? "") > after)) ||
          (summary.value.state === "closed" &&
            (workedSince || Date.parse(summary.value.closedAt ?? "") > after)))
      )
        return true;
    }
    for (const link of worker.issues ?? []) {
      const issue = yield* issues.detail(link).pipe(Effect.option);
      if (
        issue._tag === "Some" &&
        issue.value.state.category === "closed" &&
        (workedSince ||
          Date.parse(link.linkedAt) > after ||
          Date.parse(issue.value.closedAt ?? "") > after)
      )
        return true;
    }
    return false;
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
      if (yield* isFinished(worker, now, false)) yield* archive(worker);
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
      if (worker.archivedAt === null || !isIdleWorker(worker, now)) continue;
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`worker-retention:${yield* random.uuidV4()}`),
        threadId: worker.id,
        workerDeleteArchivedAt: worker.archivedAt,
      });
    }
    return workers.at(-1)?.id;
  });

  let preview:
    | {
        readonly token: string;
        readonly workers: ReadonlyArray<{ readonly id: ThreadId; readonly title: string }>;
      }
    | undefined;

  const archiveBacklog = Effect.fn("WorkerRetention.archiveBacklog")(
    function* (input: WorkerArchiveInput) {
      if ((yield* backlog).completed !== 0) return { kind: "completed" } as const;
      const now = yield* DateTime.now;
      if (input.kind === "preview") {
        const workers: Array<{ id: ThreadId; title: string }> = [];
        let cursor: ThreadId | undefined;
        do {
          const page = yield* projections.getSettlementCandidates(
            undefined,
            cursor === undefined ? {} : { afterThreadId: cursor },
          );
          for (const worker of page) {
            if (yield* isFinished(worker, now, true)) {
              workers.push({ id: worker.id, title: worker.title ?? worker.id });
            }
          }
          cursor = page.at(-1)?.id;
        } while (cursor !== undefined);
        preview = { token: yield* random.uuidV4(), workers };
        return { kind: "preview", ...preview } as const;
      }
      if (preview?.token !== input.token)
        return yield* new WorkerArchiveError({ reason: "preview-expired" });
      let archived = 0;
      for (const { id } of preview.workers) {
        const [worker] = yield* projections.getSettlementCandidates(id, {});
        if (
          worker !== undefined &&
          (yield* isFinished(worker, now, true)) &&
          (yield* archive(worker))
        ) {
          archived++;
        }
      }
      yield* sql`UPDATE worker_archive_backlog SET completed = 1 WHERE id = 1`;
      preview = undefined;
      return { kind: "archived", archived } as const;
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
