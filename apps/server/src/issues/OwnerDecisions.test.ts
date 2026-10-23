import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, it } from "@effect/vitest";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import {
  IssueReadError,
  ProjectId,
  ThreadId,
  type OwnerDecisionRequest,
  type RepositoryOrchestration,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Foreign comment fixtures compute hashes independently of the service under test.
import * as NodeCrypto from "node:crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as DontAskModeWorker from "../orchestration-v2/DontAskModeWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueInbox from "./IssueInbox.ts";
import * as IssueWorkStore from "./IssueWorkStore.ts";
import * as IssueWorkService from "./IssueWorkService.ts";
import * as OwnerDecisions from "./OwnerDecisions.ts";

const threadId = ThreadId.make("requester");
const otherThreadId = ThreadId.make("other");
const request: OwnerDecisionRequest = {
  host: "github.com",
  repository: "acme/repo",
  number: 46,
  clientRequestId: "retry-1",
  question: "Adopt the optimization?",
  options: [
    { id: "adopt", label: "Adopt", consequence: "Enable the optimization" },
    { id: "defer", label: "Defer", consequence: "Keep the current implementation" },
  ],
  recommendedOptionId: "adopt",
  recommendationReason: "The benchmarks are faster.",
  evidenceUrl: "https://github.com/acme/repo/issues/45",
};
const owner = {
  kind: "user" as const,
  subject: "signed-in-owner",
  scopes: ["orchestration:operate" as const],
};
const testLayer = Layer.mergeAll(SqlitePersistence.layerMemory, NodeCryptoLayer.layer);
const fakeGithub = () => ({
  comments: [] as Array<{ id: number; body: string; html_url: string }>,
  labels: new Set<string>(),
  beforeLabelDelete: Effect.void,
});
const setup = (
  send?: ThreadManagement.ThreadManagementService["Service"]["dispatch"],
  github = fakeGithub(),
) =>
  Effect.gen(function* () {
    const { comments, labels } = github;
    const commands: OrchestrationV2ServerCommand[] = [];
    let loseCommentResponse = false;
    let loseDeliveryResponse = false;
    let requesterStatus: "available" | "missing" | "deleted" | "archived" = "available";
    let pageSize = 100;
    const configurations = new Map<ThreadId, RepositoryOrchestration>();
    let repositoryOwner = threadId;
    let failLabels = false;
    let pages = 0;
    let dontAskMode = true;
    const dependencies = Layer.mergeAll(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getDontAskMode: Effect.sync(() => dontAskMode),
      }),
      Layer.mock(IssueWorkService.IssueWorkService)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.sync(() =>
            id === threadId && requesterStatus === "missing"
              ? null
              : {
                  ...liveThreadShell(id),
                  projectId: ProjectId.make("science"),
                  title: "Requester",
                  deletedAt:
                    id === threadId && requesterStatus === "deleted"
                      ? DateTime.makeUnsafe(0)
                      : null,
                  archivedAt:
                    id === threadId && requesterStatus === "archived"
                      ? DateTime.makeUnsafe(0)
                      : null,
                },
          ),
        dispatch: (command) =>
          Effect.gen(function* () {
            commands.push(command);
            if (send !== undefined) return yield* send(command);
            if (loseDeliveryResponse) {
              loseDeliveryResponse = false;
              return yield* new Orchestrator.OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: "Lost delivery receipt",
              });
            }
            return { sequence: commands.length, storedEvents: [] };
          }),
      }),
      Layer.mock(IssueWorkStore.IssueWorkStore)({
        configuration: (id) => Effect.sync(() => configurations.get(id) ?? null),
        repositoryOwnerByRef: () =>
          Effect.sync(() => ({
            rootThreadId: repositoryOwner,
            projectId: ProjectId.make("science"),
            paused: false,
            revision: 2,
          })),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeed(
            Option.some({
              title: "Science",
              repositoryIdentity: {
                provider: "github",
                canonicalKey: "github.com/acme/repo",
                displayName: "acme/repo",
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/repo",
                },
              },
            } as never),
          ),
      }),
      Layer.mock(IssueService.IssueService)({
        repositoryRest: (input) =>
          Effect.gen(function* () {
            let body: unknown = [];
            let nextPage: number | null = null;
            if (input.path.endsWith("/comments") && input.method === "POST") {
              const id = comments.length + 1;
              const url = `https://github.com/acme/repo/issues/46#issuecomment-${id}`;
              const comment = { id, body: (input.body as { body: string }).body, html_url: url };
              comments.push(comment);
              if (loseCommentResponse) {
                loseCommentResponse = false;
                return yield* new IssueReadError({
                  code: "upstream",
                  operation: "detail",
                  message: "Lost comment response",
                });
              }
              body = comment;
            } else if (input.path.includes("/comments?")) {
              pages++;
              const page = Number(new URLSearchParams(input.path.split("?")[1]).get("page"));
              body = comments.slice((page - 1) * pageSize, page * pageSize);
              nextPage = page * pageSize < comments.length ? page + 1 : null;
            } else if (input.path === "labels?per_page=100") body = [{ name: "decision-needed" }];
            else if (input.path.includes("/labels")) {
              if (failLabels)
                return yield* new IssueReadError({
                  code: "upstream",
                  operation: "detail",
                  message: "Label failure",
                });
              if (input.method === "DELETE") {
                yield* github.beforeLabelDelete;
                labels.delete("decision-needed");
              } else if (input.method === "POST") labels.add("decision-needed");
              body = [...labels].map((name) => ({ name }));
            }
            return { status: 200, body: JSON.stringify(body), nextPage, etag: null };
          }),
      }),
    );
    const external = Layer.merge(dependencies, IssueInbox.layer.pipe(Layer.provide(dependencies)));
    const start = Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.fresh(OwnerDecisions.layer.pipe(Layer.provide(external))),
      );
      return yield* OwnerDecisions.OwnerDecisions.pipe(Effect.provideContext(context));
    });
    return {
      service: yield* start,
      start,
      comments,
      labels,
      commands,
      loseComment: () => {
        loseCommentResponse = true;
      },
      loseDelivery: () => {
        loseDeliveryResponse = true;
      },
      setRequesterStatus: (value: typeof requesterStatus) => {
        requesterStatus = value;
      },
      setDontAskMode: (value: boolean) => {
        dontAskMode = value;
      },
      setPageSize: (size: number) => {
        pageSize = size;
      },
      handoff: (from: ThreadId, to: ThreadId, includeSuccessor = true) => {
        configurations.set(from, {
          host: "github.com",
          repository: request.repository,
          repositoryId: "repo-id",
          projectId: ProjectId.make("science"),
          launchCommandId: CommandId.make("handoff"),
          revision: 2,
          paused: false,
          workerLimit: 4,
          readOnlyLimit: 4,
          publishStatusComments: false,
          publishCloseoutComments: false,
          milestones: [],
          suspendedIssues: [],
          ...(includeSuccessor ? { retiredToThreadId: to } : {}),
        });
        repositoryOwner = to;
      },
      setFailLabels: (value: boolean) => {
        failLabels = value;
      },
      pages: () => pages,
    };
  });

