import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import {
  classifyAttention,
  decodeAttentionCursor,
  encodeAttentionCursor,
  pageAttention,
  planThreadReply,
  presentAttentionText,
} from "./threadAttention.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const shell = (
  id: string,
  patch: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(ThreadId.make(id)),
  status: "completed",
  activityRunStatus: null,
  activeRunId: null,
  latestRunId: RunId.make(`run:${id}`),
  ...patch,
});

describe("thread attention", () => {
  it("clips and redacts watcher text", () => {
    assert.equal(presentAttentionText("  hello  "), "hello");
    assert.equal(
      presentAttentionText("use sk-abcdefghijklmnopqrstuvwxyz please"),
      "use [withheld] please",
    );
    assert.equal(
      presentAttentionText("https://user:secret@example.com/hook"),
      "https://[withheld]@example.com/hook",
    );
    assert.equal(presentAttentionText("x".repeat(300))?.length, 240);
    assert.equal(presentAttentionText("   "), null);
  });

  it("decodes a cursor and an ISO time", () => {
    assert.deepEqual(decodeAttentionCursor("2026-01-02T00:00:00.000Z\nthread-b"), {
      updatedAt: "2026-01-02T00:00:00.000Z",
      threadId: "thread-b",
    });
    assert.deepEqual(decodeAttentionCursor("2026-01-02T00:00:00.000Z"), {
      updatedAt: "2026-01-02T00:00:00.000Z",
      threadId: "",
    });
    assert.equal(decodeAttentionCursor("not-a-time"), undefined);
    assert.equal(
      encodeAttentionCursor("2026-01-02T00:00:00.000Z", "thread-b"),
      "2026-01-02T00:00:00.000Z\nthread-b",
    );
  });

  it("classifies waiting, blocked, and finished threads", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const question = shell("question", {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("req-q"),
        kind: "user_input",
        createdAt: at("2026-06-01T00:00:00.000Z"),
        blocking: true,
      },
      activityRunStatus: "running",
    });
    assert.equal(classifyAttention(question, now, false), "question");
    assert.equal(
      classifyAttention(
        shell("approval", {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("req-a"),
            kind: "command",
            createdAt: at("2026-06-01T00:00:00.000Z"),
            blocking: true,
          },
          activityRunStatus: "running",
        }),
        now,
        false,
      ),
      "approval",
    );
    assert.equal(classifyAttention(shell("done"), now, false), "finished");
    assert.equal(
      classifyAttention(shell("working", { activityRunStatus: "running" }), now, false),
      null,
    );
    assert.equal(classifyAttention(shell("failed", { status: "failed" }), now, false), "blocked");
    assert.equal(
      classifyAttention(
        shell("secret", {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("card"),
            kind: "user_input",
            createdAt: at("2026-06-01T00:00:00.000Z"),
            blocking: true,
            userOnly: true,
          },
        }),
        now,
        false,
      ),
      "blocked",
    );
    assert.equal(
      classifyAttention(
        shell("child", {
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        }),
        now,
        false,
      ),
      null,
    );
    assert.equal(
      classifyAttention(
        shell("snoozed", {
          snoozedUntil: at("2099-01-01T00:00:00.000Z"),
          snoozedAt: at("2026-01-01T00:00:00.000Z"),
          latestRunCompletedAt: at("2026-01-02T00:00:00.000Z"),
        }),
        now,
        false,
      ),
      null,
    );
    assert.equal(
      classifyAttention(shell("settled", { settledOverride: "settled" }), now, false),
      null,
    );
  });

  it("pages past threads that are still working", () => {
    const candidates = [
      { id: "running", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "done", updatedAt: "2026-01-02T00:00:00.000Z" },
      { id: "later", updatedAt: "2026-01-03T00:00:00.000Z" },
    ];
    const first = pageAttention({
      candidates,
      hasMoreCandidates: false,
      limit: 1,
      classify: (candidate) => (candidate.id === "running" ? null : "finished"),
    });
    assert.deepEqual(
      first.matches.map((match) => match.candidate.id),
      ["done"],
    );
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, "2026-01-02T00:00:00.000Z\ndone");
    const rest = pageAttention({
      candidates: candidates.slice(2),
      hasMoreCandidates: false,
      limit: 1,
      classify: () => "finished",
    });
    assert.equal(rest.hasMore, false);
    assert.equal(rest.nextCursor, null);
  });

  it("plans an answer, an approval, and a follow-up", () => {
    const requestId = RuntimeRequestId.make("req");
    const waiting = shell("waiting", {
      pendingRuntimeRequest: {
        id: requestId,
        kind: "user_input",
        createdAt: at("2026-06-01T00:00:00.000Z"),
        blocking: true,
      },
      activityRunStatus: "running",
      status: "running",
    });
    const requests = [
      {
        id: requestId,
        kind: "user_input" as const,
        status: "pending" as const,
      },
    ];
    assert.equal(
      planThreadReply({
        shell: waiting,
        requests,
        turnItems: [],
        action: "answer",
        requestId,
        answers: { ship: "yes" },
        message: undefined,
      })._tag,
      "Answer",
    );
    assert.equal(
      planThreadReply({
        shell: waiting,
        requests,
        turnItems: [],
        action: "message",
        requestId: undefined,
        answers: undefined,
        message: "go",
      })._tag,
      "Refuse",
    );
    const finished = shell("finished");
    const sent = planThreadReply({
      shell: finished,
      requests: [],
      turnItems: [],
      action: "message",
      requestId: undefined,
      answers: undefined,
      message: "Ship it.",
    });
    assert.deepEqual(sent, { _tag: "Send", message: "Ship it." });
    const approvalId = RuntimeRequestId.make("approval");
    const decided = planThreadReply({
      shell: shell("approve", {
        pendingRuntimeRequest: {
          id: approvalId,
          kind: "command",
          createdAt: at("2026-06-01T00:00:00.000Z"),
          blocking: true,
        },
        activityRunStatus: "running",
        status: "running",
      }),
      requests: [{ id: approvalId, kind: "command", status: "pending" }],
      turnItems: [],
      action: "deny",
      requestId: approvalId,
      answers: undefined,
      message: undefined,
    });
    assert.deepEqual(decided, { _tag: "Decide", requestId: approvalId, decision: "decline" });
    assert.deepEqual(
      planThreadReply({
        shell: waiting,
        requests: [{ id: requestId, kind: "user_input", status: "resolved" }],
        turnItems: [],
        action: "answer",
        requestId,
        answers: { ship: "yes" },
        message: undefined,
      }),
      { _tag: "Refuse", message: "The request was already answered." },
    );
    assert.equal(
      planThreadReply({
        shell: shell("secret", {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("card"),
            kind: "user_input",
            createdAt: at("2026-06-01T00:00:00.000Z"),
            userOnly: true,
          },
        }),
        requests: [],
        turnItems: [],
        action: "answer",
        requestId: RuntimeRequestId.make("card"),
        answers: { value: "nope" },
        message: undefined,
      })._tag,
      "Refuse",
    );
  });
});

