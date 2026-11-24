import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadTranscript,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import * as OrchestrationHttp from "./http.ts";
import { OrchestratorProjectionError } from "./Orchestrator.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { subscribeOrchestrationV2Thread } from "../ws.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

class TranscriptTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadTranscript),
);

const now = DateTime.makeUnsafe("2026-09-29T00:00:00.000Z");
const environmentId = EnvironmentId.make("source-بيئة");
const output = "Full tool output. ".repeat(4_000);
const thread = Schema.decodeSync(OrchestrationV2AppThread)({
  id: "source-thread",
  projectId: "source-project",
  title: "Source 界\nconversation",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "source-thread", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});
const items = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2TurnItem))(
  Array.from({ length: 200 }, (_, position) => ({
    id: `item-${position}`,
    threadId: "source-thread",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: position,
    type: "command_execution",
    status: "completed",
    title: "Read notes",
    input: "cat notes.md",
    output: position === 0 ? output : "Done",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  })),
);

const rolledBackRun = Schema.decodeSync(OrchestrationV2Run)({
  id: "run:rolled-back",
  threadId: "source-thread",
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: "message:rolled-back",
  rootNodeId: null,
  activeAttemptId: null,
  status: "rolled_back",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
});

// Serves the orchestration HTTP routes over real stores; `allowed` gates the read scope.
const serveOrchestrationHttp = (
  allowed: () => boolean,
  getThreadSnapshot?: ThreadManagementService.ThreadManagementServiceShape["getThreadSnapshot"],
) =>
  Effect.gen(function* () {
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "thread-transcript" },
      ProviderAdapterRegistry.layerFromAdapters([]),
      { runEffectWorker: false },
    );
    const services = yield* Layer.build(
      Layer.mergeAll(
        runtime,
        ThreadManagementService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(runtime, CommandReceiptStore.layer, ServerSettings.layerTest({})),
          ),
        ),
        OrchestrationEventStore.layer,
        ProjectStore.layer,
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    );
    const eventSink = Context.get(services, EventSinkV2);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("create-source"),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    const routes = HttpApiBuilder.layer(TranscriptTestApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("test-session"),
                subject: "test",
                method: "bearer-access-token",
                scopes: new Set<AuthEnvironmentScope>(allowed() ? ["orchestration:read"] : []),
              }),
            ),
          ),
        ),
      ),
      Layer.provide(
        Layer.succeedContext(
          getThreadSnapshot === undefined
            ? services
            : Context.add(services, ThreadManagementService.ThreadManagementService, {
                ...Context.get(services, ThreadManagementService.ThreadManagementService),
                getThreadSnapshot,
              }),
        ),
      ),
      Layer.provide(Layer.mock(ProjectEnrichmentService)({})),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    return { services, eventSink, handler };
  });

