import * as ProjectionReplay from "../orchestration-v2/testkit/ProjectionReplay.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  IssueOperationError,
  IssueReadError,
  IssueTrackerKind,
  DEFAULT_SERVER_SETTINGS,
  ISSUE_HOSTS,
  ProjectId,
  ThreadId,
  type IssueChangeOperation,
  type IssueChangeBaseline,
  type IssueState,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as IssueChangeService from "./IssueChangeService.ts";
import * as IssueService from "./IssueService.ts";
import * as TrackerIssueService from "../issue/IssueService.ts";
import * as ServerSettings from "../serverSettings.ts";
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

const legacyStates = [
  { category: "open", name: "Open" },
  { category: "closed", name: "Completed", closeReason: "completed" },
] as const satisfies ReadonlyArray<IssueState>;

const setup = Effect.fnUntraced(function* (states: ReadonlyArray<IssueState>) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  const rootJson = yield* encodeJson({ repositoryOrchestration: repository });
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES ('root', 'project', 'Root', 'codex', 'approval-required', 'default', '2026-01-01', '2026-01-01', ${rootJson})`;
  yield* sql`INSERT INTO orchestration_v2_projection_repository_orchestration(host, repository_id, repository, root_thread_id, project_id, workspace, launch_command_id, revision, paused, worker_limit, publish_status_comments, publish_closeout_comments, created_at, updated_at)
    VALUES ('github.com', '1', 'acme/repo', 'root', 'project', 'project', 'start', 1, 0, 4, 1, 1, '2026-01-01', '2026-01-01')`;
  const snapshots = new Map<number, IssueChangeBaseline>([
    [10, { issue: issue(10), body: "Original\n", state: "open", milestoneNumber: 1 }],
  ]);
  const stateWrites: string[] = [];
  const stateReasons = new Map<number, string>();
  const parents = new Map<number, ThreadLinkedIssue>();
  const blockers = new Map<number, ThreadLinkedIssue>();
  const calls = { create: 0, body: 0, milestone: 0, state: 0, link: 0 };
  let requireApproval = false;
  let holdFailure = false;
  const failurePublished = yield* Deferred.make<void>();
  const allowFailureSettlement = yield* Deferred.make<void>();
  const comments: string[] = [];
  const commentCompleted = yield* Deferred.make<void>();
  let failCreate: "rate-limited" | "rejected" | "uncertain" | undefined;
  let reportIdentity = false;
  let failLink = false;
  let loseBodyResponse = false;
  let loseBlockerResponse = false;
  let blockersComplete = true;
  let loseLinkResponse = false;
  let capabilities = ISSUE_HOSTS.github!.capabilities;
  const lostResponse = (detail: string) => new IssueOperationError({ operation: "write", detail });
  // Upstream's service files, edits and closes; the fork's GitHub extension does the rest.
  const tracker = Layer.mock(TrackerIssueService.IssueService)({
    resolveUrl: (url) =>
      Effect.succeed({
        projectId: ProjectId.make("project"),
        tracker: IssueTrackerKind.make("github"),
        host: repository.host,
        scope: repository.repository,
        key: url.split("/").at(-1)!,
        writable: true,
      }),
    create: (input) =>
      Effect.gen(function* () {
        const outcome = failCreate;
        failCreate = undefined;
        calls.create++;
        if (outcome === "rate-limited" || outcome === "rejected")
          return yield* new IssueOperationError({
            operation: "create",
            reason: outcome,
            detail: "GitHub refused the create request.",
          });
        if (outcome !== undefined) return yield* lostResponse("Create outcome");
        const created = issue(20 + calls.create);
        snapshots.set(created.number, {
          issue: created,
          body: input.body,
          state: "open",
          milestoneNumber: input.milestoneNumber ?? null,
        });
        if (reportIdentity) {
          reportIdentity = false;
          return yield* lostResponse("Create response lost");
        }
        return {
          key: String(created.number),
          displayKey: `#${created.number}`,
          url: created.url,
          githubIdentity: { id: created.id, nodeId: created.nodeId },
        };
      }),
    update: (input) =>
      Effect.gen(function* () {
        calls.body++;
        const number = Number(input.key);
        snapshots.set(number, { ...snapshots.get(number)!, body: input.body! });
        if (loseBodyResponse) {
          loseBodyResponse = false;
          return yield* lostResponse("Body write response lost");
        }
      }),
    detail: (input) =>
      Effect.sync(() => {
        const snapshot = snapshots.get(Number(input.key))!;
        return {
          ...input,
          host: repository.host,
          projectTitle: "Project",
          displayKey: `#${input.key}`,
          title: snapshot.issue.title,
          url: snapshot.issue.url,
          author: null,
          state: states.find((state) => state.category === snapshot.state)!,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          closedAt: null,
          assignees: [],
          labels: [],
          commentCount: 0,
          writable: true,
          capabilities: {
            create: true,
            edit: true,
            comment: true,
            labels: true,
            assignees: true,
            reactions: true,
            templates: true,
            linkedPullRequests: true,
            events: true,
            search: true,
          },
          viewerPermissions: {
            setState: true,
            comment: true,
            edit: true,
            labels: true,
            assignees: true,
          },
          states,
          viewer: null,
          body: snapshot.body,
          comments: [],
          commentsCursor: null,
          events: [],
          linkedPullRequests: [],
        };
      }),
    setState: (input) =>
      Effect.gen(function* () {
        const state = states.find((candidate) => candidate.name === input.state);
        if (state === undefined)
          return yield* new IssueOperationError({
            operation: "setState",
            detail: `This repository has no "${input.state}" issue status.`,
          });
        stateWrites.push(input.state);
        calls.state++;
        const number = Number(input.key);
        if (state.closeReason === undefined) stateReasons.delete(number);
        else stateReasons.set(number, state.closeReason);
        snapshots.set(number, { ...snapshots.get(number)!, state: state.category });
      }),
  });
  let refreshes = 0;
  const github = Layer.mock(IssueService.IssueService)({
    withRepositoryCredential: (_input, use) => use,
    repositoryIdentity: () => Effect.succeed({ ...repository, repositoryId: "1" }),
    markChanged: () =>
      Effect.sync(() => {
        refreshes++;
      }),
    capabilities: () => Effect.sync(() => capabilities),
    readChangeState: (input) => Effect.sync(() => snapshots.get(input.number)!),
    findCreatedIssue: (input) =>
      Effect.sync(
        () => [...snapshots.values()].find((issue) => issue.body.includes(input.marker)) ?? null,
      ),
    setMilestone: (input) =>
      Effect.sync(() => {
        calls.milestone++;
        snapshots.set(input.number, {
          ...snapshots.get(input.number)!,
          milestoneNumber: input.milestoneNumber,
        });
      }),
    workRead: (input) =>
      Effect.sync(() => ({
        issue: issue(input.number),
        state: "open" as const,
        milestoneNumber: 1,
        parent: parents.get(input.number) ?? null,
        subIssues: [],
        blockedBy: blockers.has(input.number)
          ? [{ issue: blockers.get(input.number)!, state: "open" as const }]
          : [],
        parentComplete: true,
        subIssuesComplete: true,
        blockersComplete,
      })),
    setBlockedBy: (input) =>
      Effect.gen(function* () {
        if (input.action === "add") blockers.set(input.issue.number, input.blocker);
        else blockers.delete(input.issue.number);
        if (loseBlockerResponse) {
          loseBlockerResponse = false;
          return yield* new IssueReadError({
            code: "upstream",
            operation: "detail",
            message: "Lost blocker response",
          });
        }
      }),
    setParent: (input) =>
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
  const settings = Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.sync(() => ({
      ...DEFAULT_SERVER_SETTINGS,
      issueUpkeepRequiresApproval: requireApproval,
    })),
  });
  const dependencies = Layer.mergeAll(github, tracker, settings, EffectOutbox.layer);
  const changes = IssueChangeService.layer.pipe(Layer.provideMerge(dependencies));
  const executor = Layer.effect(
    EffectWorker.OrchestrationEffectExecutorV2,
    Effect.gen(function* () {
      const service = yield* IssueChangeService.IssueChangeService;
      return EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: (effect) =>
          effect.request.type === "issue.change.execute"
            ? service.execute(effect.request.changeId).pipe(
                Effect.tapError(() =>
                  holdFailure
                    ? Deferred.succeed(failurePublished, undefined).pipe(
                        Effect.andThen(Deferred.await(allowFailureSettlement)),
                      )
                    : Effect.void,
                ),
                Effect.mapError(
                  (cause) =>
                    new EffectWorker.OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              )
            : Effect.sync(() => {
                comments.push(effect.id);
              }).pipe(Effect.andThen(Deferred.succeed(commentCompleted, undefined))),
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
    stateWrites,
    stateReasons,
    refreshes: () => refreshes,
    setCapabilities: (value: typeof capabilities) => {
      capabilities = value;
    },
    setBlockersComplete: (value: boolean) => {
      blockersComplete = value;
    },
    loseNextBlockerResponse: () => {
      loseBlockerResponse = true;
    },
    parents,
    blockers,
    comments,
    commentCompleted,
    failurePublished,
    allowFailureSettlement,
    holdFailureSettlement: () => {
      holdFailure = true;
    },
    requireApproval: (value: boolean) => {
      requireApproval = value;
    },
    failNextCreate: (outcome: "rate-limited" | "rejected" | "uncertain") => {
      failCreate = outcome;
    },
    loseCreateFields: () => {
      reportIdentity = true;
    },
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
  test: (
    h: Effect.Success<ReturnType<typeof setup>>,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
  states: ReadonlyArray<IssueState> = legacyStates,
) =>
  Effect.gen(function* () {
    const harness = yield* setup(states);
    return yield* test(harness);
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
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
      assert.equal(h.snapshots.get(21)?.milestoneNumber, 1);
      assert.deepStrictEqual(h.calls, { create: 1, body: 0, milestone: 1, state: 0, link: 0 });
      const rows = yield* service.list({ threadId });
      assert.isTrue(rows.every((row) => row.status === "succeeded"));
    }).pipe(Effect.provide(h.runtime)),
  ),
);

it.effect("full-access and auto threads edit and close issues without waiting for approval", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads SET runtime_mode = 'full-access' WHERE thread_id = 'root'`;
      const body = yield* propose({ type: "body", number: 10, body: "Updated\n" });
      assert.equal(body.decision, "auto_approved");
      assert.equal(yield* drain, 1);
      assert.equal(h.calls.body, 1);
      yield* sql`UPDATE orchestration_v2_projection_threads SET runtime_mode = 'auto' WHERE thread_id = 'root'`;
      const close = yield* propose({ type: "state", number: 10, state: "closed" }, "close");
      assert.equal(close.decision, "auto_approved");
      assert.equal(yield* drain, 1);
      assert.equal(h.snapshots.get(10)?.state, "closed");

      h.stateReasons.set(10, "not_planned");
      yield* propose({ type: "state", number: 10, state: "closed" }, "already-closed");
      assert.equal(yield* drain, 1);
      assert.deepEqual(h.stateWrites, ["Completed"]);
      assert.equal(h.stateReasons.get(10), "not_planned");

      yield* propose({ type: "state", number: 10, state: "open" }, "reopen");
      assert.equal(yield* drain, 1);
      assert.equal(h.snapshots.get(10)?.state, "open");
      assert.deepEqual(h.stateWrites, ["Completed", "Open"]);
    }).pipe(Effect.provide(h.runtime)),
  ),
);

it.effect("closes and reopens issues with repository-defined status names", () =>
  inDatabase(
    (h) =>
      Effect.gen(function* () {
        const service = yield* IssueChangeService.IssueChangeService;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_threads SET runtime_mode = 'auto' WHERE thread_id = 'root'`;
        const close = yield* propose({ type: "state", number: 10, state: "closed" }, "close");
        assert.equal(yield* drain, 1);
        const closed = (yield* service.list({ threadId })).find(
          (change) => change.id === close.id,
        )!;
        assert.equal(closed.status, "succeeded", closed.result ?? undefined);
        assert.equal(h.snapshots.get(10)?.state, "closed");
        assert.equal(h.stateReasons.get(10), "completed");

        const reopen = yield* propose({ type: "state", number: 10, state: "open" }, "reopen");
        assert.equal(yield* drain, 1);
        const reopened = (yield* service.list({ threadId })).find(
          (change) => change.id === reopen.id,
        )!;
        assert.equal(reopened.status, "succeeded", reopened.result ?? undefined);
        assert.equal(h.snapshots.get(10)?.state, "open");
        assert.deepEqual(h.stateWrites, ["Done", "Backlog"]);
      }).pipe(Effect.provide(h.runtime)),
    [
      { category: "open", name: "Backlog" },
      { category: "open", name: "In review" },
      { category: "closed", name: "Not planned", closeReason: "not-planned" },
      { category: "closed", name: "Done", closeReason: "completed" },
    ],
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
      const invalidProposal = yield* Effect.flip(
        service.propose(threadId, {
          ...repository,
          clientRequestId: "missing-body",
          operation: { type: "body", number: 10 },
        } as Parameters<typeof service.propose>[1]),
      );
      assert.include(invalidProposal.message, "body");
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
      const insertThread = (id: string, parentThreadId: string | null, claim = false) =>
        Effect.gen(function* () {
          const json = yield* encodeJson({
            lineage: { parentThreadId },
            ...(claim ? { linkedIssue: issue(10) } : {}),
          });
          yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
            VALUES (${id}, 'project', ${id}, 'codex', 'approval-required', 'default', '2026-01-01', '2026-01-01', ${json})`;
        });
      yield* insertThread("child", "root");
      yield* insertThread("grandchild", "child");
      yield* insertThread("worker", null, true);
      yield* insertThread("worker-child", "worker");
      yield* insertThread("stranger", null);
      yield* insertThread("stranger-child", "stranger");
      // Hiding create_issue and set_issue_state follows every descendant of a managed thread.
      assert.deepEqual(
        yield* Effect.forEach(
          ["root", "child", "grandchild", "worker", "worker-child", "stranger", "stranger-child"],
          (id) => service.isManagedCaller(ThreadId.make(id)),
        ),
        [true, true, true, true, true, false, false],
      );
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
        const maintenance = Layer.merge(ProjectionMaintenance.layer, ProjectionReplay.layer).pipe(
          Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        );
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          yield* projections.pruneEventStore();
          yield* (yield* ProjectionReplay.ProjectionReplay).rebuild;
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

it.effect(
  "retry during failure settlement preserves the failed change until its effect can requeue",
  () =>
    inDatabase((h) =>
      Effect.gen(function* () {
        const service = yield* IssueChangeService.IssueChangeService;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const change = yield* propose({
          type: "split",
          number: 10,
          issues: [{ title: "Child", body: "Task", milestoneNumber: 1 }],
        });
        h.failNextLink();
        h.holdFailureSettlement();
        const running = yield* worker.runOnceInLane("issue-change").pipe(Effect.forkScoped);
        yield* Deferred.await(h.failurePublished);
        const premature = yield* service.decide({ id: change.id, decision: "retry" }, user);
        assert.equal(premature.status, "failed");
        const sql = yield* SqlClient.SqlClient;
        const effects = yield* sql<{
          status: string;
        }>`SELECT status FROM orchestration_v2_effect_outbox WHERE effect_id = ${`effect:issue-change:${change.id}`}`;
        assert.equal(effects[0]?.status, "running");
        yield* Deferred.succeed(h.allowFailureSettlement, undefined);
        assert.isTrue(yield* Fiber.join(running));
        assert.equal(
          (yield* service.decide({ id: change.id, decision: "retry" }, user)).status,
          "queued",
        );
        assert.isTrue(yield* worker.runOnceInLane("issue-change"));
        assert.equal((yield* service.list({ threadId }))[0]?.status, "succeeded");
        assert.equal(h.calls.create, 1);
      }).pipe(Effect.provide(h.singleAttemptRuntime)),
    ),
);

it.effect("stalled changes and change backoff leave the comment lane available", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* propose({
        type: "split",
        number: 10,
        issues: [{ title: "Child", body: "Task", milestoneNumber: 1 }],
      });
      h.failNextLink();
      h.holdFailureSettlement();
      const running = yield* worker.runOnceInLane("issue-change").pipe(Effect.forkScoped);
      yield* Deferred.await(h.failurePublished);
      const enqueueComment = (id: string) =>
        outbox.enqueue([
          {
            id,
            commandId: CommandId.make(id),
            threadId,
            request: { type: "issue.status.refresh", issue: issue(10), revision: 2 },
          },
        ]);
      yield* enqueueComment("comment-while-running");
      assert.isTrue(yield* worker.runOnceInLane("issue-comment"));
      yield* Deferred.succeed(h.allowFailureSettlement, undefined);
      yield* Fiber.join(running);
      yield* enqueueComment("comment-during-backoff");
      assert.equal(yield* drain, 1);
      assert.deepEqual(h.comments, ["comment-while-running", "comment-during-backoff"]);
    }).pipe(Effect.provide(h.runtime)),
  ),
);

it.effect("uncertain split creation needs user attention and cannot create another child", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const service = yield* IssueChangeService.IssueChangeService;
      const change = yield* propose({
        type: "split",
        number: 10,
        issues: [{ title: "Child", body: "Task", milestoneNumber: 1 }],
      });
      h.failNextCreate("uncertain");
      assert.equal(yield* drain, 1);
      yield* TestClock.adjust(100);
      assert.equal(yield* drain, 1);
      assert.equal((yield* service.list({ threadId }))[0]?.status, "needs_attention");
      assert.equal(h.calls.create, 1);
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(service.decide({ id: change.id, decision: "retry" }, user)),
        ),
      );
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            service.decide({ id: change.id, decision: "resolved" }, { ...user, kind: "agent" }),
          ),
        ),
      );
      assert.equal(
        (yield* service.decide({ id: change.id, decision: "resolved" }, user)).status,
        "resolved",
      );
      yield* TestClock.adjust(200);
      yield* drain;
      yield* service.execute(change.id);
      assert.equal(h.calls.create, 1);
      assert.equal(h.calls.link, 0);
    }).pipe(Effect.provide(h.runtime)),
  ),
);

it.effect(
  "a rate-limited create retries, and a create whose response was lost is found by its marker",
  () =>
    inDatabase((h) =>
      Effect.gen(function* () {
        const service = yield* IssueChangeService.IssueChangeService;
        for (const refusal of ["rate-limited", "rejected"] as const) {
          h.failNextCreate(refusal);
          yield* propose(
            { type: "create", title: "Task", body: "Task", milestoneNumber: null },
            refusal,
          );
          yield* drain;
          yield* TestClock.adjust(100);
          yield* drain;
          assert.equal((yield* service.list({ threadId }))[0]?.status, "succeeded");
        }
        assert.equal(h.calls.create, 4);
        h.loseCreateFields();
        yield* propose(
          {
            type: "create",
            title: "Lost response",
            body: "Task",
            milestoneNumber: null,
          },
          "receipt",
        );
        yield* drain;
        assert.equal((yield* service.list({ threadId }))[0]?.status, "failed");
        h.snapshots.set(25, { ...h.snapshots.get(25)!, milestoneNumber: 7 });
        yield* TestClock.adjust(100);
        yield* drain;
        const saved = (yield* service.list({ threadId }))[0]!;
        assert.equal(saved.status, "succeeded");
        assert.equal(saved.completedSteps["create:0"]?.issue?.number, 25);
        assert.equal(h.calls.create, 5);
        assert.equal(h.snapshots.get(25)?.milestoneNumber, 7);
        assert.equal(h.calls.milestone, 0);
        assert.equal(h.refreshes(), 1);
      }).pipe(Effect.provide(h.runtime)),
    ),
);

it.effect(
  "environment approval policy is fixed per proposal and never relaxes body or state approval",
  () =>
    inDatabase((h) =>
      Effect.gen(function* () {
        const service = yield* IssueChangeService.IssueChangeService;
        const create = {
          type: "create" as const,
          title: "Task",
          body: "Task",
          milestoneNumber: null,
        };
        const automatic = yield* propose(create, "automatic");
        h.requireApproval(true);
        const spoofedPolicy = {
          ...repository,
          clientRequestId: "spoof-policy",
          operation: create,
          issueUpkeepRequiresApproval: false,
          decision: "auto_approved",
        };
        assert.equal((yield* service.propose(threadId, spoofedPolicy)).decision, "pending");
        assert.equal((yield* propose(create, "automatic")).decision, "auto_approved");
        const operations: IssueChangeOperation[] = [
          create,
          { type: "split", number: 10, issues: [create] },
          { type: "milestone", number: 10, milestoneNumber: 2 },
          { type: "blocked_by", number: 10, blockerNumber: 11, action: "add" },
          { type: "body", number: 10, body: "Edit" },
          { type: "state", number: 10, state: "closed" },
          { type: "state", number: 10, state: "open" },
        ];
        const pending = [];
        for (let index = 0; index < operations.length; index++) {
          const change = yield* propose(operations[index]!, `policy-${index}`);
          assert.equal(change.decision, "pending");
          pending.push(change);
        }
        h.requireApproval(false);
        for (let index = 0; index < operations.length; index++)
          assert.equal((yield* propose(operations[index]!, `policy-${index}`)).decision, "pending");
        assert.equal(yield* drain, 1);
        assert.equal(h.calls.create, 1);
        assert.equal(
          (yield* service.list({ threadId })).find((c) => c.id === automatic.id)?.status,
          "succeeded",
        );
        yield* service.decide({ id: pending[0]!.id, decision: "approved" }, user);
        assert.equal(yield* drain, 1);
        assert.equal(h.calls.create, 2);
      }).pipe(Effect.provide(h.runtime)),
    ),
);

it.effect("the daemon gives upkeep and comments separate worker slots", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* propose({
        type: "split",
        number: 10,
        issues: [{ title: "Child", body: "Task", milestoneNumber: 1 }],
      });
      h.failNextLink();
      h.holdFailureSettlement();
      yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
      yield* Deferred.await(h.failurePublished);
      yield* outbox.enqueue([
        {
          id: "daemon-comment",
          commandId: CommandId.make("daemon-comment"),
          threadId,
          request: { type: "issue.status.refresh", issue: issue(10), revision: 2 },
        },
      ]);
      yield* outbox.notifyAvailable();
      yield* Deferred.await(h.commentCompleted);
      assert.deepEqual(h.comments, ["daemon-comment"]);
      yield* Deferred.succeed(h.allowFailureSettlement, undefined);
    }).pipe(Effect.provide(h.runtime)),
  ),
);

it.effect("creates a blocker and adds and removes its dependency through durable proposals", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads SET runtime_mode = 'full-access' WHERE thread_id = ${threadId}`;
      const created = yield* propose(
        {
          type: "create",
          title: "Outside blocker",
          body: "Required dependency",
          milestoneNumber: null,
        },
        "blocker",
      );
      yield* drain;
      const service = yield* IssueChangeService.IssueChangeService;
      const blocker = (yield* service.list({ threadId })).find((c) => c.id === created.id)!
        .completedSteps["create:0"]!.issue!;
      for (const action of ["add", "remove"] as const) {
        const operation = {
          type: "blocked_by" as const,
          number: 10,
          blockerNumber: blocker.number,
          action,
        };
        const change = yield* propose(operation, action);
        assert.equal(change.decision, "auto_approved");
        if (action === "add") {
          h.loseNextBlockerResponse();
          assert.isTrue(Result.isFailure(yield* Effect.result(service.execute(change.id))));
        }
        yield* service.execute(change.id);
        assert.equal(h.blockers.has(10), action === "add");
        assert.equal((yield* propose(operation, action)).status, "succeeded");
      }
    }).pipe(Effect.provide(h.runtime)),
  ),
);

