import { assert, it } from "@effect/vitest";
import {
  IssueReadError,
  ThreadId,
  type IssueChangeOperation,
  type IssueChangeBaseline,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as IssueChangeService from "./IssueChangeService.ts";
import * as IssueService from "./IssueService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import { runMigrations } from "../persistence/Migrations.ts";

const threadId = ThreadId.make("root");
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const repository = { host: "github.com", repository: "acme/repo" };
const user = {
  kind: "user" as const,
  subject: "local-user",
  scopes: ["orchestration:operate" as const],
};
function issue(number: number): ThreadLinkedIssue {
  return {
    ...repository,
    repositoryId: "1",
    id: String(number),
    nodeId: `I_${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/repo/issues/${number}`,
  };
}

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  const rootJson = yield* encodeJson({ repositoryOrchestration: repository });
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES ('root', 'project', 'Root', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', ${rootJson})`;
  yield* sql`INSERT INTO orchestration_v2_projection_repository_orchestration(host, repository_id, repository, root_thread_id, project_id, workspace, launch_command_id, revision, paused, worker_limit, publish_status_comments, publish_closeout_comments, created_at, updated_at)
    VALUES ('github.com', '1', 'acme/repo', 'root', 'project', 'project', 'start', 1, 0, 4, 1, 1, '2026-01-01', '2026-01-01')`;
  const snapshots = new Map<number, IssueChangeBaseline>([
    [10, { issue: issue(10), body: "Original\n", state: "open", milestoneNumber: 1 }],
  ]);
  const parents = new Map<number, ThreadLinkedIssue>();
  const calls = { create: 0, body: 0, milestone: 0, state: 0, link: 0 };
  let failLink = false;
  let loseBodyResponse = false;
  let loseLinkResponse = false;
  const github = Layer.mock(IssueService.IssueService)({
    readChangeState: (input) => Effect.sync(() => snapshots.get(input.number)!),
    createIssue: (input) =>
      Effect.sync(() => {
        calls.create++;
        const created: IssueChangeBaseline = {
          issue: issue(20 + calls.create),
          body: input.body,
          state: "open",
          milestoneNumber: input.milestoneNumber,
        };
        snapshots.set(created.issue.number, created);
        return created;
      }),
    updateBody: (input) =>
      Effect.gen(function* () {
        calls.body++;
        snapshots.set(input.number, { ...snapshots.get(input.number)!, body: input.body });
        if (loseBodyResponse) {
          loseBodyResponse = false;
          return yield* new IssueReadError({
            code: "upstream",
            operation: "detail",
            message: "Body write response lost",
          });
        }
      }),
    setMilestone: (input) =>
      Effect.sync(() => {
        calls.milestone++;
        snapshots.set(input.number, {
          ...snapshots.get(input.number)!,
          milestoneNumber: input.milestoneNumber,
        });
      }),
    setState: (input) =>
      Effect.sync(() => {
        calls.state++;
        snapshots.set(input.number, { ...snapshots.get(input.number)!, state: input.state });
      }),
    workRead: (input) =>
      Effect.sync(() => ({
        issue: issue(input.number),
        state: "open" as const,
        milestoneNumber: 1,
        parent: parents.get(input.number) ?? null,
        subIssues: [],
        blockedBy: [],
        parentComplete: true,
        subIssuesComplete: true,
        blockersComplete: true,
      })),
    setSubIssue: (input) =>
      Effect.gen(function* () {
        calls.link++;
        if (failLink) {
          failLink = false;
          return yield* new IssueReadError({
            code: "upstream",
            operation: "detail",
            message: "Temporary link failure",
          });
        }
        if (input.action === "add") parents.set(input.child.number, input.parent);
        else parents.delete(input.child.number);
        if (loseLinkResponse) {
          loseLinkResponse = false;
          return yield* new IssueReadError({
            code: "upstream",
            operation: "detail",
            message: "Link response lost",
          });
        }
      }),
  });
  const dependencies = Layer.mergeAll(github, EffectOutbox.layer);
  const changes = IssueChangeService.layer.pipe(Layer.provide(dependencies));
  const executor = Layer.effect(
    EffectWorker.OrchestrationEffectExecutorV2,
    Effect.gen(function* () {
      const service = yield* IssueChangeService.IssueChangeService;
      return EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: (effect) =>
          effect.request.type === "issue.change.execute"
            ? service.execute(effect.request.changeId).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectWorker.OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              )
            : Effect.void,
      });
    }),
  ).pipe(Layer.provide(changes));
  const runtime = Layer.mergeAll(
    changes,
    EffectWorker.layer.pipe(Layer.provide(Layer.merge(EffectOutbox.layer, executor))),
  );
  return {
    runtime,
    changes,
    calls,
    snapshots,
    parents,
    failNextLink: () => {
      failLink = true;
    },
    loseNextBodyResponse: () => {
      loseBodyResponse = true;
    },
    loseNextLinkResponse: () => {
      loseLinkResponse = true;
    },
    singleAttemptRuntime: Layer.mergeAll(
      changes,
      EffectWorker.layerWithOptions({ maxAttempts: 1 }).pipe(
        Layer.provide(Layer.merge(EffectOutbox.layer, executor)),
      ),
    ),
  };
});

