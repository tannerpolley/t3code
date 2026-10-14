import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  type IssueChange,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as IssueChangeApprovals from "./IssueChangeApprovals.ts";
import { issueChangeQuestion, issueChangeQuestionRequestId } from "./IssueChangeQuestion.ts";
import * as IssueChangeService from "./IssueChangeService.ts";
import * as IssueService from "./IssueService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Questions are committed directly; no provider process runs"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const repository = { host: "github.com", repository: "acme/repo" };
const issue = {
  ...repository,
  repositoryId: "1",
  id: "10",
  nodeId: "I_10",
  number: 10,
  title: "Issue 10",
  url: "https://github.com/acme/repo/issues/10",
};
const changes = IssueChangeService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(IssueService.IssueService)({
        readChangeState: () =>
          Effect.succeed({ issue, body: "Original", state: "open", milestoneNumber: 1 } as const),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
      EffectOutbox.layer.pipe(Layer.provide(database)),
      database,
    ),
  ),
);
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "issue-change-approvals" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
  changes,
).pipe(Layer.provideMerge(NodeServices.layer));

const threadId = ThreadId.make("thread:issue-change-approvals");
const service = IssueChangeService.IssueChangeService;

/** A repository root thread that proposes closing #10. */
const proposeClose = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-issue-root"),
    threadId,
    projectId: ProjectId.make("project:issues"),
    title: "Repository root",
    modelSelection: { instanceId, model: "gpt-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  // Repository ownership is projected from orchestration events this test does not replay.
  const orchestration = {
    ...repository,
    repositoryId: "1",
    projectId: "project:issues",
    launchCommandId: "start",
    revision: 1,
    paused: false,
    workerLimit: 4,
    publishStatusComments: true,
    publishCloseoutComments: true,
    milestones: [],
    suspendedIssues: [],
  };
  yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.repositoryOrchestration', json(${JSON.stringify(orchestration)})) WHERE thread_id = ${threadId}`;
  yield* sql`INSERT INTO orchestration_v2_projection_repository_orchestration(host, repository_id, repository, root_thread_id, project_id, workspace, launch_command_id, revision, paused, worker_limit, publish_status_comments, publish_closeout_comments, created_at, updated_at)
    VALUES ('github.com', '1', 'acme/repo', ${threadId}, 'project:issues', 'project', 'start', 1, 0, 4, 1, 1, '2026-01-01', '2026-01-01')`;
  return yield* (yield* service).propose(threadId, {
    ...repository,
    clientRequestId: "close",
    operation: { type: "state", number: 10, state: "closed" },
  });
});

/** Commits the question askOwner creates, as it stands once the agent's turn has ended. */
const askedQuestion = (change: IssueChange) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const requestId = issueChangeQuestionRequestId(change.id);
    const nodeId = NodeId.make(`node:${change.id}`);
    yield* sink.commitCommand({
      commandId: CommandId.make(`ask:${change.id}`),
      threadId,
      commandType: "provider-event.ingest",
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make(`request:${change.id}`),
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        },
        {
          id: EventId.make(`item:${change.id}`),
          type: "turn-item.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${change.id}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [issueChangeQuestion(change)],
          },
        },
      ],
    });
    yield* (yield* service).recordQuestion(change.id, requestId);
    return requestId;
  });

const answer = (change: IssueChange, label: "Approve" | "Decline") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`answer:${change.id}`),
      threadId,
      requestId: issueChangeQuestionRequestId(change.id),
      answers: { [issueChangeQuestion(change).id]: label },
    });
  });

/** The change once it is no longer pending, read after each change notification. */
const decided = (id: string) =>
  Effect.gen(function* () {
    const changes = yield* service;
    const change = yield* changes.subscribe({ threadId }).pipe(
      Stream.mapEffect(() => changes.list({ threadId })),
      Stream.map((rows) => rows.find((row) => row.id === id && row.decision !== "pending")),
      Stream.filter((row) => row !== undefined),
      Stream.runHead,
    );
    return Option.getOrThrow(change)!;
  });

it.effect("an answer given after the proposing call ended is applied", () =>
  Effect.gen(function* () {
    yield* Layer.build(IssueChangeApprovals.workerLive);
    const close = yield* proposeClose;
    yield* askedQuestion(close);
    yield* answer(close, "Approve");
    const applied = yield* decided(close.id);
    assert.equal(applied.decision, "approved");
    assert.equal(applied.decidedBy, "question");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("an answer committed before a restart is applied by the startup sweep", () =>
  Effect.gen(function* () {
    const close = yield* proposeClose;
    yield* askedQuestion(close);
    yield* answer(close, "Decline");
    const pending = (yield* service).list({ threadId }).pipe(Effect.map((rows) => rows[0]));
    assert.equal((yield* pending)?.decision, "pending");
    yield* (yield* IssueChangeApprovals.make).sweep;
    assert.equal((yield* pending)?.decision, "rejected");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a decision made in the issue view closes the change's question", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const close = yield* proposeClose;
    const requestId = yield* askedQuestion(close);
    yield* (yield* service).decide(
      { id: close.id, decision: "rejected" },
      { kind: "user", subject: "web", scopes: ["orchestration:operate"] },
    );
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    const question = yield* projections.getRuntimeRequest(threadId, requestId);
    assert.deepEqual([question?.status, question?.decision], ["resolved", "cancel"]);
  }).pipe(Effect.provide(testLayer)),
);
