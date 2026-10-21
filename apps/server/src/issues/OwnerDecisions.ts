import {
  CommandId,
  MessageId,
  OwnerDecision,
  OwnerDecisionChooseInput,
  OwnerDecisionError,
  OwnerDecisionRequest,
  OwnerDecisionWithdrawInput,
  type AuthEnvironmentScope,
  type OwnerDecisionsListInput,
  ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as IssueInbox from "./IssueInbox.ts";
import * as IssueWorkStore from "./IssueWorkStore.ts";
import { commentIdentity, decisionComment, parseDecisionComment } from "./OwnerDecisionComments.ts";
import * as IssueService from "./IssueService.ts";
import * as Watcher from "./IssueInboxWatcher.ts";

// Only the authenticated client transport supplies this actor; MCP never exposes choose.
type Actor = {
  readonly kind: "user" | "agent";
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
};
export class OwnerDecisions extends Context.Service<
  OwnerDecisions,
  {
    readonly request: (
      threadId: ThreadId,
      input: OwnerDecisionRequest,
    ) => Effect.Effect<OwnerDecision, OwnerDecisionError>;
    readonly list: (
      input: OwnerDecisionsListInput,
    ) => Effect.Effect<ReadonlyArray<OwnerDecision>, OwnerDecisionError>;
    readonly listForCaller: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<OwnerDecision>, OwnerDecisionError>;
    readonly withdraw: (
      threadId: ThreadId,
      input: OwnerDecisionWithdrawInput,
    ) => Effect.Effect<OwnerDecision, OwnerDecisionError>;
    readonly choose: (
      input: OwnerDecisionChooseInput,
      actor: Actor,
    ) => Effect.Effect<OwnerDecision, OwnerDecisionError>;
    readonly changes: Stream.Stream<number>;
    readonly drain: Effect.Effect<void, OwnerDecisionError>;
  }
>()("t3/issues/OwnerDecisions") {}

type Row = {
  id: string;
  request_json: string;
  state: OwnerDecision["state"];
  request_comment_json: string | null;
  choice_comment_json: string | null;
  chosen_option_id: string | null;
  chosen_by: string | null;
  chosen_at: string | null;
  withdrawal_reason: string | null;
  updated_at: string;
  delivered_at: string | null;
  delivery_thread_id: string | null;
  pending_publish: OwnerDecision["pendingPublish"];
  pending_delivery: number;
  pending_label: number;
  last_error: string | null;
};
const RequestRecord = Schema.Struct({
  ...OwnerDecisionRequest.fields,
  id: OwnerDecision.fields.id,
  requestingThreadId: OwnerDecision.fields.requestingThreadId,
  requestingThreadTitle: OwnerDecision.fields.requestingThreadTitle,
  requestingProjectId: OwnerDecision.fields.requestingProjectId,
  requestingProjectTitle: OwnerDecision.fields.requestingProjectTitle,
  createdAt: OwnerDecision.fields.createdAt,
});
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(RequestRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(RequestRecord));
const decodeComment = Schema.decodeEffect(
  Schema.fromJsonString(OwnerDecision.fields.requestComment),
);
const encodeComment = Schema.encodeEffect(
  Schema.fromJsonString(OwnerDecision.fields.requestComment),
);
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(OwnerDecisionRequest));
const decodeRequest = Schema.decodeUnknownEffect(OwnerDecisionRequest);
const decodeChoose = Schema.decodeUnknownEffect(OwnerDecisionChooseInput);
const decodeWithdraw = Schema.decodeUnknownEffect(OwnerDecisionWithdrawInput);
const decodeComments = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        body: Schema.NullOr(Schema.String),
        html_url: Schema.String,
      }),
    ),
  ),
);
const decodeLabels = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
);
const isDecisionError = Schema.is(OwnerDecisionError);
const storageError = (cause: unknown) =>
  isDecisionError(cause)
    ? cause
    : new OwnerDecisionError({ code: "storage", message: "Owner decision storage failed.", cause });
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const inbox = yield* IssueInbox.IssueInbox;
  const work = yield* IssueWorkStore.IssueWorkStore;
  const issues = yield* IssueService.IssueService;
  const github = yield* Watcher.make;
  const lock = yield* Semaphore.make(1);
  const updates = yield* PubSub.sliding<number>(1);
  let revision = 0;
  const notify = Effect.suspend(() => PubSub.publish(updates, ++revision)).pipe(Effect.asVoid);
  const fromRow = Effect.fn("OwnerDecisions.fromRow")(function* (row: Row) {
    const request = yield* decodeRecord(row.request_json);
    return {
      ...request,
      state: row.state,
      requestComment:
        row.request_comment_json === null ? null : yield* decodeComment(row.request_comment_json),
      choiceComment:
        row.choice_comment_json === null ? null : yield* decodeComment(row.choice_comment_json),
      chosenOptionId: row.chosen_option_id,
      chosenBy: row.chosen_by,
      chosenAt: row.chosen_at,
      withdrawalReason: row.withdrawal_reason,
      updatedAt: row.updated_at,
      deliveredAt: row.delivered_at,
      deliveryThreadId:
        row.delivery_thread_id === null ? null : ThreadId.make(row.delivery_thread_id),
      pendingPublish: row.pending_publish,
      pendingDelivery: row.pending_delivery === 1,
      pendingLabel: row.pending_label === 1,
      lastError: row.last_error,
    } satisfies OwnerDecision;
  }, Effect.mapError(storageError));
  const get = Effect.fn("OwnerDecisions.get")(function* (id: string) {
    const [row] = yield* sql<Row>`SELECT * FROM owner_decisions WHERE id = ${id}`;
    if (row === undefined)
      return yield* new OwnerDecisionError({
        code: "invalid-request",
        message: "Owner decision was not found.",
      });
    return yield* fromRow(row);
  }, Effect.mapError(storageError));
  const list = Effect.fn("OwnerDecisions.list")(function* (input: OwnerDecisionsListInput) {
    const rows = yield* sql<Row>`SELECT * FROM owner_decisions WHERE
      ${input.threadId === undefined ? sql`1` : sql`requesting_thread_id = ${input.threadId}`}
      AND ${input.projectId === undefined ? sql`1` : sql`requesting_project_id = ${input.projectId}`}
      AND ${input.host === undefined ? sql`1` : sql`host = ${input.host.toLowerCase()}`}
      AND ${input.repository === undefined ? sql`1` : sql`repository = ${input.repository.toLowerCase()}`}
      AND ${input.number === undefined ? sql`1` : sql`issue_number = ${input.number}`}
      ORDER BY created_at DESC, id`;
    return yield* Effect.forEach(rows, fromRow);
  }, Effect.mapError(storageError));
  const matchRequest = Effect.fn("OwnerDecisions.matchRequest")(function* (
    row: Row,
    input: OwnerDecisionRequest,
  ) {
    const previous = yield* fromRow(row);
    if ((yield* encodeRequest(previous)) !== (yield* encodeRequest(input)))
      return yield* new OwnerDecisionError({
        code: "invalid-request",
        message: "The retry id already belongs to a different immutable request.",
      });
    return previous;
  });
  const request = Effect.fn("OwnerDecisions.request")(
    function* (threadId: ThreadId, raw: OwnerDecisionRequest) {
      const decoded = yield* decodeRequest(raw).pipe(
        Effect.mapError(
          (cause) =>
            new OwnerDecisionError({
              code: "invalid-request",
              message: "Invalid owner decision request.",
              cause,
            }),
        ),
      );
      const input = {
        ...decoded,
        host: decoded.host.toLowerCase(),
        repository: decoded.repository.toLowerCase(),
      };
      if (
        new Set(input.options.map((option) => option.id)).size !== input.options.length ||
        !input.options.some((option) => option.id === input.recommendedOptionId)
      )
        return yield* new OwnerDecisionError({
          code: "invalid-request",
          message: "Option ids must be unique and the recommendation must name an option.",
        });
      const existing =
        yield* sql<Row>`SELECT * FROM owner_decisions WHERE requesting_thread_id = ${threadId} AND client_request_id = ${input.clientRequestId}`;
      if (existing[0] !== undefined) return yield* matchRequest(existing[0], input);
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null)
        return yield* new OwnerDecisionError({
          code: "invalid-request",
          message: "The requesting thread is unavailable.",
        });
      const project = Option.getOrNull(yield* projects.getById(shell.projectId));
      if (project === null)
        return yield* new OwnerDecisionError({
          code: "invalid-request",
          message: "The requesting project is unavailable.",
        });
      const now = yield* nowIso;
      const decision: OwnerDecision = {
        ...input,
        id: `D${yield* randomUuidV4}`,
        requestingThreadId: threadId,
        requestingThreadTitle: shell.title,
        requestingProjectId: shell.projectId,
        requestingProjectTitle: project.title,
        state: "publishing",
        requestComment: null,
        choiceComment: null,
        chosenOptionId: null,
        chosenBy: null,
        chosenAt: null,
        withdrawalReason: null,
        createdAt: now,
        updatedAt: now,
        deliveredAt: null,
        deliveryThreadId: null,
        pendingPublish: "request",
        pendingDelivery: false,
        pendingLabel: true,
        lastError: null,
      };
      const json = yield* encodeRecord(decision);
      yield* sql`INSERT OR IGNORE INTO owner_decisions(id, requesting_thread_id, requesting_project_id, client_request_id, host, repository, issue_number, request_json, state, created_at, updated_at, pending_publish)
      VALUES (${decision.id}, ${threadId}, ${shell.projectId}, ${input.clientRequestId}, ${input.host}, ${input.repository}, ${input.number}, ${json}, 'publishing', ${now}, ${now}, 'request')`;
      const [accepted] =
        yield* sql<Row>`SELECT * FROM owner_decisions WHERE requesting_thread_id = ${threadId} AND client_request_id = ${input.clientRequestId}`;
      const result = yield* matchRequest(accepted!, input);
      yield* notify;
      return result;
    },
    lock.withPermit,
    Effect.mapError(storageError),
  );
  const choose = Effect.fn("OwnerDecisions.choose")(
    function* (raw: OwnerDecisionChooseInput, actor: Actor) {
      if (
        actor.kind !== "user" ||
        !actor.subject.trim() ||
        !actor.scopes.includes("orchestration:operate")
      )
        return yield* new OwnerDecisionError({
          code: "forbidden",
          message: "Only the signed-in owner with operate scope can choose.",
        });
      const input = yield* decodeChoose(raw).pipe(
        Effect.mapError(
          (cause) =>
            new OwnerDecisionError({
              code: "invalid-request",
              message: "Invalid owner choice.",
              cause,
            }),
        ),
      );
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const decision = yield* get(input.id);
          if (decision.chosenOptionId !== null) {
            if (decision.chosenOptionId !== input.optionId)
              return yield* new OwnerDecisionError({
                code: "invalid-request",
                message: "An owner choice has already won.",
              });
            return;
          }
          if (
            decision.state !== "awaiting_choice" ||
            !decision.options.some((option) => option.id === input.optionId)
          )
            return yield* new OwnerDecisionError({
              code: "invalid-request",
              message: "This decision is not awaiting that choice.",
            });
          const now = yield* nowIso;
          // The compare-and-set and both durable work steps are the same commit.
          const accepted =
            yield* sql`UPDATE owner_decisions SET state = 'answered', chosen_option_id = ${input.optionId}, chosen_by = ${actor.subject}, chosen_at = ${now}, updated_at = ${now}, pending_publish = 'choice', pending_delivery = 1, pending_label = 1, last_error = NULL
        WHERE id = ${input.id} AND state = 'awaiting_choice' AND chosen_option_id IS NULL RETURNING id`;
          if (accepted.length !== 1)
            return yield* new OwnerDecisionError({
              code: "invalid-request",
              message: "An owner choice has already won.",
            });
        }),
      );
      yield* notify;
      return yield* get(input.id);
    },
    lock.withPermit,
    Effect.mapError(storageError),
  );
  const withdraw = Effect.fn("OwnerDecisions.withdraw")(
    function* (threadId: ThreadId, raw: OwnerDecisionWithdrawInput) {
      const input = yield* decodeWithdraw(raw).pipe(
        Effect.mapError(
          (cause) =>
            new OwnerDecisionError({
              code: "invalid-request",
              message: "A withdrawal needs a reason.",
              cause,
            }),
        ),
      );
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const decision = yield* get(input.id);
          if (decision.requestingThreadId !== threadId)
            return yield* new OwnerDecisionError({
              code: "forbidden",
              message: "Only the requesting thread can withdraw this decision.",
            });
          if (decision.chosenOptionId !== null)
            return yield* new OwnerDecisionError({
              code: "invalid-request",
              message: "An answered decision cannot be withdrawn.",
            });
          if (decision.state === "withdrawn") return;
          yield* sql`UPDATE owner_decisions SET state = 'withdrawn', withdrawal_reason = ${input.reason}, updated_at = ${yield* nowIso}, pending_publish = 'withdrawn', pending_label = 1, last_error = NULL WHERE id = ${input.id} AND chosen_option_id IS NULL`;
        }),
      );
      yield* notify;
      return yield* get(input.id);
    },
    lock.withPermit,
    Effect.mapError(storageError),
  );

  const reconcileComment = Effect.fn("OwnerDecisions.reconcileComment")(
    function* (decision: OwnerDecision, body: string) {
      const expected = parseDecisionComment(body)!;
      const identity = commentIdentity(decision.pendingPublish!, decision.id);
      let page: number | null = 1;
      do {
        const response: Effect.Success<
          ReturnType<IssueService.IssueService["Service"]["repositoryRest"]>
        > = yield* github.rest(
          decision,
          `issues/${decision.number}/comments?per_page=100&page=${page}`,
        );
        const comments = yield* decodeComments(response.body);
        for (const comment of comments) {
          if (!comment.body?.includes(identity)) continue;
          const actual = parseDecisionComment(comment.body);
          if (
            actual === null ||
            actual.digest !== expected.digest ||
            actual.kind !== expected.kind ||
            actual.id !== expected.id ||
            actual.optionId !== expected.optionId
          )
            return yield* new OwnerDecisionError({
              code: "publication-mismatch",
              message: `Decision publication stopped: comment ${comment.html_url} does not match the expected ${decision.pendingPublish} content and digest.`,
            });
          return { id: String(comment.id), url: comment.html_url };
        }
        page = response.nextPage;
      } while (page !== null);
      const posted = yield* inbox.post(
        decision.requestingThreadId,
        {
          host: decision.host,
          repository: decision.repository,
          issueNumber: decision.number,
          body,
        },
        decision.requestingProjectId,
      );
      if (posted.commentId === null)
        return yield* new OwnerDecisionError({
          code: "github",
          message: "GitHub did not return a decision comment reference.",
        });
      return { id: posted.commentId, url: posted.url };
    },
    Effect.mapError((cause) =>
      isDecisionError(cause)
        ? cause
        : new OwnerDecisionError({
            code: "github",
            message: "Decision comment publication failed; it will be reconciled before retrying.",
            cause,
          }),
    ),
  );
  const publish = Effect.fn("OwnerDecisions.publish")(function* (decision: OwnerDecision) {
    if (decision.pendingPublish === null) return;
    const choice = decision.options.find((option) => option.id === decision.chosenOptionId);
    const readable =
      decision.pendingPublish === "request"
        ? [
            `## Owner decision ${decision.id}`,
            decision.question,
            ...decision.options.map(
              (option) => `- **${option.label}** (\`${option.id}\`): ${option.consequence}`,
            ),
            `Recommended: **${decision.options.find((option) => option.id === decision.recommendedOptionId)!.label}**. ${decision.recommendationReason}`,
            `Evidence: ${decision.evidenceUrl}`,
            `Requested by ${decision.requestingProjectTitle} / ${decision.requestingThreadTitle} (thread ${decision.requestingThreadId}).`,
            "Answer through T3's signed-in owner interface. Agents cannot choose.",
          ].join("\n\n")
        : decision.pendingPublish === "choice"
          ? [
              `Owner chose ${choice!.label} for ${decision.id}.`,
              `Next: ${choice!.consequence}`,
              `Chosen at ${decision.chosenAt} by ${decision.chosenBy}.`,
              `Request: ${decision.requestComment!.url}`,
            ].join("\n\n")
          : [
              `Owner decision ${decision.id} withdrawn.`,
              `Reason: ${decision.withdrawalReason}`,
            ].join("\n\n");
    const body = decisionComment(
      decision.pendingPublish,
      decision.id,
      readable,
      decision.pendingPublish === "choice" ? decision.chosenOptionId! : undefined,
    );
    const comment = yield* reconcileComment(decision, body);
    const json = yield* encodeComment(comment);
    if (decision.pendingPublish === "request")
      yield* sql`UPDATE owner_decisions SET request_comment_json = ${json}, state = 'awaiting_choice', pending_publish = NULL, last_error = NULL, updated_at = ${yield* nowIso} WHERE id = ${decision.id}`;
    else if (decision.pendingPublish === "choice")
      yield* sql`UPDATE owner_decisions SET choice_comment_json = ${json}, state = 'answered', pending_publish = NULL, last_error = NULL, updated_at = ${yield* nowIso} WHERE id = ${decision.id}`;
    else
      yield* sql`UPDATE owner_decisions SET state = 'withdrawn', pending_publish = NULL, last_error = NULL, updated_at = ${yield* nowIso} WHERE id = ${decision.id}`;
    yield* notify;
  }, Effect.mapError(storageError));
  const syncLabel = Effect.fn("OwnerDecisions.syncLabel")(
    function* (decision: OwnerDecision) {
      if (decision.pendingPublish !== null || decision.state === "publication_mismatch") return;
      const [open] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM owner_decisions WHERE host = ${decision.host} AND repository = ${decision.repository} AND issue_number = ${decision.number} AND chosen_option_id IS NULL AND state != 'withdrawn'`;
      if ((open?.count ?? 0) > 0) {
        yield* github.ensureLabels(decision, ["decision-needed"]);
        yield* github.rest(decision, `issues/${decision.number}/labels`, {
          body: { labels: ["decision-needed"] },
        });
      } else {
        // One bounded read; an incomplete view cannot prove that label removal is safe.
        const page = yield* github.rest(
          decision,
          `issues/${decision.number}/comments?per_page=100&page=1`,
        );
        const comments = yield* decodeComments(page.body);
        const openRequests = new Set<string>();
        const closedRequests = new Set<string>();
        for (const comment of comments) {
          const body = comment.body ?? "";
          // Unverifiable or older request markers remain open; they cannot authorize cleanup.
          for (const match of body.matchAll(/<!-- t3-decision-request:v1 id=(\S+)(?: | -->)/gu))
            openRequests.add(match[1]!);
          const parsed = parseDecisionComment(body);
          if (parsed !== null && parsed.kind !== "request") closedRequests.add(parsed.id!);
        }
        if (page.nextPage !== null || [...openRequests].some((id) => !closedRequests.has(id)))
          return;
        const response = yield* github.rest(
          decision,
          `issues/${decision.number}/labels?per_page=100`,
        );
        const labels = yield* decodeLabels(response.body);
        if (labels.some((label) => label.name.toLowerCase() === "decision-needed"))
          yield* issues.repositoryRest({
            host: decision.host,
            repository: decision.repository,
            path: `issues/${decision.number}/labels/decision-needed`,
            method: "DELETE",
          });
      }
      yield* sql`UPDATE owner_decisions SET pending_label = 0, last_error = CASE WHEN state IN ('publication_mismatch', 'delivery_failed') OR pending_delivery = 1 THEN last_error ELSE NULL END WHERE id = ${decision.id}`;
    },
    Effect.mapError(
      (cause) =>
        new OwnerDecisionError({
          code: "github",
          message: "Decision label update failed; it will be retried.",
          cause,
        }),
    ),
  );
  const resolveDestination = Effect.fn("OwnerDecisions.resolveDestination")(function* (
    decision: OwnerDecision,
  ) {
    let destination = decision.requestingThreadId;
    const visited = new Set<ThreadId>();
    while (!visited.has(destination) && visited.size < 100) {
      visited.add(destination);
      const configuration = yield* work.configuration(destination);
      if (configuration?.retiredToThreadId !== undefined) {
        destination = configuration.retiredToThreadId;
        continue;
      }
      if (configuration !== null) {
        const owner = yield* work.repositoryOwnerByRef(configuration);
        if (owner !== null && owner.rootThreadId !== destination) {
          destination = owner.rootThreadId;
          continue;
        }
      }
      const shell = yield* threads.getThreadShell(destination);
      if (shell !== null && shell.deletedAt === null && shell.archivedAt === null)
        return destination;
      return yield* new OwnerDecisionError({
        code: "delivery-unavailable",
        message:
          "Requester unavailable with no available successor; owner decision remains undelivered.",
      });
    }
    return yield* new OwnerDecisionError({
      code: "delivery-unavailable",
      message: "Requester handoff chain is cyclic or too long; owner decision remains undelivered.",
    });
  });
  const deliver = Effect.fn("OwnerDecisions.deliver")(
    function* (decision: OwnerDecision) {
      if (!decision.pendingDelivery || decision.choiceComment === null) return;
      const destination = decision.deliveryThreadId ?? (yield* resolveDestination(decision));
      // Freeze the recipient before dispatch: a lost receipt must replay the same command payload.
      if (decision.deliveryThreadId === null)
        yield* sql`UPDATE owner_decisions SET delivery_thread_id = ${destination}, updated_at = ${yield* nowIso} WHERE id = ${decision.id}`;
      const choice = decision.options.find((option) => option.id === decision.chosenOptionId)!;
      const text = `Owner decision ${decision.id} on ${decision.repository}#${decision.number}: ${choice.label}. Next: ${choice.consequence}. Evidence: ${decision.evidenceUrl}. Owner record: ${decision.choiceComment.url}.`;
      const id = `owner-decision:${decision.id}:${decision.requestingThreadId}`;
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          messageId: MessageId.make(id),
          threadId: destination,
          text,
          notification: {
            source: { kind: "system" },
            outcome: "updated",
            summary: "Owner decision answered",
            detail: text,
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const shell = yield* threads.getThreadShell(destination);
              if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null)
                return yield* new OwnerDecisionError({
                  code: "delivery-unavailable",
                  message:
                    "Saved notification destination is unavailable; owner decision remains undelivered.",
                  cause,
                });
              return yield* cause;
            }),
          ),
        );
      const now = yield* nowIso;
      yield* sql`UPDATE owner_decisions SET pending_delivery = 0, delivered_at = ${now}, last_error = CASE WHEN pending_label = 0 THEN NULL ELSE last_error END, updated_at = ${now} WHERE id = ${decision.id}`;
      yield* notify;
    },
    Effect.mapError((cause) =>
      isDecisionError(cause)
        ? cause
        : new OwnerDecisionError({
            code: "delivery",
            message: "Owner decision delivery failed; it will be retried.",
            cause,
          }),
    ),
  );
  const drain = Effect.gen(function* () {
    const pending =
      yield* sql<Row>`SELECT * FROM owner_decisions WHERE pending_publish IS NOT NULL OR pending_delivery = 1 OR pending_label = 1 ORDER BY created_at, id`;
    for (const row of pending) {
      const recordFailure = Effect.fn("OwnerDecisions.recordFailure")(function* (error: unknown) {
        const problem = storageError(error);
        if (problem.code === "publication-mismatch")
          yield* sql`UPDATE owner_decisions SET state = 'publication_mismatch', pending_publish = NULL, pending_delivery = 0, pending_label = 0, last_error = ${problem.message}, updated_at = ${yield* nowIso} WHERE id = ${row.id}`;
        else if (problem.code === "delivery-unavailable")
          yield* sql`UPDATE owner_decisions SET state = 'delivery_failed', pending_delivery = 0, last_error = ${problem.message}, updated_at = ${yield* nowIso} WHERE id = ${row.id}`;
        else
          yield* sql`UPDATE owner_decisions SET state = CASE WHEN pending_publish IS NOT NULL THEN 'publication_failed' ELSE state END, last_error = CASE WHEN state IN ('publication_mismatch', 'delivery_failed') THEN last_error ELSE ${problem.message} END, updated_at = ${yield* nowIso} WHERE id = ${row.id}`;
        yield* notify;
      });
      yield* publish(yield* get(row.id)).pipe(Effect.catch(recordFailure));
      const current = yield* get(row.id);
      // Label cleanup and delivery retry independently; neither may strand the other.
      if (current.pendingLabel) yield* syncLabel(current).pipe(Effect.catch(recordFailure));
      yield* deliver(current).pipe(Effect.catch(recordFailure));
      yield* notify;
    }
  }).pipe(lock.withPermit, Effect.withSpan("OwnerDecisions.drain"), Effect.mapError(storageError));
  return OwnerDecisions.of({
    request,
    list,
    listForCaller: Effect.fn("OwnerDecisions.listForCaller")((threadId) => list({ threadId })),
    choose,
    withdraw,
    drain,
    changes: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(updates);
        return Stream.concat(Stream.make(revision), Stream.fromSubscription(subscription));
      }),
    ),
  });
});

export const layer = Layer.effect(
  OwnerDecisions,
  Effect.gen(function* () {
    const decisions = yield* make;
    const scheduler = yield* Effect.serviceOption(Scheduler.Scheduler);
    if (Option.isSome(scheduler))
      yield* scheduler.value.register("owner-decisions", decisions.drain);
    return decisions;
  }),
);
