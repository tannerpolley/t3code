import {
  EventId,
  type ThreadId,
  ProjectId,
  ProviderInstanceId,
  type InlineShellRunRecord,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Store from "./InlineShellStore.ts";

export const seed = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(`project-${threadId}`);
    const instanceId = ProviderInstanceId.make("codex");
    const now = yield* DateTime.now;
    const iso = DateTime.formatIso(now);
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make(`project-${threadId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: iso,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Inline test",
        workspaceRoot: "/tmp/inline-test",
        defaultModelSelection: null,
        scripts: [],
        createdAt: iso,
        updatedAt: iso,
      },
    });
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`thread-${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            createdBy: "user",
            creationSource: "web",
            projectId,
            title: "Inline test",
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: "/tmp/inline-worktree",
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
  });
export const persistence = Layer.mergeAll(
  Store.layer,
  RuntimeLayer.layerEventSink,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
export const record = (threadId: ThreadId, runId = "test"): InlineShellRunRecord => ({
  threadId,
  runId,
  blockId: "message:0",
  command: "printf result; exit 7",
  language: "bash",
  terminalId: `inline-${runId}`,
  sequence: 0,
  error: null,
  status: "running",
  startedAt: "2026-10-13T00:00:00.000Z",
  completedAt: null,
  exitCode: null,
  durationMs: 0,
  output: "",
});