it.effect("exports full visible history with scope and missing-thread checks", () =>
  Effect.gen(function* () {
    let allowed = true;
    const { services, eventSink, handler } = yield* serveOrchestrationHttp(() => allowed);
    const read = (threadId: ThreadId) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/threads/${threadId}/transcript`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );

    const emptyResponse = yield* read(thread.id);
    expect(emptyResponse.status).toBe(200);
    expect(
      (yield* decodeTranscript(yield* Effect.promise(() => emptyResponse.json()))).items,
    ).toEqual([]);
    yield* eventSink.write({
      events: items.map((item) => ({
        id: EventId.make(`create-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });

    const response = yield* read(thread.id);
    expect(response.status).toBe(200);
    const transcript = yield* decodeTranscript(yield* Effect.promise(() => response.json()));
    expect(transcript.items).toHaveLength(200);
    expect(transcript.items[0]?.item).toMatchObject({ output });
    expect(transcript.items[0]?.visibility).toBe("local");
    expect(transcript.items[199]?.position).toBe(199);

    const sql = Context.get(services, SqlClient.SqlClient);
    const commandItemId = items[0]!.id;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("create-rolled-back-run"),
          type: "run.created",
          threadId: thread.id,
          occurredAt: now,
          payload: rolledBackRun,
        },
      ],
    });
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET run_id = ${rolledBackRun.id},
        payload_json = json_set(payload_json, '$.runId', ${rolledBackRun.id})
      WHERE turn_item_id = ${commandItemId}
    `;
    const withoutRolledBackRun = yield* read(thread.id);
    expect(withoutRolledBackRun.status).toBe(200);
    expect(
      (yield* decodeTranscript(yield* Effect.promise(() => withoutRolledBackRun.json()))).items,
    ).toHaveLength(199);

    expect((yield* read(ThreadId.make("missing"))).status).toBe(404);
    allowed = false;
    expect((yield* read(thread.id)).status).toBe(403);
  }),
);

it.effect("exports a transcript with oversized fields dropped by the decoder", () =>
  Effect.gen(function* () {
    const { services, eventSink, handler } = yield* serveOrchestrationHttp(() => true);
    const item = {
      ...items.find((item) => item.type === "command_execution")!,
      type: "user_message" as const,
      createdBy: "user" as const,
      creationSource: "web" as const,
      messageId: MessageId.make("message:legacy"),
      inputIntent: "turn_start" as const,
      text: "Keep this message",
      attachments: [],
    };
    const followingItem = items[1]!;
    const queuedItem = {
      ...item,
      id: items[2]!.id,
      ordinal: 2,
      runId: rolledBackRun.id,
      inputIntent: "queued_turn" as const,
      text: "Hide this message",
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("create-cancelled-run"),
          type: "run.created",
          threadId: thread.id,
          occurredAt: now,
          payload: { ...rolledBackRun, status: "cancelled" },
        },
        ...[item, followingItem, queuedItem].map((item) => ({
          id: EventId.make(`legacy:${item.id}`),
          type: "turn-item.updated" as const,
          threadId: thread.id,
          occurredAt: now,
          payload: item,
        })),
      ],
    });
    const sql = Context.get(services, SqlClient.SqlClient);
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_set(payload_json, '$.droppedLegacyField',
        printf('%.*c', ${PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1}, 'x'))
      WHERE turn_item_id = ${item.id}
    `;
    const read = () =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/threads/${thread.id}/transcript`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );
    const response = yield* read();
    expect(response.status).toBe(200);
    const body = (yield* Effect.promise(() => response.json())) as {
      items: Array<{ sourceItemId: string; item: object }>;
    };
    expect(body.items[0]?.item).not.toHaveProperty("droppedLegacyField");
    const deepField = sql`'"droppedDeepField":' || printf('%.*c', 1001, '[') || printf('%.*c', 1001, ']') || ','`;
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = '{' || ${deepField} || substr(payload_json, 2)
      WHERE turn_item_id IN (${item.id}, ${queuedItem.id})
    `;
    const deepResponse = yield* read();
    expect(deepResponse.status).toBe(200);
    const deepBody = (yield* Effect.promise(() => deepResponse.json())) as typeof body;
    expect(deepBody.items.map((row) => row.sourceItemId)).toEqual([item.id, followingItem.id]);
    expect(deepBody.items[0]?.item).toMatchObject({ text: item.text });
    expect(deepBody.items[0]?.item).not.toHaveProperty("droppedDeepField");

    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = '{'
      WHERE turn_item_id = ${item.id}
    `;
    const malformedResponse = yield* read();
    expect(malformedResponse.status).toBe(200);
    const malformedTranscript = yield* decodeTranscript(
      yield* Effect.promise(() => malformedResponse.json()),
    );
    expect(malformedTranscript.items).toMatchObject([
      { sourceItemId: followingItem.id, position: 0 },
    ]);
  }),
);

it.effect("stops transcript payload reads at the page that crosses the encoded limit", () =>
  Effect.gen(function* () {
    const { services, eventSink } = yield* serveOrchestrationHttp(() => true);
    const [first, next] = items;
    yield* eventSink.write({
      events: [first!, next!].map((item) => ({
        id: EventId.make(`export:${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });
    const sql = Context.get(services, SqlClient.SqlClient);
    const [size] = yield* sql<{ overhead: number }>`
      SELECT SUM(octet_length(json_set(payload_json, '$.output', ''))) AS overhead
      FROM orchestration_v2_projection_turn_items WHERE thread_id = ${thread.id}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_set(payload_json, '$.output',
        printf('%.*c', ${PROVIDER_SEND_TURN_MAX_FILE_BYTES - size!.overhead - 1}, 'x'))
      WHERE turn_item_id = ${first!.id}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_set(payload_json, '$.output', '')
      WHERE turn_item_id = ${next!.id}
    `;
    const reads: unknown[] = [];
    const error = yield* Context.get(services, ThreadManagementService.ThreadManagementService)
      .getThreadTranscript(thread.id)
      .pipe(
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query, args] = statement.compile();
          if (query.includes("SELECT item.thread_id, item.turn_item_id, item.payload_json")) {
            reads.push(JSON.parse(String(args[0])));
          }
          return Effect.succeed(statement);
        }),
        Effect.flip,
      );
    expect(error).toBeInstanceOf(ThreadManagementService.ThreadTranscriptTooLargeError);
    expect(reads).toEqual([[{ threadId: thread.id, id: first!.id }]]);
  }),
);