const inDatabase = <A, E>(
  test: (h: Effect.Success<typeof setup>) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const harness = yield* setup;
    return yield* test(harness);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
const propose = (operation: IssueChangeOperation, clientRequestId = "request") =>
  IssueChangeService.IssueChangeService.pipe(
    Effect.flatMap((service) =>
      service.propose(threadId, { ...repository, clientRequestId, operation }),
    ),
  );
const drain = EffectWorker.OrchestrationEffectWorkerV2.pipe(
  Effect.flatMap((worker) => worker.drain()),
);

it.effect("auto-approved create and milestone moves run once through the outbox", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const service = yield* IssueChangeService.IssueChangeService;
      const create = { type: "create" as const, title: "New", body: "Task", milestoneNumber: 1 };
      const accepted = yield* propose(create);
      assert.equal(accepted.decision, "auto_approved");
      assert.equal(h.calls.create, 0);
      assert.equal(yield* drain, 1);
      assert.equal((yield* propose(create)).id, accepted.id);
      yield* service.execute(accepted.id);
      yield* propose({ type: "milestone", number: 10, milestoneNumber: 2 }, "milestone");
      assert.equal(yield* drain, 1);
      assert.deepStrictEqual(h.calls, { create: 1, body: 0, milestone: 1, state: 0, link: 0 });
      const rows = yield* service.list({ threadId });
      assert.isTrue(rows.every((row) => row.status === "succeeded"));
    }).pipe(Effect.provide(h.runtime)),
  ),
);

it.effect("split resumes a failed link without recreating successful issues", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const service = yield* IssueChangeService.IssueChangeService;
      const change = yield* propose({
        type: "split",
        number: 10,
        issues: [
          { title: "First", body: "A", milestoneNumber: 1 },
          { title: "Second", body: "B", milestoneNumber: 1 },
        ],
      });
      h.failNextLink();
      assert.equal(yield* drain, 1);
      let saved = (yield* service.list({ threadId }))[0]!;
      assert.equal(saved.completedSteps["create:0"]?.issue?.number, 21);
      assert.equal(saved.status, "failed");
      yield* TestClock.adjust(100);
      assert.equal(yield* drain, 1);
      yield* service.execute(change.id);
      saved = (yield* service.list({ threadId }))[0]!;
      assert.equal(saved.status, "succeeded");
      assert.equal(h.calls.create, 2);
      assert.equal(h.parents.get(21)?.number, 10);
      assert.equal(h.parents.get(22)?.number, 10);
      assert.equal(Object.keys(saved.completedSteps).length, 4);
    }).pipe(Effect.provide(h.runtime)),
  ),
);