const layerStore = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

const insertThread = (
  sql: SqlClient.SqlClient,
  input: {
    readonly id: string;
    readonly updatedAt: string;
    readonly payload: string;
    readonly archivedAt?: string | null;
    readonly deletedAt?: string | null;
  },
) =>
  sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${input.id}, 'project-1', ${input.id}, 'codex', 'full-access', 'default',
      ${input.updatedAt}, ${input.updatedAt}, ${input.archivedAt ?? null}, ${input.deletedAt ?? null},
      ${input.payload}
    )
  `;

const lineage = (relationship: string | null, sideChat = false) =>
  JSON.stringify({
    lineage: {
      relationshipToParent: relationship,
      parentThreadId: relationship === null ? null : "parent",
      rootThreadId: "root",
      sideChat,
    },
    settledOverride: null,
  });

describe("thread attention reads", () => {
  it.effect("walks a bounded cursor and truncates card text", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* insertThread(sql, {
        id: "old",
        updatedAt: "2026-01-01T00:00:00.000Z",
        payload: lineage(null),
      });
      yield* insertThread(sql, {
        id: "settled",
        updatedAt: "2026-01-02T00:00:00.000Z",
        payload: JSON.stringify({
          lineage: { relationshipToParent: null, parentThreadId: null, rootThreadId: "root" },
          settledOverride: "settled",
        }),
      });
      yield* insertThread(sql, {
        id: "child",
        updatedAt: "2026-01-03T00:00:00.000Z",
        payload: lineage("subagent"),
      });
      yield* insertThread(sql, {
        id: "side",
        updatedAt: "2026-01-04T00:00:00.000Z",
        payload: lineage(null, true),
      });
      yield* insertThread(sql, {
        id: "gone",
        updatedAt: "2026-01-05T00:00:00.000Z",
        payload: lineage(null),
        deletedAt: "2026-01-05T00:00:00.000Z",
      });
      yield* insertThread(sql, {
        id: "waiting",
        updatedAt: "2026-01-06T00:00:00.000Z",
        payload: lineage(null),
      });
      const question = `${"Ship it? "}${"x".repeat(500)} sk-abcdefghijklmnopqrstuvwxyz`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runtime_requests (
          runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json
        ) VALUES (
          'req-waiting', 'waiting', 'node-waiting', 'user_input', 'pending',
          '2026-01-06T00:00:00.000Z', '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, node_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          'item-waiting', 'waiting', 'node-waiting', 1, 'user_input_request', 'running',
          '2026-01-06T00:00:00.000Z', ${JSON.stringify({
            requestId: "req-waiting",
            questions: [{ question }],
          })}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, role, streaming, created_at, updated_at, payload_json
        ) VALUES (
          'msg-waiting', 'waiting', 'assistant', 0,
          '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:00.000Z',
          ${JSON.stringify({ text: `Done. sk-abcdefghijklmnopqrstuvwxyz ${"y".repeat(500)}` })}
        )
      `;
      const first = yield* store.listAttentionCandidates({ includeSubagents: false, limit: 1 });
      assert.deepEqual(
        first.threads.map((thread) => thread.id),
        ["old"],
      );
      assert.equal(first.hasMore, true);
      const next = yield* store.listAttentionCandidates({
        includeSubagents: false,
        limit: 10,
        sinceUpdatedAt: first.threads[0]?.updatedAt,
        sinceThreadId: first.threads[0]?.id,
      });
      assert.deepEqual(
        next.threads.map((thread) => thread.id),
        ["waiting"],
      );
      const withChildren = yield* store.listAttentionCandidates({
        includeSubagents: true,
        limit: 10,
      });
      assert.ok(withChildren.threads.some((thread) => thread.id === "child"));
      assert.ok(withChildren.threads.every((thread) => thread.id !== "side"));
      assert.ok(withChildren.threads.every((thread) => thread.id !== "settled"));
      const [text] = yield* store.readAttentionTexts([ThreadId.make("waiting")]);
      assert.ok((text?.summary?.length ?? 0) <= 400);
      assert.ok(text?.summary?.startsWith("Done."));
      assert.equal(text?.cards[0]?.requestId, "req-waiting");
      assert.ok((text?.cards[0]?.detail?.length ?? 0) <= 400);
      assert.ok(text?.cards[0]?.detail?.startsWith("Ship it?"));
      assert.deepEqual(yield* store.readAttentionTexts([]), []);
    }).pipe(Effect.provide(layerStore)),
  );
});