it.effect("exports a fork without reading later runs from its parent", () =>
  Effect.gen(function* () {
    const { services, eventSink, handler } = yield* serveOrchestrationHttp(() => true);
    const firstRun = { ...rolledBackRun, status: "completed" as const };
    const lateRun = { ...firstRun, id: RunId.make("run:late"), ordinal: 2 };
    const forkId = ThreadId.make("fork");
    const events = [
      { type: "run.created" as const, payload: firstRun },
      { type: "run.created" as const, payload: lateRun },
      { type: "turn-item.updated" as const, payload: { ...items[0]!, runId: firstRun.id } },
      { type: "turn-item.updated" as const, payload: { ...items[1]!, runId: lateRun.id } },
    ].map((event, index) => ({
      ...event,
      id: EventId.make(`source:${index}`),
      threadId: thread.id,
      occurredAt: now,
    }));
    yield* eventSink.write({
      events: [
        ...events,
        {
          id: EventId.make("create-early-fork"),
          type: "thread.created",
          threadId: forkId,
          occurredAt: now,
          payload: {
            ...thread,
            id: forkId,
            forkedFrom: { type: "run", threadId: thread.id, runId: firstRun.id },
            lineage: {
              parentThreadId: thread.id,
              relationshipToParent: "fork",
              rootThreadId: thread.id,
            },
          },
        },
      ],
    });
    const sql = Context.get(services, SqlClient.SqlClient);
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{}'
      WHERE run_id = ${lateRun.id}
    `;
    const response = yield* Effect.promise(() =>
      handler(
        new Request(`http://localhost/api/orchestration/threads/${forkId}/transcript`, {
          headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
        }),
      ),
    );
    expect(response.status).toBe(200);
    const transcript = yield* decodeTranscript(yield* Effect.promise(() => response.json()));
    expect(transcript.items.map(({ item, visibility }) => [item.type, visibility])).toEqual([
      ["command_execution", "inherited"],
      ["fork", "synthetic"],
    ]);
    expect(transcript.items[0]?.sourceItemId).toBe(items[0]!.id);
  }),
);