it.effect(
  "body and state changes wait for a user decision; agents and read-only users cannot approve",
  () =>
    inDatabase((h) =>
      Effect.gen(function* () {
        const service = yield* IssueChangeService.IssueChangeService;
        const body = yield* propose({ type: "body", number: 10, body: "Updated\n" });
        assert.include(body.diff!, "-Original");
        assert.include(body.diff!, "+Updated");
        yield* service.execute(body.id);
        assert.equal(yield* drain, 0);
        for (const actor of [
          { ...user, kind: "agent" as const },
          { ...user, scopes: [] },
        ]) {
          assert.isTrue(
            Result.isFailure(
              yield* Effect.result(service.decide({ id: body.id, decision: "approved" }, actor)),
            ),
          );
        }
        yield* service.decide({ id: body.id, decision: "approved" }, user);
        assert.equal(yield* drain, 1);
        assert.equal(h.calls.body, 1);
        const state = yield* propose({ type: "state", number: 10, state: "closed" }, "close");
        assert.equal(state.decision, "pending");
        yield* service.decide({ id: state.id, decision: "rejected" }, user);
        assert.equal(yield* drain, 0);
        assert.equal(h.calls.state, 0);
        assert.equal((yield* service.list({ threadId }))[0]?.status, "rejected");
        const authored = yield* propose({ type: "body", number: 10, body: "Next" }, "next");
        assert.isTrue(authored.t3AuthoredBody);
        assert.equal(authored.decision, "pending");
      }).pipe(Effect.provide(h.runtime)),
    ),
);

it.effect("stale body or state baselines conflict before any GitHub write", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const service = yield* IssueChangeService.IssueChangeService;
      const body = yield* propose({ type: "body", number: 10, body: "Changed" });
      yield* service.decide({ id: body.id, decision: "approved" }, user);
      h.snapshots.set(10, { ...h.snapshots.get(10)!, body: "Externally edited" });
      yield* drain;
      assert.equal((yield* service.list({ threadId }))[0]?.status, "conflict");
      assert.equal(h.calls.body, 0);
      const close = yield* propose({ type: "state", number: 10, state: "closed" }, "close");
      yield* service.decide({ id: close.id, decision: "approved" }, user);
      h.snapshots.set(10, { ...h.snapshots.get(10)!, state: "closed" });
      yield* drain;
      assert.equal((yield* service.list({ threadId }))[0]?.status, "conflict");
      assert.equal(h.calls.state, 0);
    }).pipe(Effect.provide(h.runtime)),
  ),
);

it.effect("approved proposals survive rebuilding the service and effect worker", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const saved = yield* Effect.gen(function* () {
        const service = yield* IssueChangeService.IssueChangeService;
        const change = yield* propose({ type: "state", number: 10, state: "closed" });
        yield* service.decide({ id: change.id, decision: "approved" }, user);
        return change.id;
      }).pipe(Effect.provide(h.changes));
      yield* Effect.gen(function* () {
        const service = yield* IssueChangeService.IssueChangeService;
        assert.equal((yield* service.list({ threadId }))[0]?.decision, "approved");
        assert.equal(yield* drain, 1);
        assert.equal((yield* service.list({ threadId }))[0]?.id, saved);
        assert.equal((yield* service.list({ threadId }))[0]?.status, "succeeded");
        assert.equal(h.calls.state, 1);
      }).pipe(Effect.provide(h.runtime));
    }),
  ),
);