describe("OrchestratorMcpService thread watcher", () => {
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:watcher"),
    requestNamespace: "client:watcher",
    thread: undefined,
    client: { sessionId: "watcher", label: "Grok Bot", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const running = shell("running", { activityRunStatus: "running", status: "running" });
  const finished = shell("finished", { title: "Ship the watcher" });
  const requestId = RuntimeRequestId.make("req-finished");
  const waiting = shell("waiting", {
    title: "Need a decision",
    status: "running",
    activityRunStatus: "running",
    pendingRuntimeRequest: {
      id: requestId,
      kind: "user_input",
      createdAt: at("2026-06-01T00:00:00.000Z"),
      blocking: true,
    },
  });
  const shells = new Map([running, finished, waiting].map((thread) => [thread.id, thread]));
  const dispatched: Array<unknown> = [];
  const sent: Array<unknown> = [];

  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listAttentionCandidates: () =>
            Effect.succeed({
              hasMore: false,
              threads: [running, finished, waiting].map((thread) => ({
                id: thread.id,
                projectId: thread.projectId,
                title: thread.title,
                updatedAt: DateTime.formatIso(thread.updatedAt),
              })),
            }),
          getShellSnapshot: (options) =>
            Effect.succeed({
              threads: (options?.threadIds ?? []).flatMap((id) => shells.get(id) ?? []),
            } as never),
          readAttentionTexts: (threadIds) =>
            Effect.succeed(
              threadIds.map((threadId) => ({
                threadId,
                summary:
                  threadId === finished.id
                    ? "Opened the pull request. sk-abcdefghijklmnopqrstuvwxyz"
                    : "Which name?",
                cards:
                  threadId === waiting.id
                    ? [{ requestId, kind: "user_input", detail: "Which name?" }]
                    : [],
              })),
            ),
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
          getProjectThreadRecords: () =>
            Effect.succeed({
              runtimeRequests: [{ id: requestId, kind: "user_input", status: "pending" }],
              turnItems: [],
              thread: waiting,
            } as never),
          dispatch: (command) => {
            dispatched.push(command);
            return Effect.succeed({ sequence: 4 } as never);
          },
          sendToThread: (input) => {
            sent.push(input);
            return Effect.succeed({
              run: { id: RunId.make("run:sent"), status: "starting" },
              delivery: "started",
            } as never);
          },
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );

  it.effect("lists threads that need a person or have finished", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const listed = yield* mcp.listAttention(client, {});
      assert.deepEqual(
        listed.threads.map((thread) => [thread.threadId, thread.attention, thread.summary]),
        [
          ["finished", "finished", "Opened the pull request. [withheld]"],
          ["waiting", "question", "Which name?"],
        ],
      );
      assert.equal(listed.threads[1]?.question, "Which name?");
      assert.equal(listed.threads[1]?.requestId, requestId);
      assert.equal(listed.hasMore, false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("answers a pending question and refuses a follow-up while it waits", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const answered = yield* mcp.replyToThread(client, {
        threadId: waiting.id,
        action: "answer",
        requestId,
        answers: { name: "Watcher" },
      });
      assert.equal(answered.sequence, 4);
      assert.equal((dispatched[0] as { type: string }).type, "runtime-request.respond");
      const refused = yield* mcp
        .replyToThread(client, { threadId: waiting.id, action: "message", message: "later" })
        .pipe(Effect.flip);
      assert.equal(refused.code, "invalid_request");
      const followed = yield* mcp.replyToThread(client, {
        threadId: finished.id,
        action: "message",
        message: "Ship it.",
      });
      assert.equal(followed.delivery, "started");
      assert.equal(sent.length, 1);
    }).pipe(Effect.provide(layer)),
  );
});