it.effect("immutable, idempotent requests derive identity and scope agent listing", () =>
  Effect.gen(function* () {
    const { service, start } = yield* setup();
    const concurrentService = yield* start;
    const [first, retry] = yield* Effect.all(
      [service.request(threadId, request), concurrentService.request(threadId, request)],
      { concurrency: "unbounded" },
    );
    assert.equal(first.id, retry.id);
    assert.equal(first.requestingProjectId, "science");
    assert.equal(first.requestingThreadId, threadId);
    assert.equal(first.requestingProjectTitle, "Science");
    assert.equal(
      (yield* service.request(threadId, { ...request, question: "Different" }).pipe(Effect.flip))
        .code,
      "invalid-request",
    );
    const other = yield* service.request(otherThreadId, request);
    assert.notEqual(other.id, first.id);
    assert.deepEqual(
      (yield* service.listForCaller(threadId)).map((record) => record.id),
      [first.id],
    );
    assert.lengthOf(yield* service.list({}), 2);
    assert.lengthOf(yield* service.list({ repository: "another/repo" }), 0);
    for (const input of [
      { ...request, clientRequestId: "bad", recommendedOptionId: "missing" },
      {
        ...request,
        clientRequestId: "duplicate",
        options: [request.options[0]!, request.options[0]!],
      },
    ])
      assert.equal(
        (yield* service.request(threadId, input).pipe(Effect.flip)).code,
        "invalid-request",
      );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("refuses new requests while Ask mode is on but still answers retries", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const recorded = yield* h.service.request(threadId, request);
    h.setDontAskMode(false);
    assert.equal((yield* h.service.request(threadId, request)).id, recorded.id);
    const refused = yield* h.service
      .request(threadId, { ...request, clientRequestId: "while-present" })
      .pipe(Effect.flip);
    assert.equal(refused.code, "invalid-request");
    assert.match(refused.message, /question tool/);
    assert.lengthOf(yield* h.service.list({}), 1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "only the caller can withdraw unanswered requests with a reason; labels remain until all close",
  () =>
    Effect.gen(function* () {
      const { service, labels } = yield* setup();
      const first = yield* service.request(threadId, request);
      const second = yield* service.request(threadId, { ...request, clientRequestId: "second" });
      yield* service.drain;
      assert.isTrue(labels.has("decision-needed"));
      assert.equal(
        (yield* service
          .withdraw(otherThreadId, { id: first.id, reason: "Changed" })
          .pipe(Effect.flip)).code,
        "forbidden",
      );
      assert.equal(
        (yield* service.withdraw(threadId, { id: first.id, reason: " " }).pipe(Effect.flip)).code,
        "invalid-request",
      );
      assert.equal(
        (yield* service.withdraw(threadId, { id: first.id, reason: "Superseded" })).state,
        "withdrawn",
      );
      yield* service.drain;
      assert.isTrue(labels.has("decision-needed"));
      yield* service.choose({ id: second.id, optionId: "defer" }, owner);
      assert.equal(
        (yield* service.withdraw(threadId, { id: second.id, reason: "Too late" }).pipe(Effect.flip))
          .code,
        "invalid-request",
      );
      yield* service.drain;
      assert.isFalse(labels.has("decision-needed"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "only an authenticated owner can choose, and one concurrent click wins with durable work",
  () =>
    Effect.gen(function* () {
      const { service, comments, commands } = yield* setup();
      const decision = yield* service.request(threadId, request);
      assert.equal(
        (yield* service.choose({ id: decision.id, optionId: "adopt" }, owner).pipe(Effect.flip))
          .code,
        "invalid-request",
      );
      yield* service.drain;
      for (const actor of [
        { ...owner, kind: "agent" as const },
        { ...owner, scopes: [] },
        { ...owner, subject: "" },
      ])
        assert.equal(
          (yield* service.choose({ id: decision.id, optionId: "adopt" }, actor).pipe(Effect.flip))
            .code,
          "forbidden",
        );
      const choices = yield* Effect.all(
        ["adopt", "defer"].map((optionId) =>
          service.choose({ id: decision.id, optionId }, owner).pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );
      assert.lengthOf(choices.filter(Result.isSuccess), 1);
      const chosen = (yield* service.listForCaller(threadId))[0]!;
      assert.equal(chosen.chosenBy, owner.subject);
      assert.equal(chosen.pendingPublish, "choice");
      assert.isTrue(chosen.pendingDelivery);
      assert.isNotNull(chosen.chosenAt);
      yield* service.choose({ id: decision.id, optionId: chosen.chosenOptionId! }, owner);
      yield* service.drain;
      assert.lengthOf(comments, 2);
      assert.include(comments[0]!.body, `<!-- t3-decision-request:v1 id=${decision.id} digest=`);
      assert.include(
        comments[1]!.body,
        `<!-- t3-decision-choice:v1 id=${decision.id} option=${chosen.chosenOptionId} digest=`,
      );
      assert.include(comments[1]!.body, chosen.chosenAt!);
      assert.include(comments[1]!.body, "#issuecomment-1");
      const command = commands[0]!;
      assert.equal(command.type, "message.dispatch");
      if (command.type === "message.dispatch") {
        assert.deepEqual(command.dispatchMode, { type: "queue_after_active" });
        assert.deepEqual(command.notification?.source, { kind: "system" });
        const option = request.options.find((entry) => entry.id === chosen.chosenOptionId)!;
        assert.equal(
          command.text,
          `Owner decision ${decision.id} on acme/repo#46: ${option.label}. Next: ${option.consequence}. Evidence: ${request.evidenceUrl}. Owner record: https://github.com/acme/repo/issues/46#issuecomment-2.`,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("reconciles paged markers after lost request and choice responses across restarts", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.setPageSize(2);
    h.comments.push(
      ...[1, 2, 3].map((id) => ({
        id,
        body: "Unrelated",
        html_url: "https://github.com/acme/repo",
      })),
    );
    const decision = yield* h.service.request(threadId, request);
    h.loseComment();
    yield* h.service.drain;
    assert.equal((yield* h.service.listForCaller(threadId))[0]!.state, "publication_failed");
    assert.lengthOf(h.commands, 0);
    const restarted = yield* h.start;
    yield* restarted.drain;
    assert.equal((yield* restarted.listForCaller(threadId))[0]!.state, "awaiting_choice");
    assert.lengthOf(h.comments, 4);
    assert.isAbove(h.pages(), 2);
    yield* restarted.choose({ id: decision.id, optionId: "adopt" }, owner);
    h.loseComment();
    yield* restarted.drain;
    assert.lengthOf(h.commands, 0, "Unconfirmed comments must never wake the requester");
    const again = yield* h.start;
    yield* again.drain;
    assert.lengthOf(h.comments, 5);
    assert.lengthOf(h.commands, 1);
    assert.isNotNull((yield* again.listForCaller(threadId))[0]!.deliveredAt);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each(["missing", "deleted", "archived"] as const)(
  "a %s requester without a successor ends in visible delivery failure",
  (status) =>
    Effect.gen(function* () {
      const h = yield* setup();
      const decision = yield* h.service.request(threadId, request);
      yield* h.service.drain;
      yield* h.service.choose({ id: decision.id, optionId: "adopt" }, owner);
      h.setRequesterStatus(status);
      yield* h.service.drain;
      const record = (yield* h.service.listForCaller(threadId))[0]!;
      assert.equal(record.state, "delivery_failed");
      assert.isFalse(record.pendingDelivery);
      assert.isNull(record.deliveredAt);
      assert.include(record.lastError!, "unavailable");
      assert.isFalse(h.labels.has("decision-needed"));
      const restarted = yield* h.start;
      yield* restarted.drain;
      assert.deepEqual((yield* restarted.listForCaller(threadId))[0], record);
      assert.lengthOf(h.commands, 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each([true, false])(
  "delivery follows repository handoff (explicit successor: %s) and freezes it across restart",
  (includeSuccessor) =>
    Effect.gen(function* () {
      const h = yield* setup();
      const decision = yield* h.service.request(threadId, request);
      yield* h.service.drain;
      h.handoff(threadId, otherThreadId, includeSuccessor);
      h.setRequesterStatus("archived");
      yield* h.service.choose({ id: decision.id, optionId: "adopt" }, owner);
      h.loseDelivery();
      yield* h.service.drain;
      const record = (yield* h.service.listForCaller(threadId))[0]!;
      assert.equal(record.deliveryThreadId, otherThreadId);
      assert.isTrue(record.pendingDelivery);
      assert.equal(h.commands[0]!.type, "message.dispatch");
      if (h.commands[0]!.type === "message.dispatch")
        assert.equal(h.commands[0]!.threadId, otherThreadId);
      h.handoff(otherThreadId, ThreadId.make("third"));
      const restarted = yield* h.start;
      yield* restarted.drain;
      assert.equal(h.commands[1]!.type, "message.dispatch");
      if (h.commands[1]!.type === "message.dispatch")
        assert.equal(h.commands[1]!.threadId, otherThreadId);
      assert.equal(h.commands[0]!.commandId, h.commands[1]!.commandId);
      assert.isFalse((yield* restarted.listForCaller(threadId))[0]!.pendingDelivery);
      yield* restarted.drain;
      assert.lengthOf(h.commands, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each(["request", "choice", "withdrawn"] as const)(
  "an edited %s comment cannot confirm publication and does not cause a repost loop",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* setup();
      const decision = yield* h.service.request(threadId, request);
      if (kind !== "request") {
        yield* h.service.drain;
        if (kind === "choice")
          yield* h.service.choose({ id: decision.id, optionId: "adopt" }, owner);
        else yield* h.service.withdraw(threadId, { id: decision.id, reason: "Superseded" });
      }
      h.loseComment();
      yield* h.service.drain;
      const comment = h.comments.at(-1)!;
      comment.body = comment.body.replace(
        kind === "request"
          ? "Adopt the optimization?"
          : kind === "choice"
            ? "Owner chose Adopt"
            : "Reason: Superseded",
        "Altered readable text",
      );
      const restarted = yield* h.start;
      yield* restarted.drain;
      const record = (yield* restarted.listForCaller(threadId))[0]!;
      assert.equal(record.state, "publication_mismatch");
      assert.isNull(record.pendingPublish);
      assert.isFalse(record.pendingDelivery);
      assert.isFalse(record.pendingLabel);
      assert.include(record.lastError!, "does not match");
      if (kind === "request") assert.isNull(record.requestComment);
      if (kind === "choice") assert.isNull(record.choiceComment);
      const count = h.comments.length;
      yield* restarted.drain;
      assert.lengthOf(h.comments, count);
      assert.lengthOf(h.commands, 0);
      assert.equal((yield* restarted.listForCaller(threadId))[0]!.lastError, record.lastError);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "a self-consistent forged comment cannot stand in for the expected decision content",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const decision = yield* h.service.request(threadId, request);
      h.comments.push({
        id: 1,
        body: `A quoted marker:\n\n<!-- t3-decision-request:v1 id=${decision.id} digest=${NodeCrypto.createHash("sha256").update("A quoted marker:").digest("hex")} -->`,
        html_url: "https://github.com/acme/repo/issues/46#issuecomment-1",
      });
      yield* h.service.drain;
      assert.equal((yield* h.service.listForCaller(threadId))[0]!.state, "publication_mismatch");
      assert.lengthOf(h.comments, 1);
      assert.lengthOf(h.commands, 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "quoting a valid choice comment while preserving its marker cannot confirm publication",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const decision = yield* h.service.request(threadId, request);
      yield* h.service.drain;
      yield* h.service.choose({ id: decision.id, optionId: "adopt" }, owner);
      h.loseComment();
      yield* h.service.drain;
      h.comments[1]!.body = `Quoted from another comment:\n\n${h.comments[1]!.body}`;
      const restarted = yield* h.start;
      yield* restarted.drain;
      assert.equal((yield* restarted.listForCaller(threadId))[0]!.state, "publication_mismatch");
      assert.isNull((yield* restarted.listForCaller(threadId))[0]!.choiceComment);
      assert.lengthOf(h.commands, 0);
      assert.lengthOf(h.comments, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "delivery traverses multiple retired roots even when the original requester is deleted",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const decision = yield* h.service.request(threadId, request);
      yield* h.service.drain;
      const successor = ThreadId.make("current-owner");
      h.handoff(threadId, otherThreadId);
      h.handoff(otherThreadId, successor);
      h.setRequesterStatus("missing");
      yield* h.service.choose({ id: decision.id, optionId: "adopt" }, owner);
      yield* h.service.drain;
      const record = (yield* h.service.listForCaller(threadId))[0]!;
      assert.equal(record.deliveryThreadId, successor);
      assert.isNotNull(record.deliveredAt);
      const command = h.commands[0]!;
      assert.equal(command.type, "message.dispatch");
      if (command.type === "message.dispatch") assert.equal(command.threadId, successor);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("reconciliation accepts a digest-verified comment with the inbox source marker", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.service.request(threadId, request);
    h.loseComment();
    yield* h.service.drain;
    h.comments[0]!.body +=
      "\n\n<!-- t3-source project=science repository=github.com%2Facme%2Fscience thread=requester -->";
    const restarted = yield* h.start;
    yield* restarted.drain;
    assert.equal((yield* restarted.listForCaller(threadId))[0]!.state, "awaiting_choice");
    assert.lengthOf(h.comments, 1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "label cleanup respects another environment's open requests and verified withdrawals",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const foreign = (kind: "request" | "withdrawn", readable: string) =>
        `${readable}\n\n<!-- t3-decision-${kind}:v1 id=foreign digest=${NodeCrypto.createHash("sha256").update(readable).digest("hex")} -->`;
      h.comments.push({
        id: 1,
        body: foreign("request", "Another environment needs a decision."),
        html_url: "https://github.com/acme/repo/issues/46#issuecomment-1",
      });
      const decision = yield* h.service.request(threadId, request);
      yield* h.service.drain;
      yield* h.service.withdraw(threadId, { id: decision.id, reason: "Superseded" });
      h.loseComment();
      yield* h.service.drain;
      assert.isTrue(
        h.labels.has("decision-needed"),
        "a withdrawal must publish before label cleanup",
      );
      const restarted = yield* h.start;
      yield* restarted.drain;
      assert.isTrue(h.labels.has("decision-needed"));
      assert.include(h.comments[2]!.body, `t3-decision-withdrawn:v1 id=${decision.id} digest=`);
      const withdrawal = foreign("withdrawn", "Another environment withdrew its request.");
      h.comments.push({
        id: 4,
        body: withdrawal.replace("withdrew", "edited"),
        html_url: "https://github.com/acme/repo/issues/46#issuecomment-4",
      });
      yield* restarted.drain;
      assert.isTrue(
        h.labels.has("decision-needed"),
        "an altered withdrawal cannot close a foreign request",
      );
      h.comments[3]!.body = withdrawal;
      yield* restarted.drain;
      assert.isFalse(h.labels.has("decision-needed"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("the next reconcile repairs a label removed by another environment's stale cleanup", () =>
  Effect.gen(function* () {
    const github = fakeGithub();
    const contextA = yield* Layer.build(Layer.fresh(testLayer));
    const contextB = yield* Layer.build(Layer.fresh(testLayer));
    const a = yield* setup(undefined, github).pipe(Effect.provideContext(contextA));
    const b = yield* setup(undefined, github).pipe(Effect.provideContext(contextB));
    const previous = yield* b.service.request(threadId, request);
    yield* b.service.drain;
    yield* b.service.choose({ id: previous.id, optionId: "adopt" }, owner);

    const deleting = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    github.beforeLabelDelete = Effect.gen(function* () {
      yield* Deferred.succeed(deleting, undefined);
      yield* Deferred.await(resume);
    });
    const cleanup = yield* b.service.drain.pipe(Effect.forkChild);
    yield* Deferred.await(deleting);
    const current = yield* a.service.request(threadId, { ...request, clientRequestId: "new" });
    yield* a.service.drain;
    assert.isTrue(github.labels.has("decision-needed"));
    assert.isFalse((yield* a.service.listForCaller(threadId))[0]!.pendingLabel);
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(cleanup);
    assert.isFalse(github.labels.has("decision-needed"));
    assert.isFalse((yield* b.service.listForCaller(threadId))[0]!.pendingLabel);

    // Re-assertion is throttled: a tick within the interval leaves GitHub alone.
    yield* a.service.drain;
    assert.isFalse(github.labels.has("decision-needed"));
    yield* TestClock.adjust("5 minutes");
    yield* a.service.drain;
    assert.equal((yield* a.service.listForCaller(threadId))[0]!.id, current.id);
    assert.equal((yield* a.service.listForCaller(threadId))[0]!.state, "awaiting_choice");
    assert.isTrue(github.labels.has("decision-needed"));
  }).pipe(Effect.scoped),
);

it.effect("an incomplete comment page never permits label removal", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const decision = yield* h.service.request(threadId, request);
    yield* h.service.drain;
    yield* h.service.choose({ id: decision.id, optionId: "adopt" }, owner);
    yield* h.service.drain;
    h.labels.add("decision-needed");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE owner_decisions SET pending_label = 1 WHERE id = ${decision.id}`;
    h.comments.push({ id: 3, body: "Unseen comments", html_url: "https://github.com/acme/repo" });
    h.setPageSize(2);
    const before = h.pages();
    yield* h.service.drain;
    assert.equal(h.pages() - before, 1);
    assert.isTrue(h.labels.has("decision-needed"));
    h.setPageSize(100);
    yield* h.service.drain;
    assert.isFalse(h.labels.has("decision-needed"));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("label failures cannot prevent confirmed choice delivery", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const decision = yield* h.service.request(threadId, request);
    yield* h.service.drain;
    yield* h.service.choose({ id: decision.id, optionId: "defer" }, owner);
    h.setFailLabels(true);
    yield* h.service.drain;
    const record = (yield* h.service.listForCaller(threadId))[0]!;
    assert.isFalse(record.pendingDelivery);
    assert.isTrue(record.pendingLabel);
    h.setFailLabels(false);
    yield* h.service.drain;
    assert.isFalse(h.labels.has("decision-needed"));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("Ask mode off cannot answer owner decisions, which never enter runtime requests", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.service.request(threadId, request);
    yield* h.service.drain;
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const worker = yield* DontAskModeWorker.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ProjectionStore.layer,
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 0, storedEvents: [] };
              }),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getDontAskMode: Effect.succeed(true),
          }),
        ),
      ),
    );
    yield* worker.sweep;
    assert.lengthOf(dispatched, 0);
    const record = (yield* h.service.listForCaller(threadId))[0]!;
    assert.equal(record.state, "awaiting_choice");
    assert.isNull(record.chosenOptionId);
    const sql = yield* SqlClient.SqlClient;
    assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_projection_runtime_requests`, 0);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "a delivery committed before a crash replays its receipt without a second message after restart",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const instanceId = ProviderInstanceId.make("codex");
      const adapter = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("No provider may start in this test"),
      } as ProviderAdapter.ProviderAdapterV2["Service"];
      const runtimeLayer = ProviderReplayHarness.layerWithRegistry(
        { name: "owner-decision-delivery" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: Layer.succeed(SqlClient.SqlClient, sql), runEffectWorker: false },
      );
      const startRuntime = Effect.gen(function* () {
        const context = yield* Layer.build(Layer.fresh(runtimeLayer));
        return yield* Orchestrator.OrchestratorV2.pipe(Effect.provideContext(context));
      });
      let orchestrator = yield* startRuntime;
      for (const id of [threadId, otherThreadId])
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId: id,
          projectId: ProjectId.make("science"),
          title: "Requester",
          modelSelection: { instanceId, model: "gpt-6.1-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      let loseResponse = true;
      const h = yield* setup((command) =>
        Effect.gen(function* () {
          const result = yield* orchestrator.dispatch(command);
          if (loseResponse) {
            loseResponse = false;
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "Crash after command commit",
            });
          }
          return result;
        }),
      );
      const decision = yield* h.service.request(threadId, request);
      yield* h.service.drain;
      h.handoff(threadId, otherThreadId);
      yield* h.service.choose({ id: decision.id, optionId: "adopt" }, owner);
      yield* h.service.drain;
      assert.equal((yield* h.service.listForCaller(threadId))[0]!.deliveryThreadId, otherThreadId);
      assert.isTrue((yield* h.service.listForCaller(threadId))[0]!.pendingDelivery);
      const commandId = h.commands[0]!.commandId;
      const before =
        yield* sql`SELECT * FROM orchestration_events WHERE command_id = ${commandId} ORDER BY sequence`;
      assert.isAbove(before.length, 0, "delivery already committed real orchestration events");
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_command_receipts WHERE command_id = ${commandId}`,
        1,
      );
      orchestrator = yield* startRuntime;
      const restarted = yield* h.start;
      yield* restarted.drain;
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_events WHERE command_id = ${commandId} ORDER BY sequence`,
        before,
      );
      assert.equal(h.commands[1]!.commandId, commandId);
      assert.isFalse((yield* restarted.listForCaller(threadId))[0]!.pendingDelivery);
      const messages =
        yield* sql`SELECT * FROM orchestration_v2_projection_messages WHERE message_id = ${commandId}`;
      assert.lengthOf(messages, 1);
      assert.equal(messages[0]!.thread_id, otherThreadId);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(testLayer, NodeServices.layer))),
);