it.effect("an unmanaged agent cannot propose and a retry cannot replace a proposal", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const service = yield* IssueChangeService.IssueChangeService;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            service.propose(ThreadId.make("unmanaged"), {
              ...repository,
              clientRequestId: "a",
              operation: { type: "state", number: 10, state: "closed" },
            }),
          ),
        ),
      );
      yield* propose({ type: "body", number: 10, body: "One" });
      assert.isTrue(
        Result.isFailure(yield* Effect.result(propose({ type: "body", number: 10, body: "Two" }))),
      );
      assert.equal((yield* service.list({ threadId })).length, 1);
      assert.equal(
        (yield* service.list({ host: "GITHUB.COM", repository: "Acme/Repo", number: 10 })).length,
        1,
      );
      const spoofed = {
        ...repository,
        clientRequestId: "spoofed",
        operation: { type: "body" as const, number: 10, body: "Agent supplied approval" },
        decision: "approved",
        decidedBy: "user",
        policy: "allow",
      };
      assert.equal((yield* service.propose(threadId, spoofed)).decision, "pending");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads SET default_provider = 'cursor' WHERE thread_id = 'root'`;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            propose({ type: "body", number: 10, body: "Unsupported provider" }, "unsupported"),
          ),
        ),
      );
    }).pipe(Effect.provide(h.runtime)),
  ),
);

it.effect(
  "pending approvals and body baselines survive event compaction and projection rebuild",
  () =>
    inDatabase((h) =>
      Effect.gen(function* () {
        const service = yield* IssueChangeService.IssueChangeService;
        const pending = yield* propose({ type: "body", number: 10, body: "Exact proposal" });
        const maintenance = ProjectionMaintenance.layer.pipe(
          Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        );
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          yield* projections.compactEventStore;
          yield* projections.rebuild;
        }).pipe(Effect.provide(maintenance));
        const saved = (yield* service.list({ threadId }))[0]!;
        assert.equal(saved.id, pending.id);
        assert.equal(saved.decision, "pending");
        assert.equal(saved.diff, pending.diff);
        yield* service.decide({ id: saved.id, decision: "approved" }, user);
        yield* drain;
        const sql = yield* SqlClient.SqlClient;
        const baseline = yield* sql<{
          body: string;
        }>`SELECT body FROM issue_body_baselines WHERE issue_id = '10'`;
        assert.equal(baseline[0]?.body, "Exact proposal");
      }).pipe(Effect.provide(h.runtime)),
    ),
);

it.effect("a user can retry an exhausted split using only unrecorded steps", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const service = yield* IssueChangeService.IssueChangeService;
      const change = yield* propose({
        type: "split",
        number: 10,
        issues: [{ title: "First", body: "A", milestoneNumber: 1 }],
      });
      h.loseNextLinkResponse();
      assert.equal(yield* drain, 1);
      assert.equal((yield* service.list({ threadId }))[0]?.status, "failed");
      yield* service.decide({ id: change.id, decision: "retry" }, user);
      assert.equal(yield* drain, 1);
      assert.equal((yield* service.list({ threadId }))[0]?.status, "succeeded");
      assert.equal(h.calls.create, 1);
      assert.equal(h.calls.link, 1);
    }).pipe(Effect.provide(h.singleAttemptRuntime)),
  ),
);

it.effect(
  "an accepted body write with a lost response recovers its receipt without another write",
  () =>
    inDatabase((h) =>
      Effect.gen(function* () {
        const service = yield* IssueChangeService.IssueChangeService;
        const change = yield* propose({ type: "body", number: 10, body: "Replacement" });
        yield* service.decide({ id: change.id, decision: "approved" }, user);
        h.loseNextBodyResponse();
        assert.equal(yield* drain, 1);
        assert.equal((yield* service.list({ threadId }))[0]?.status, "failed");
        yield* TestClock.adjust(100);
        assert.equal(yield* drain, 1);
        assert.equal((yield* service.list({ threadId }))[0]?.status, "succeeded");
        assert.equal(h.calls.body, 1);
        const next = yield* propose({ type: "body", number: 10, body: "Next" }, "next");
        assert.isTrue(next.t3AuthoredBody);
      }).pipe(Effect.provide(h.runtime)),
    ),
);