it.effect("rejects unverifiable blockers and detects changed relationships before writing", () =>
  inDatabase((h) =>
    Effect.gen(function* () {
      const service = yield* IssueChangeService.IssueChangeService;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            propose({ type: "blocked_by", number: 10, blockerNumber: 10, action: "add" }),
          ),
        ),
      );
      h.setCapabilities({ ...ISSUE_HOSTS.github!.capabilities, blockers: false });
      const refused = yield* Effect.flip(
        propose({ type: "blocked_by", number: 10, blockerNumber: 11, action: "add" }, "no-host"),
      );
      assert.equal(refused.code, "invalid-request");
      assert.include(refused.message, "does not support blockers");
      assert.isEmpty(yield* service.list({ threadId }));
      h.setCapabilities(ISSUE_HOSTS.github!.capabilities);
      h.setBlockersComplete(false);
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            propose({ type: "blocked_by", number: 10, blockerNumber: 11, action: "add" }),
          ),
        ),
      );
      h.setBlockersComplete(true);
      const change = yield* propose({
        type: "blocked_by",
        number: 10,
        blockerNumber: 11,
        action: "add",
      });
      yield* service.decide({ id: change.id, decision: "approved" }, user);
      h.blockers.set(10, issue(11));
      yield* drain;
      assert.equal((yield* propose(change.operation)).status, "conflict");
    }).pipe(Effect.provide(h.runtime)),
  ),
);