it.effect.each([
  { hidden: false, name: "a duplicate message projection" },
  { hidden: true, name: "a rolled-back item" },
])("exports a transcript that fits alongside $name", ({ hidden }) =>
  Effect.gen(function* () {
    const { services, eventSink, handler } = yield* serveOrchestrationHttp(() => true);
    const sql = Context.get(services, SqlClient.SqlClient);
    const messageId = MessageId.make("message:export");
    const commandItem = items.find((item) => item.type === "command_execution")!;
    const messageItem = {
      ...commandItem,
      type: "assistant_message" as const,
      messageId,
      text: "Visible reply",
      streaming: false,
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("export-visible"),
          threadId: thread.id,
          occurredAt: now,
          type: "turn-item.updated",
          payload: messageItem,
        },
        ...(hidden
          ? [
              {
                id: EventId.make("export-rolled-back-run"),
                threadId: thread.id,
                occurredAt: now,
                type: "run.created" as const,
                payload: rolledBackRun,
              },
              {
                id: EventId.make("export-hidden"),
                threadId: thread.id,
                occurredAt: now,
                type: "turn-item.updated" as const,
                payload: { ...messageItem, id: items[1]!.id, runId: rolledBackRun.id, ordinal: 2 },
              },
            ]
          : [
              {
                id: EventId.make("export-message"),
                threadId: thread.id,
                occurredAt: now,
                type: "message.updated" as const,
                payload: {
                  id: messageId,
                  threadId: thread.id,
                  runId: null,
                  nodeId: null,
                  role: "assistant" as const,
                  text: messageItem.text,
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                  createdBy: "agent" as const,
                  creationSource: "provider" as const,
                },
              },
            ]),
      ],
    });
    const textBytes = 26 * 1024 * 1024;
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_set(payload_json, '$.text', printf('%.*c', ${textBytes}, 'x'))
      WHERE thread_id = ${thread.id}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_messages
      SET payload_json = json_set(payload_json, '$.text', printf('%.*c', ${textBytes}, 'x'))
      WHERE message_id = ${messageId}
    `;
    const response = yield* Effect.promise(() =>
      handler(
        new Request(`http://localhost/api/orchestration/threads/${thread.id}/transcript`, {
          headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
        }),
      ),
    );
    yield* Effect.promise(() => response.body!.cancel());
    expect(response.status).toBe(200);
  }),
);

it.effect.each([
  { type: "reasoning", inherited: false },
  { type: "assistant_message", inherited: false },
  { type: "reasoning", inherited: true },
] as const)(
  "bounds transcript projection reads for $type (inherited: $inherited)",
  ({ type, inherited }) =>
    Effect.gen(function* () {
      const { services, eventSink, handler } = yield* serveOrchestrationHttp(() => true);
      const run = { ...rolledBackRun, status: "completed" as const };
      const forkId = ThreadId.make("fork");
      const item = items.find((item) => item.type === "command_execution")!;
      const textItem = {
        ...item,
        runId: run.id,
        text: "Small transcript",
        streaming: false,
      };
      const events = [
        {
          id: EventId.make("create-run"),
          type: "run.created" as const,
          threadId: thread.id,
          occurredAt: now,
          payload: run,
        },
        {
          id: EventId.make("create-item"),
          type: "turn-item.updated" as const,
          threadId: thread.id,
          occurredAt: now,
          payload:
            type === "reasoning"
              ? { ...textItem, type }
              : { ...textItem, type, messageId: MessageId.make("message:assistant") },
        },
        {
          id: EventId.make("create-fork"),
          type: "thread.created" as const,
          threadId: forkId,
          occurredAt: now,
          payload: {
            ...thread,
            id: forkId,
            forkedFrom: { type: "run" as const, threadId: thread.id, runId: run.id },
            lineage: {
              parentThreadId: thread.id,
              relationshipToParent: "fork" as const,
              rootThreadId: thread.id,
            },
          },
        },
      ];
      yield* eventSink.write({ events });
      const threadId = inherited ? forkId : thread.id;
      const read = () =>
        Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/orchestration/threads/${threadId}/transcript`, {
              headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
            }),
          ),
        );
      const smallResponse = yield* read();
      expect(smallResponse.status).toBe(200);
      expect(
        (yield* decodeTranscript(yield* Effect.promise(() => smallResponse.json()))).items,
      ).toContainEqual(
        expect.objectContaining({
          visibility: inherited ? "inherited" : "local",
          item: expect.objectContaining({ type, text: "Small transcript" }),
        }),
      );

      const sql = Context.get(services, SqlClient.SqlClient);
      yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_set(payload_json, '$.text', printf('%.*c', ${PROVIDER_SEND_TURN_MAX_FILE_BYTES}, 'x'))
      WHERE turn_item_id = ${item.id}
    `;
      const reads: string[] = [];
      const error = yield* Context.get(services, ThreadManagementService.ThreadManagementService)
        .getThreadTranscript(threadId)
        .pipe(
          Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(environmentId),
          }),
          Effect.provideService(Statement.CurrentTransformer, (statement) => {
            const [query] = statement.compile();
            if (query.includes("CROSS JOIN orchestration_v2_projection_turn_items AS item")) {
              reads.push(query);
            }
            return Effect.succeed(statement);
          }),
          Effect.flip,
        );
      expect(error).toBeInstanceOf(ThreadManagementService.ThreadTranscriptTooLargeError);
      expect(reads).toEqual([
        expect.stringContaining("SELECT item.thread_id, item.turn_item_id, item.payload_json"),
      ]);
      const largeResponse = yield* read();
      expect(largeResponse.status).toBe(400);
      expect(yield* Effect.promise(() => largeResponse.json())).toMatchObject({
        reason: "thread_transcript_too_large",
      });
    }),
);

