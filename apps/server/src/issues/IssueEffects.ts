import {
  CommandId,
  IssueChangeError,
  IssueReadError,
  type ThreadLinkedIssue,
  legacyIssueSuspensionKind,
  MessageId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import type * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as IssueChangeService from "./IssueChangeService.ts";
import { issueAutomationEnabled, isAutomaticIssueSuspension } from "./IssueEligibility.ts";
import * as TrackerIssueService from "../issue/IssueService.ts";
import { ensureCommentMarker } from "./IssueGitHubExtension.ts";
import * as IssueService from "./IssueService.ts";
import { fromTrackerError, setGitHubIssueStatus, trackerIssueRef } from "./trackerIssueRef.ts";
import { readIssueCommentReceipt, readIssueWorkCommentState } from "./IssueWorkProjection.ts";

const ISSUE_EFFECT_TYPES = [
  "issue.change.execute",
  "issue.suspension.interrupt",
  "issue.suspension.notify",
  "usage-sprint.notify",
  "issue.status.refresh",
  "issue.board.sync",
  "issue.github.comment",
] as const;

export type IssueEffectRequest = Extract<
  EffectOutbox.OrchestrationEffectRequestV2,
  { readonly type: (typeof ISSUE_EFFECT_TYPES)[number] }
>;

export const isIssueEffectRequest = (
  request: EffectOutbox.OrchestrationEffectRequestV2,
): request is IssueEffectRequest =>
  (ISSUE_EFFECT_TYPES as ReadonlyArray<string>).includes(request.type);

/** Suspension and sprint notices must land eventually, so they ignore the attempt limit. */
export const retriesUntilDone = (request: EffectOutbox.OrchestrationEffectRequestV2) =>
  request.type.startsWith("issue.suspension.") || request.type === "usage-sprint.notify";

const isIssueChangeError = Schema.is(IssueChangeError);
/** GitHub's rate-limit deadline, when the failure carries one. */
export const retryAtOf = (cause: unknown) =>
  isIssueChangeError(cause) ? cause.retryAt : undefined;

/** The marker recovers a POST whose receipt was lost. */
const writeManagedComment = Effect.fn("IssueEffects.writeManagedComment")(function* (
  issues: IssueService.IssueService["Service"],
  tracker: TrackerIssueService.IssueService["Service"],
  input: {
    readonly issue: ThreadLinkedIssue;
    readonly operation: "status_sync" | "closeout_create";
    readonly commentId?: string;
    readonly marker: string;
    readonly body: string;
    readonly retry: boolean;
  },
) {
  const body = ensureCommentMarker(input.body, input.marker);
  const update = (commentId: string) =>
    issues.updateManagedComment({ issue: input.issue, commentId, body }).pipe(Effect.as(commentId));
  if (input.operation === "status_sync" && input.commentId !== undefined) {
    const updated = yield* update(input.commentId).pipe(
      Effect.catchIf(
        (error) => error.code === "inaccessible",
        () => Effect.succeed(null),
      ),
    );
    if (updated !== null) return updated;
  }
  const existing = yield* issues.findManagedComment(input);
  if (existing !== null) {
    if (input.operation === "status_sync" && existing.body !== body)
      return yield* update(existing.id);
    if (input.retry) yield* issues.markChanged(input.issue);
    return existing.id;
  }
  const ref = yield* trackerIssueRef(tracker, "detail", input.issue);
  const posted = yield* tracker
    .comment({ ...ref, body })
    .pipe(Effect.mapError(fromTrackerError("detail")));
  if (posted === undefined)
    return yield* new IssueReadError({
      code: "invalid-response",
      operation: "detail",
      message: "GitHub did not return the comment ID.",
    });
  return posted;
});

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const automation = yield* issueAutomationEnabled;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const issues = yield* Effect.serviceOption(IssueService.IssueService);
  const tracker = yield* Effect.serviceOption(TrackerIssueService.IssueService);
  const issueChanges = yield* Effect.serviceOption(IssueChangeService.IssueChangeService);
  const eventSink = yield* Effect.serviceOption(EventSink.EventSinkV2);
  const idAllocator = yield* Effect.serviceOption(IdAllocator.IdAllocatorV2);

  // GitHub comment writes for one issue run one at a time so markers and receipts stay ordered.
  const issueWriteLocks = new Map<string, Semaphore.Semaphore>();
  const issueWriteLockMap = yield* Semaphore.make(1);
  const withIssueWriteLock = <A, E, R>(
    issue: { readonly host: string; readonly repositoryId: string; readonly id: string },
    use: Effect.Effect<A, E, R>,
  ) =>
    issueWriteLockMap
      .withPermit(
        Effect.gen(function* () {
          const key = `${issue.host.toLowerCase()}:${issue.repositoryId}:${issue.id}`;
          const existing = issueWriteLocks.get(key);
          if (existing !== undefined) return existing;
          const created = yield* Semaphore.make(1);
          issueWriteLocks.set(key, created);
          return created;
        }),
      )
      .pipe(Effect.flatMap((lock) => lock.withPermit(use)));

  const writeComment = Effect.fn("IssueEffects.writeComment")(function* (
    effect: EffectOutbox.OrchestrationEffectV2,
    request: Extract<IssueEffectRequest, { type: "issue.github.comment" }>,
  ) {
    if (
      Option.isNone(issues) ||
      Option.isNone(tracker) ||
      Option.isNone(sql) ||
      Option.isNone(eventSink) ||
      Option.isNone(idAllocator)
    )
      return yield* Effect.fail("IssueService is unavailable in this runtime.");
    let commentId: string | undefined;
    if (request.operation === "status_sync") {
      const current = yield* readIssueWorkCommentState(sql.value, {
        host: request.issue.host,
        repositoryId: request.issue.repositoryId,
        issueId: request.issue.id,
      });
      // An old issue attempt may still finish writing after a successor takes over.
      // Its result is useful, but its status must not replace the current owner.
      if (
        current === null ||
        current.effectiveStatusThreadId !== effect.threadId ||
        current.latestStatusWriteKey !== request.writeKey
      )
        return;
      const thread = yield* projections.getThread(effect.threadId);
      if (thread.deletedAt !== null && request.status !== "unavailable") return;
      commentId = current.statusCommentId ?? undefined;
    } else {
      const receipt = yield* readIssueCommentReceipt(sql.value, request.writeKey);
      if (receipt?.commentId != null) return;
    }

    const writtenCommentId = yield* issues.value.withRepositoryCredential(
      request.issue,
      writeManagedComment(issues.value, tracker.value, {
        issue: request.issue,
        operation: request.operation,
        ...(commentId === undefined ? {} : { commentId }),
        marker: request.marker,
        body: request.body,
        retry: effect.attemptCount > 1,
      }),
    );
    const commandId = CommandId.make(`command:issue-comment-receipt:${effect.id}`);
    const now = yield* DateTime.now;
    const eventId = yield* idAllocator.value.allocate.event({
      threadId: effect.threadId,
      commandId,
    });
    yield* eventSink.value.commitCommand({
      commandId,
      threadId: effect.threadId,
      commandType: "issue.github-comment.recorded",
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: eventId,
          threadId: effect.threadId,
          type: "issue.github-comment.recorded",
          occurredAt: now,
          payload: {
            operation: request.operation,
            issue: request.issue,
            threadId: effect.threadId,
            writeKey: request.writeKey,
            ...(request.resultEventId === undefined
              ? {}
              : { resultEventId: request.resultEventId }),
            commentId: writtenCommentId,
            marker: request.marker,
          },
        },
      ],
    });
  });

  // A server-sent queue message, deduplicated by the effect id across outbox retries.
  const sendOnce = Effect.fn("IssueEffects.sendOnce")(function* <E>(
    effect: EffectOutbox.OrchestrationEffectV2,
    send: (input: {
      readonly messageId: MessageId;
      readonly commandId: CommandId;
    }) => Effect.Effect<unknown, E>,
  ) {
    const messageId = MessageId.make(effect.id);
    const prior = yield* threads.getThreadRecords(effect.threadId, ["messages"], {
      messageIds: [messageId],
    });
    if (prior.messages.some((message) => message.id === messageId)) return;
    yield* send({
      messageId,
      commandId: CommandId.make(`${effect.id}:attempt:${effect.attemptCount}`),
    });
  });

  // Runs inside the OrchestrationEffectExecutorV2.execute span.
  const execute = Effect.fnUntraced(function* (
    effect: EffectOutbox.OrchestrationEffectV2,
    request: IssueEffectRequest,
  ) {
    switch (request.type) {
      case "issue.change.execute":
        return yield* Option.isNone(issueChanges)
          ? Effect.fail(
              new IssueChangeError({
                code: "github",
                message: "IssueChangeService is unavailable in this runtime.",
              }),
            )
          : issueChanges.value.execute(request.changeId);
      case "issue.suspension.interrupt": {
        const shell = yield* threads.getThreadShell(effect.threadId);
        if (shell?.activeRunId !== request.runId) return;
        yield* threads.dispatch({
          type: "run.interrupt",
          threadId: effect.threadId,
          runId: request.runId,
          retryInterruptUntilDone: true,
          reason: request.reason ?? "Interrupted by issue work suspension",
          // A failed command has a rejected receipt. A new outbox attempt
          // may retry it; the recorded run guards against stopping later work.
          commandId: CommandId.make(`${effect.id}:attempt:${effect.attemptCount}`),
        });
        return;
      }
      case "issue.suspension.notify":
        // Older outbox entries may predate quiet, event-sourced suspension notices.
        if (
          isAutomaticIssueSuspension({
            kind: request.kind ?? legacyIssueSuspensionKind(request.reason),
          })
        )
          return;
        return yield* sendOnce(effect, ({ messageId, commandId }) =>
          threads.sendToThread({
            projectId: request.projectId,
            threadId: effect.threadId,
            commandId,
            messageId,
            text: `Issue #${request.issue.number} paused: ${request.reason} Its workspace, link and results are retained. Ask through t3_request_user_input; do not reopen it or change the existing lineage.`,
            attachments: [],
            mode: "queue",
            createdBy: "agent",
            creationSource: "server",
          }),
        );
      case "usage-sprint.notify":
        return;
      case "issue.board.sync":
        if (!automation || Option.isNone(issues) || Option.isNone(tracker) || Option.isNone(sql))
          return;
        return yield* withIssueWriteLock(
          request.issue,
          Effect.gen(function* () {
            const issue = request.issue;
            const claim = yield* readIssueWorkCommentState(sql.value, {
              host: issue.host,
              repositoryId: issue.repositoryId,
              issueId: issue.id,
            });
            if (claim?.ownerThreadId !== effect.threadId) return;
            const expected = request.status === "In progress" ? "Todo" : "In progress";
            if (request.status === "In review") {
              const shell = yield* projections.getThreadShell(effect.threadId);
              if (
                !shell?.pullRequests?.some(
                  (pr) =>
                    pr.source !== "stack-dismissed" &&
                    pr.snapshot?.state === "open" &&
                    !pr.snapshot.isDraft,
                )
              )
                return;
            }
            const read = yield* issues.value.workRead(issue);
            if (
              read.issue.id === issue.id &&
              read.state === "open" &&
              read.planningStatus === expected
            )
              yield* setGitHubIssueStatus(tracker.value, issue, request.status);
          }),
        );
      case "issue.status.refresh":
        if (Option.isNone(eventSink)) return yield* Effect.fail("Issue event sink is unavailable.");
        return yield* withIssueWriteLock(
          request.issue,
          eventSink.value.refreshIssueStatus({ ...request, threadId: effect.threadId }),
        );
      case "issue.github.comment":
        return yield* withIssueWriteLock(request.issue, writeComment(effect, request));
    }
  });

  return { execute };
});
