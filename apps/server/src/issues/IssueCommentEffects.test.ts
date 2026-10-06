import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositions from "../orchestration-v2/TurnItemPositionStore.ts";

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
    ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
    const testLayer = EventSink.layerFromStores.pipe(Layer.provideMerge(dependencies));
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
                workspace: "project",
                launchCommandId: CommandId.make("managed-status-root"),
                revision: 1,
                paused: false,
                workerLimit: 4,
                publishStatusComments: true,
                publishCloseoutComments: true,
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