it.effect("rejects an oversized full thread snapshot and still serves bounded history", () =>
  Effect.gen(function* () {
    const { services, eventSink, handler } = yield* serveOrchestrationHttp(() => true);
    const read = (suffix = "") =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/threads/${thread.id}${suffix}`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );
    yield* eventSink.write({
      events: items
        .filter((item) => item.type === "command_execution")
        .slice(0, 12)
        .map((item) => ({
          id: EventId.make(`create-${item.id}`),
          type: "turn-item.updated" as const,
          threadId: thread.id,
          occurredAt: now,
          payload: { ...item, type: "reasoning", text: "Thinking", streaming: false },
        })),
    });
    const smallSnapshot = yield* read();
    expect(smallSnapshot.status).toBe(200);
    expect(yield* Effect.promise(() => smallSnapshot.json())).toMatchObject({
      projection: {
        turnItems: expect.arrayContaining([expect.objectContaining({ text: "Thinking" })]),
      },
    });

    const sql = Context.get(services, SqlClient.SqlClient);
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_set(payload_json, '$.text', printf('%.*c', ${768 * 1024}, 'x'))
      WHERE thread_id = ${thread.id}
    `;

    const oversizedSnapshot = yield* read();
    expect(oversizedSnapshot.status).toBe(400);
    expect(yield* Effect.promise(() => oversizedSnapshot.json())).toMatchObject({
      _tag: "EnvironmentRequestInvalidError",
      reason: "thread_snapshot_too_large",
    });
    const boundedSnapshot = yield* read("/bounded");
    expect(boundedSnapshot.status).toBe(200);
    expect(yield* Effect.promise(() => boundedSnapshot.json())).toMatchObject({
      hasMoreHistory: true,
    });
  }),
);

