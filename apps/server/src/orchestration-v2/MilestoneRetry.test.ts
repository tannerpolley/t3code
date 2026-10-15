import { assert, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";

import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  createReviewRoot,
  modelSelection,
  projectId,
  reviewHarness,
  reviewIssue,
  reviewRead,
} from "./ThreadLaunchService.testHarness.ts";

function milestoneReads(statuses: ReadonlyMap<number, number>, calls: number[]) {
  return IssueService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitHubApi.GitHubApi)({
          rest: (input) => {
            const number = Number(
              new URL(input.path, "https://github.com").searchParams.get("milestone"),
            );
            calls.push(number);
            const status = statuses.get(number) ?? 200;
            return status === 200
              ? Effect.succeed({
                  status,
                  headers: {},
                  body: "[]",
                  truncated: false,
                  invalidUtf8: false,
                })
              : Effect.fail(
                  new GitHubApi.GitHubApiResponseError({
                    host: input.host,
                    operation: input.operation,
                    status,
                  }),
                );
          },
        }),
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          withVerifiedCredential: (_input, use) =>
            use({ accountId: "test", viewer: "test", credentialFingerprint: "test" }),
        }),
      ),
    ),
  );
}

it.effect(
  "reconciliation drops missing plans and retains unreadable and existing milestones",
  () => {
    const calls: number[] = [];
    const harness = reviewHarness(() => Effect.succeed(reviewRead(reviewIssue(1))));
    const dependencies = Layer.mergeAll(
      harness.dependencies,
      milestoneReads(
        new Map([
          [1, 422],
          [2, 422],
          [3, 500],
        ]),
        calls,
      ),
      CommandReceiptStore.layer.pipe(Layer.provide(harness.dependencies)),
    );
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const rootId = yield* createReviewRoot();
      const config = (yield* store.configuration(rootId))!;
      yield* threads.dispatch({
        type: "repository.work.update",
        threadId: rootId,
        commandId: CommandId.make("seed-milestone-plans"),
        expectedRevision: config.revision,
        orchestration: {
          ...config,
          milestones: [1, 2, 3, 4].map((number) => ({ ...config.milestones[0]!, number })),
        },
      });
      const revision = (yield* store.configuration(rootId))!.revision;
      yield* service.reconcile(rootId);
      const remaining = (yield* store.configuration(rootId))!.milestones;
      assert.deepEqual(
        remaining.map((plan) => [plan.number, plan.status]),
        [
          [3, "unreadable"],
          [4, "complete"],
        ],
      );
      for (const [number, offset] of [
        [1, 0],
        [2, 1],
      ])
        assert.equal(
          Option.getOrThrow(
            yield* receipts.getByCommandId(
              CommandId.make(`milestone-drop:${rootId}:${revision + offset!}:${number}`),
            ),
          ).status,
          "accepted",
        );
      assert.deepEqual(calls, [1, 2, 3, 4]);
      yield* service.reconcile(rootId);
      assert.deepEqual(calls, [1, 2, 3, 4, 3, 4]);
    }).pipe(Effect.provide(IssueWorkService.layer.pipe(Layer.provideMerge(dependencies))));
  },
);

it.effect(
  "workMilestone rejects missing milestones and retains unreadable plans without duplicates",
  () => {
    const harness = reviewHarness(() => Effect.succeed(reviewRead(reviewIssue(1))));
    const statuses = new Map([[23, 422]]);
    const dependencies = Layer.mergeAll(harness.dependencies, milestoneReads(statuses, []));
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const rootId = yield* createReviewRoot();
      const before = yield* store.configuration(rootId);
      const input = {
        host: "github.com",
        repository: "tannerpolley/t3code",
        projectId,
        milestoneNumber: 23,
        modelRoleId: "worker",
        clientRequestId: CommandId.make("missing-milestone"),
      };
      const result = yield* service.workMilestone(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, "invalid-request");
        assert.equal(
          result.failure.message,
          "Milestone #23 does not exist in tannerpolley/t3code.",
        );
      }
      assert.deepEqual(yield* store.configuration(rootId), before);
      statuses.set(23, 500);
      yield* service.workMilestone(input);
      yield* service.workMilestone({
        ...input,
        clientRequestId: CommandId.make("repeat-milestone"),
      });
      const plans = (yield* store.configuration(rootId))!.milestones.filter(
        (plan) => plan.number === 23,
      );
      assert.lengthOf(plans, 1);
      assert.equal(plans[0]!.status, "unreadable");
    }).pipe(Effect.provide(IssueWorkService.layer.pipe(Layer.provideMerge(dependencies))));
  },
);

