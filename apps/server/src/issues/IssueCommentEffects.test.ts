import { assert, it, vi } from "@effect/vitest";
import * as ThreadViewers from "../orchestration-v2/ThreadViewers.ts";
import {
  CommandId,
  EventId,
  IssueOperationError,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositions from "../orchestration-v2/TurnItemPositionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as IssueEffects from "./IssueEffects.ts";
import * as IssueService from "./IssueService.ts";
import * as TrackerIssueService from "../issue/IssueService.ts";
import { withRoadmapRevision } from "./IssueServerLayers.ts";

it.effect(
  "managed event commits read no thread history, coalesce refreshes, and skip unchanged status writes",
  () => {
    const getRecords = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"]>();
    const getShell = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadShell"]>();
    const observedProjections = Layer.effect(
      ProjectionStore.ProjectionStoreV2,
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        getRecords.mockImplementation(projections.getThreadRecords);
        getShell.mockImplementation(projections.getThreadShell);
        return ProjectionStore.ProjectionStoreV2.of({
          ...projections,
          getThreadRecords: getRecords,
          getThreadShell: getShell,
        });
      }),
    ).pipe(Layer.provide(ProjectionStore.layer));
    const dependencies = Layer.mergeAll(
      observedProjections,
      CommandReceipts.layer,
      EffectOutbox.layer,
      EventStore.layer,
      ProjectStore.layer,
      TurnItemPositions.layer,
    ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
    const testLayer = EventSink.layerFromStores.pipe(
      Layer.provideMerge(Layer.merge(dependencies, ThreadViewers.layer)),
    );
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("managed-status-history");
      const projectId = ProjectId.make("managed-status-project");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
      const issue = {
        host: "github.com",
        repository: "owner/repo",
        repositoryId: "1",
        id: "2",
        nodeId: "node:2",
        number: 8,
        title: "Bounded status commits",
        url: "https://github.com/owner/repo/issues/8",
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("managed-status-created"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              id: threadId,
              projectId,
              title: "#8 Bounded status commits",
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              createdBy: "user",
              creationSource: "web",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              linkedIssue: issue,
              repositoryOrchestration: {
                host: issue.host,
                repository: issue.repository,
                repositoryId: issue.repositoryId,
                projectId,

                launchCommandId: CommandId.make("managed-status-root"),
                revision: 1,
                paused: false,
                workerLimit: 4,
                readOnlyLimit: 4,
                publishStatusComments: true,
                publishCloseoutComments: true,
                milestones: [],
                suspendedIssues: [],
              },
              lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          },
        ],
      });
      // Each completion used to deserialize all historical runs, messages, children
      // and runtime requests, even when it could not change the issue status.
      for (let i = 0; i < 3; i += 1) {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`managed-command:${i}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`managed-command:${i}`),
                type: "command_execution",
                threadId,
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: i + 1,
                status: "completed",
                input: "git status",
                output: "clean",
                exitCode: 0,
                title: "git status",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            },
          ],
        });
      }
      assert.equal(getRecords.mock.calls.length, 0);
      assert.equal(getShell.mock.calls.length, 0);
      const pending = yield* sql<{
        effect_id: string;
      }>`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE status = 'pending'`;
      assert.equal(pending.length, 1);
      const marker = Option.getOrThrow(yield* outbox.get(pending[0]!.effect_id));
      if (marker.request.type !== "issue.status.refresh")
        return yield* Effect.die("Missing refresh marker");
      yield* sink.refreshIssueStatus({ ...marker.request, threadId });
      assert.equal(getRecords.mock.calls.length, 1);
      yield* sink.refreshIssueStatus({
        ...marker.request,
        revision: marker.request.revision + 1,
        threadId,
      });
      const writes =
        yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type = 'issue.github.comment'`;
      assert.equal(writes.length, 1);
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect(
  "issue comment effects roll back a failed receipt, find the posted comment on retry, skip stale status and replay once",
  () => {
    // GitHub's comments: upstream posts them, the extension finds them by marker.
    const comments = new Map<string, { id: string; body: string }>();
    let loseResponse = false;
    let revisions = 0;
    let lookups = 0;
    const writes: Array<{ readonly marker: string; readonly commentId?: string }> = [];
    const markerOf = (body: string) => /<!-- t3-issue-[^>]*-->/u.exec(body)![0];
    const forkIssues = Layer.mock(IssueService.IssueService)({
      withRepositoryCredential: (_input, use) => use,
      markChanged: () =>
        Effect.sync(() => {
          revisions++;
        }),
      findManagedComment: ({ marker }) =>
        Effect.sync(() => {
          lookups++;
          return comments.get(marker) ?? null;
        }),
      updateManagedComment: ({ commentId, body }) =>
        Effect.sync(() => void writes.push({ marker: markerOf(body), commentId })),
    });
    const upstream = Layer.mock(TrackerIssueService.IssueService)({
      resolveUrl: (url) =>
        Effect.succeed({
          projectId: ProjectId.make("project-issue-effects"),
          tracker: IssueTrackerKind.make("github"),
          host: "github.com",
          scope: "owner/repo",
          key: url.split("/").at(-1)!,
          writable: true,
        }),
      comment: ({ body }) =>
        Effect.gen(function* () {
          const marker = markerOf(body);
          const id = `comment:${comments.size + 1}`;
          writes.push({ marker });
          comments.set(marker, { id, body });
          if (loseResponse) {
            loseResponse = false;
            return yield* new IssueOperationError({
              operation: "comment",
              detail: "Response lost.",
            });
          }
          return id;
        }),
    });
    const issuesLayer = withRoadmapRevision(upstream).pipe(Layer.provideMerge(forkIssues));
    const dependencies = Layer.mergeAll(
      ProjectionStore.layer,
      CommandReceipts.layer,
      EffectOutbox.layer,
      EventStore.layer,
      ProjectStore.layer,
      TurnItemPositions.layer,
    ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
    const testLayer = Layer.mergeAll(
      EventSink.layerFromStores,
      issuesLayer,
      IdAllocator.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    ).pipe(Layer.provideMerge(Layer.merge(dependencies, ThreadViewers.layer)));
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("issue-effects-owner");
      const issue = {
        host: "github.com",
        repository: "owner/repo",
        repositoryId: "1",
        id: "3",
        nodeId: "node:3",
        number: 9,
        title: "Issue effects",
        url: "https://github.com/owner/repo/issues/9",
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("issue-effects-created"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              ...idleThreadProjection(liveThreadShell(threadId)).thread,
              linkedIssue: issue,
            },
          },
        ],
      });
      const closeoutMarker = "<!-- t3-issue-closeout:github.com:1:3:issue-effects-owner:run:1 -->";
      const statusMarker = "<!-- t3-issue-status:github.com:1:3 -->";
      const comment = (
        id: string,
        request: Omit<
          Extract<EffectOutbox.OrchestrationEffectRequestV2, { type: "issue.github.comment" }>,
          "type" | "issue"
        >,
      ) =>
        Effect.gen(function* () {
          yield* outbox.enqueue([
            {
              id,
              commandId: CommandId.make(`command:${id}`),
              threadId,
              request: { type: "issue.github.comment", issue, ...request },
            },
          ]);
          return Option.getOrThrow(yield* outbox.get(id));
        });
      const closeout = yield* comment("effect:closeout", {
        operation: "closeout_create",
        writeKey: "closeout:1",
        resultEventId: "run:1",
        marker: closeoutMarker,
        body: `Done\n\n${closeoutMarker}`,
      });
      const execute = (effect: EffectOutbox.OrchestrationEffectV2) =>
        Effect.flatMap(IssueEffects.make, (issueEffects) =>
          IssueEffects.isIssueEffectRequest(effect.request)
            ? issueEffects.execute(effect, effect.request)
            : Effect.die("Not an issue effect"),
        );
      const receipts = sql<{ readonly comment_id: string }>`
        SELECT comment_id FROM orchestration_v2_projection_issue_comment_receipts WHERE write_key = 'closeout:1'`;
      const recordedEvents = sql`
        SELECT 1 FROM orchestration_events WHERE event_type = 'issue.github-comment.recorded'`;

      // GitHub accepted the comment, then recording its receipt failed.
      yield* sql`CREATE TRIGGER fail_issue_receipt BEFORE INSERT ON orchestration_v2_projection_issue_comment_receipts
        BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`;
      const failed = yield* Effect.exit(execute(closeout));
      yield* sql`DROP TRIGGER fail_issue_receipt`;
      assert.equal(failed._tag, "Failure");
      assert.equal(writes.length, 1);
      assert.equal(lookups, 1);
      assert.equal(revisions, 1);
      assert.deepEqual(yield* receipts, []);
      assert.deepEqual(yield* recordedEvents, []);

      // The retry finds the comment GitHub already has by its marker instead of posting again.
      yield* execute(closeout);
      assert.equal(writes.length, 1);
      assert.deepEqual(yield* receipts, [{ comment_id: "comment:1" }]);
      // A replay after restart builds a fresh executor and sees the committed receipt.
      yield* execute(closeout);
      assert.equal(writes.length, 1);

      const stale = yield* comment("effect:status:1", {
        operation: "status_sync",
        status: "working",
        revision: 1,
        writeKey: "status:1",
        marker: statusMarker,
        body: `Working\n\n${statusMarker}`,
      });
      const current = yield* comment("effect:status:2", {
        operation: "status_sync",
        status: "done",
        revision: 2,
        writeKey: "status:2",
        marker: statusMarker,
        body: `Done\n\n${statusMarker}`,
      });
      yield* execute(stale);
      assert.equal(writes.length, 1);
      loseResponse = true;
      assert.equal((yield* Effect.exit(execute({ ...current, attemptCount: 1 })))._tag, "Failure");
      assert.equal(revisions, 1);
      yield* execute({ ...current, attemptCount: 2 });
      assert.deepEqual(writes, [{ marker: closeoutMarker }, { marker: statusMarker }]);
      assert.equal(revisions, 2);
      const status = yield* sql<{ readonly status_comment_id: string }>`
        SELECT status_comment_id FROM orchestration_v2_projection_issue_work WHERE issue_id = '3'`;
      assert.deepEqual(status, [{ status_comment_id: "comment:2" }]);
    }).pipe(Effect.provide(testLayer));
  },
);