it.effect("rejects oversized WebSocket snapshots on initial subscribe and cursor fallback", () =>
  Effect.gen(function* () {
    const { services, eventSink } = yield* serveOrchestrationHttp(() => true);
    const item = items.find((item) => item.type === "command_execution")!;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`create-${item.id}`),
          type: "turn-item.updated",
          threadId: thread.id,
          occurredAt: now,
          payload: { ...item, type: "reasoning", text: "Thinking", streaming: false },
        },
      ],
    });
    const sql = Context.get(services, SqlClient.SqlClient);
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_set(payload_json, '$.text', printf('%.*c', ${9 * 1024 * 1024}, 'x'))
      WHERE turn_item_id = ${item.id}
    `;
    for (const cursor of [{}, { afterSequence: Number.MAX_SAFE_INTEGER }]) {
      const result = yield* subscribeOrchestrationV2Thread({ threadId: thread.id, ...cursor }).pipe(
        Effect.provideContext(services),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "OrchestrationV2GetThreadProjectionError",
          reason: "thread_snapshot_too_large",
        });
      }
    }
  }),
);

const decodeThreadSnapshot = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot),
);

it.effect("streams the full snapshot with the endpoint's errors", () =>
  Effect.gen(function* () {
    const { services, eventSink, handler } = yield* serveOrchestrationHttp(() => true);
    yield* eventSink.write({
      events: items.map((item) => ({
        id: EventId.make(`create-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });
    const read = (serve: typeof handler, threadId: ThreadId) =>
      Effect.promise(() =>
        serve(
          new Request(`http://localhost/api/orchestration/threads/${threadId}`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );
    const snapshot = yield* Context.get(
      services,
      ThreadManagementService.ThreadManagementService,
    ).getThreadSnapshot(thread.id);

    const response = yield* read(handler, thread.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = decodeThreadSnapshot(yield* Effect.promise(() => response.json()));
    expect(body.snapshotSequence).toBe(snapshot.snapshotSequence);
    expect(body.projection.turnItems).toHaveLength(snapshot.projection.turnItems.length);

    const missing = yield* read(handler, ThreadId.make("missing"));
    expect(missing.status).toBe(404);
    expect(yield* Effect.promise(() => missing.json())).toMatchObject({
      _tag: "EnvironmentResourceNotFoundError",
      reason: "thread_not_found",
    });
    const failing = yield* serveOrchestrationHttp(
      () => true,
      (threadId) =>
        Effect.fail(new OrchestratorProjectionError({ threadId, cause: new Error("disk I/O") })),
    );
    const failed = yield* read(failing.handler, thread.id);
    expect(failed.status).toBe(500);
    expect(yield* Effect.promise(() => failed.json())).toMatchObject({
      _tag: "EnvironmentInternalError",
      reason: "orchestration_thread_snapshot_failed",
    });
    // A projection its schema rejects is an empty 500, as a failed response encoding is.
    const [first, ...rest] = snapshot.projection.turnItems;
    const unencodable = yield* serveOrchestrationHttp(
      () => true,
      () =>
        Effect.succeed({
          ...snapshot,
          projection: {
            ...snapshot.projection,
            turnItems: [
              { ...first!, status: "unknown" } as unknown as OrchestrationV2TurnItem,
              ...rest,
            ],
          },
        }),
    );
    const rejected = yield* read(unencodable.handler, thread.id);
    expect(rejected.status).toBe(500);
    expect(yield* Effect.promise(() => rejected.text())).toBe("");
  }),
);

it.effect("leaves older settled threads out of the HTTP shell only when asked", () =>
  Effect.gen(function* () {
    const { eventSink, handler } = yield* serveOrchestrationHttp(() => true);
    yield* eventSink.write({
      events: Array.from({ length: 26 }, (_, index) => {
        const id = ThreadId.make(`settled-${index}`);
        return {
          id: EventId.make(`create-${id}`),
          type: "thread.created" as const,
          threadId: id,
          occurredAt: now,
          payload: {
            ...thread,
            id,
            lineage: { ...thread.lineage, rootThreadId: id },
            settledOverride: "settled" as const,
            settledAt: DateTime.makeUnsafe(Date.UTC(2026, 8, 1 + index)),
          },
        };
      }),
    });
    const shell = (query: string) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://localhost/api/orchestration/shell${query}`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        );
        return (await response.json()) as {
          readonly snapshotSequence: number;
          readonly projectIdentities?: string;
          readonly threads: ReadonlyArray<{ readonly id: string }>;
          readonly olderSettled?: { readonly counts: ReadonlyArray<unknown> };
        };
      });

    const full = yield* shell("");
    expect(full.threads).toHaveLength(27);
    expect(full.olderSettled).toBeUndefined();
    const cut = yield* shell("?omitOlderSettled=1");
    expect(cut.threads.map((row) => row.id).toSorted()).toEqual(
      [thread.id, ...Array.from({ length: 25 }, (_, index) => `settled-${index + 1}`)].toSorted(),
    );
    expect(cut.olderSettled?.counts).toEqual([{ projectId: thread.projectId, count: 1 }]);

    // A client that holds rows the socket can replay from keeps them; any other cursor reloads.
    expect(full.projectIdentities).toBeTypeOf("string");
    expect(yield* shell(`?resumeFrom=${full.snapshotSequence}`)).toEqual({ resumable: true });
    expect(yield* shell(`?resumeFrom=${full.snapshotSequence - 1}`)).toEqual({ resumable: true });
    for (const cursor of [full.snapshotSequence + 1, "x"]) {
      expect((yield* shell(`?omitOlderSettled=1&resumeFrom=${cursor}`)).threads).toHaveLength(26);
    }
  }),
);