it.effect(
  "milestone reconciliation starts an eligible issue after rejected attempts and reuses its accepted attempt",
  () => {
    const issue = reviewIssue(1);
    let eligible = false;
    const workRead = () =>
      Effect.succeed({
        ...reviewRead(issue),
        blockedBy: eligible ? [] : [{ issue: reviewIssue(99), state: "open" as const }],
      });
    const harness = reviewHarness(workRead);
    const reads = Layer.mock(IssueService.IssueService)({
      workRead,
      milestoneIssues: () =>
        Effect.succeed({
          complete: true,
          issues: [
            {
              number: issue.number,
              title: issue.title,
              url: issue.url,
              state: "open",
              stateReason: null,
              author: null,
              assignees: [],
              labels: [],
              milestone: {
                number: 1,
                title: "Milestone 1",
                state: "open",
                dueAt: null,
                url: "https://github.com/tannerpolley/t3code/milestone/1",
                openCount: 1,
                closedCount: 0,
              },
              createdAt: "2026-10-05T00:00:00Z",
              updatedAt: "2026-10-05T00:00:00Z",
              commentCount: 0,
            },
          ],
        }),
      detail: () =>
        Effect.succeed({
          repository: issue,
          viewer: null,
          fetchedAt: "2026-10-05T00:00:00Z",
          body: "Implement the issue",
          comments: [],
          linkedPullRequests: [],
          issue: {
            number: 1,
            title: issue.title,
            url: issue.url,
            state: "open",
            stateReason: null,
            author: null,
            assignees: [],
            labels: [],
            milestone: null,
            createdAt: "2026-10-05T00:00:00Z",
            updatedAt: "2026-10-05T00:00:00Z",
            commentCount: 0,
          },
        }),
      resolveLinkedIssue: () => Effect.succeed(issue),
    });
    const dependencies = Layer.mergeAll(
      harness.dependencies,
      reads,
      CommandReceiptStore.layer.pipe(Layer.provide(harness.dependencies)),
    );
    const layer = IssueWorkService.layer.pipe(Layer.provideMerge(dependencies));
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const rootId = yield* createReviewRoot();
      const first = `milestone-issue:${rootId}:1:${issue.id}:first`;
      // Reproduce durable rejections from the eligibility check inside dispatch.
      for (const id of [first, `${first}:retry:1`]) {
        const rejected = yield* threads
          .dispatch({
            type: "issue.work.start",
            threadId: rootId,
            commandId: CommandId.make(id),
            issue,
            workerModelSelection: modelSelection,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        assert.equal(
          Option.getOrThrow(yield* receipts.getByCommandId(CommandId.make(id))).status,
          "rejected",
        );
      }
      yield* service.reconcile(rootId);
      assert.equal((yield* store.configuration(rootId))!.milestones[0]!.status, "blocked");
      eligible = true;
      yield* service.reconcile(rootId);
      const childId = yield* store.issueOwner(issue);
      assert.isNotNull(childId);
      yield* (yield* WorktreeSetupTracker.WorktreeSetupTracker).stream(childId!).pipe(
        Stream.filter((snapshot) => snapshot?.phase === "done"),
        Stream.runHead,
      );
      assert.equal(
        (yield* threads.getThreadRecords(childId!, ["runs"])).runs[0]!.status,
        "starting",
      );
      assert.equal((yield* store.configuration(rootId))!.milestones[0]!.status, "running");
      assert.equal(
        Option.getOrThrow(yield* receipts.getByCommandId(CommandId.make(`${first}:retry:2`)))
          .status,
        "accepted",
      );
      yield* service.reconcile(rootId);
      yield* service.reconcile(rootId);
      assert.equal(yield* store.issueOwner(issue), childId);
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["subagents"])).subagents, 1);
      assert.lengthOf((yield* threads.getThreadRecords(childId!, ["runs"])).runs, 1);
    }).pipe(Effect.provide(layer));
  },
);
