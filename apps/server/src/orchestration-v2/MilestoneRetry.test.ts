import { assert, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  createReviewRoot,
  modelSelection,
  reviewHarness,
  reviewIssue,
  reviewRead,
} from "./ThreadLaunchService.testHarness.ts";

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
