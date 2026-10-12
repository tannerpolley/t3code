import { createPatch } from "diff";
import {
  CommandId,
  IssueChange,
  IssueChangeError,
  IssueReadError,
  IssueChangeProposeInput,
  IssueChangeOperation,
  type IssueChangeBaseline,
  type IssueChangeDecisionInput,
  type IssueChangesListInput,
  type ThreadId,
  type ThreadLinkedIssue,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as IssueService from "./IssueService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";

// Actor authority is supplied by the authenticated transport, never decoded from a proposal.
type Actor = {
  readonly kind: "user" | "agent";
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
};
export class IssueChangeService extends Context.Service<
  IssueChangeService,
  {
    readonly propose: (
      threadId: ThreadId,
      input: IssueChangeProposeInput,
    ) => Effect.Effect<IssueChange, IssueChangeError>;
    readonly decide: (
      input: IssueChangeDecisionInput,
      actor: Actor,
    ) => Effect.Effect<IssueChange, IssueChangeError>;
    readonly list: (
      input: IssueChangesListInput,
    ) => Effect.Effect<ReadonlyArray<IssueChange>, IssueChangeError>;
    readonly subscribe: (input: IssueChangesListInput) => Stream.Stream<number>;
    readonly execute: (id: string) => Effect.Effect<void, IssueChangeError>;
  }
>()("t3/issues/IssueChangeService") {}

type Row = {
  change_id: string;
  proposal_json: string;
  decision: IssueChange["decision"];
  decided_by: string | null;
  status: IssueChange["status"];
  steps_json: string;
  in_flight_step: string | null;
  result: string | null;
};
const decodeChange = Schema.decodeEffect(Schema.fromJsonString(IssueChange));
const encodeChange = Schema.encodeEffect(Schema.fromJsonString(IssueChange));
const decodeSteps = Schema.decodeEffect(Schema.fromJsonString(IssueChange.fields.completedSteps));
const encodeSteps = Schema.encodeEffect(Schema.fromJsonString(IssueChange.fields.completedSteps));
const encodeOperationJson = Schema.encodeEffect(Schema.fromJsonString(IssueChangeOperation));
const encodeOperation = (operation: IssueChangeOperation) =>
  encodeOperationJson(operation).pipe(Effect.mapError(storageError));
const decodeProposal = Schema.decodeUnknownEffect(IssueChangeProposeInput);
const isChangeError = Schema.is(IssueChangeError);
const invalid = (message: string) => new IssueChangeError({ code: "invalid-request", message });
const storageError = (cause: unknown) =>
  new IssueChangeError({
    code: "storage",
    message: `Issue change storage failed: ${String(cause)}`,
  });
const githubError = (cause: {
  readonly message: string;
  readonly retryAt?: number | undefined;
  readonly createOutcome?: IssueChangeError["createOutcome"];
}) =>
  new IssueChangeError({
    code: "github",
    message: cause.message,
    ...(cause.createOutcome === undefined ? {} : { createOutcome: cause.createOutcome }),
    ...(cause.retryAt === undefined ? {} : { retryAt: cause.retryAt }),
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* IssueService.IssueService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const executionLock = yield* Semaphore.make(1);
  let revision = 0;
  const updates = yield* PubSub.sliding<{
    revision: number;
    threadId: ThreadId;
    host: string;
    repository: string;
    numbers: ReadonlyArray<number>;
  }>(64);
  const notify = (change: IssueChange) =>
    PubSub.publish(updates, {
      revision: ++revision,
      threadId: change.requestingThreadId,
      host: change.host,
      repository: change.repository,
      numbers: [
        ...(change.baseline === null ? [] : [change.baseline.issue.number]),
        ...Object.values(change.completedSteps).flatMap((step) =>
          step.issue === undefined ? [] : [step.issue.number],
        ),
      ],
    }).pipe(Effect.asVoid);
  const fromRow = (row: Row) =>
    Effect.gen(function* () {
      const proposal = yield* decodeChange(row.proposal_json);
      const completedSteps = yield* decodeSteps(row.steps_json);
      return {
        ...proposal,
        decision: row.decision,
        decidedBy: row.decided_by,
        status: row.status,
        completedSteps,
        result: row.result,
      };
    }).pipe(Effect.mapError(storageError));
  const rowById = (id: string) =>
    sql<Row>`SELECT * FROM issue_changes WHERE change_id = ${id}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(invalid("Issue change was not found."))
          : Effect.succeed(rows[0]),
      ),
      Effect.mapError((error) => (isChangeError(error) ? error : storageError(error))),
    );
  const get = (id: string) => rowById(id).pipe(Effect.flatMap(fromRow));
  const enqueue = (change: IssueChange) =>
    outbox
      .enqueue([
        {
          id: `effect:issue-change:${change.id}`,
          commandId: CommandId.make(`issue-change:${change.id}`),
          threadId: change.requestingThreadId,
          request: { type: "issue.change.execute", changeId: change.id },
        },
      ])
      .pipe(Effect.mapError(storageError));
  const target = (id: string, issue: Pick<ThreadLinkedIssue, "host" | "repository" | "number">) =>
    sql`
    INSERT OR IGNORE INTO issue_change_targets(change_id, host, repository, issue_number)
    VALUES (${id}, ${issue.host.toLowerCase()}, ${issue.repository.toLowerCase()}, ${issue.number})`.pipe(
      Effect.asVoid,
      Effect.mapError(storageError),
    );
  const bodyBaseline = (id: string, baseline: IssueChangeBaseline) =>
    sql`
    INSERT INTO issue_body_baselines(host, issue_id, body, change_id)
    VALUES (${baseline.issue.host}, ${baseline.issue.id}, ${baseline.body}, ${id})
    ON CONFLICT(host, issue_id) DO UPDATE SET body = excluded.body, change_id = excluded.change_id`.pipe(
      Effect.asVoid,
      Effect.mapError(storageError),
    );

  const propose: IssueChangeService["Service"]["propose"] = Effect.fn("IssueChangeService.propose")(
    function* (threadId, rawInput) {
      const decoded = yield* decodeProposal(rawInput).pipe(
        Effect.mapError(() => invalid("Invalid issue change proposal.")),
      );
      const input = {
        ...decoded,
        host: decoded.host.toLowerCase(),
        repository: decoded.repository.toLowerCase(),
      };
      const thread = yield* sql<{ host: string; repository: string }>`
      SELECT owner.host, json_extract(root.payload_json, '$.repositoryOrchestration.repository') AS repository
      FROM orchestration_v2_projection_threads thread
      JOIN orchestration_v2_projection_repository_orchestration owner
        ON owner.root_thread_id = thread.thread_id OR
          (owner.host = json_extract(thread.payload_json, '$.linkedIssue.host') AND owner.repository_id = json_extract(thread.payload_json, '$.linkedIssue.repositoryId'))
      JOIN orchestration_v2_projection_threads root ON root.thread_id = owner.root_thread_id
      WHERE thread.thread_id = ${threadId} AND thread.deleted_at IS NULL AND thread.archived_at IS NULL
        AND thread.default_provider IN ('codex', 'claudeAgent')
        AND root.deleted_at IS NULL AND root.archived_at IS NULL
    `.pipe(Effect.mapError(storageError));
      if (
        !thread.some(
          (row) =>
            row.host.toLowerCase() === input.host.toLowerCase() &&
            row.repository.toLowerCase() === input.repository.toLowerCase(),
        )
      )
        return yield* new IssueChangeError({
          code: "forbidden",
          message: "Only a managed thread in this repository can propose issue changes.",
        });
      const prior =
        yield* sql<Row>`SELECT * FROM issue_changes WHERE requesting_thread_id = ${threadId} AND client_request_id = ${input.clientRequestId}`.pipe(
          Effect.mapError(storageError),
        );
      if (prior[0] !== undefined) {
        const existing = yield* fromRow(prior[0]);
        if (
          (yield* encodeOperation(existing.operation)) !==
            (yield* encodeOperation(input.operation)) ||
          existing.host !== input.host ||
          existing.repository !== input.repository
        )
          return yield* invalid(
            "This clientRequestId already belongs to a different immutable proposal.",
          );
        return existing;
      }
      const op = input.operation;
      const number = op.type === "create" ? op.parentNumber : op.number;
      const baseline =
        number === undefined
          ? null
          : yield* issues.readChangeState({ ...input, number }).pipe(Effect.mapError(githubError));
      let childBaseline: ThreadLinkedIssue | null = null;
      if (op.type === "sub_issue") {
        const child = yield* issues
          .workRead({ ...input, number: op.childNumber })
          .pipe(Effect.mapError(githubError));
        if (!child.parentComplete)
          return yield* invalid("The sub-issue's parent could not be verified.");
        if (
          (op.action === "add" && child.parent !== null) ||
          (op.action === "remove" && child.parent?.id !== baseline?.issue.id)
        )
          return yield* invalid("The current parent does not match this hierarchy proposal.");
        childBaseline = child.issue;
      }
      const authored =
        baseline === null
          ? []
          : yield* sql<{
              body: string;
            }>`SELECT body FROM issue_body_baselines WHERE host = ${baseline.issue.host} AND issue_id = ${baseline.issue.id}`.pipe(
              Effect.mapError(storageError),
            );
      const policy = yield* settings.getSettings.pipe(Effect.mapError(storageError));
      const auto =
        !policy.issueUpkeepRequiresApproval && ["create", "split", "milestone"].includes(op.type);
      const change: IssueChange = {
        ...input,
        id: yield* randomUuidV4,
        requestingThreadId: threadId,
        baseline,
        childBaseline,
        diff:
          op.type === "body" && baseline !== null
            ? createPatch(`issue-${op.number}.md`, baseline.body, op.body, "current", "proposed")
            : null,
        t3AuthoredBody: baseline !== null && authored[0]?.body === baseline.body,
        decision: auto ? "auto_approved" : "pending",
        decidedBy: null,
        status: auto ? "queued" : "pending",
        completedSteps: {},
        result: null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      // Proposal and outbox admission commit together; GitHub I/O is always outside this transaction.
      const proposalJson = yield* encodeChange(change).pipe(Effect.mapError(storageError));
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT OR IGNORE INTO issue_changes(change_id, requesting_thread_id, client_request_id, host, repository, issue_number, proposal_json, decision, status)
        VALUES (${change.id}, ${threadId}, ${input.clientRequestId}, ${input.host}, ${input.repository}, ${number ?? null}, ${proposalJson}, ${change.decision}, ${change.status})`;
            const accepted =
              yield* sql<Row>`SELECT * FROM issue_changes WHERE requesting_thread_id = ${threadId} AND client_request_id = ${input.clientRequestId}`;
            if (accepted[0]?.change_id !== change.id) return;
            if (baseline !== null) yield* target(change.id, baseline.issue);
            if (auto) yield* enqueue(change);
          }),
        )
        .pipe(Effect.mapError(storageError));
      yield* outbox.notifyAvailable();
      const accepted =
        yield* sql<Row>`SELECT * FROM issue_changes WHERE requesting_thread_id = ${threadId} AND client_request_id = ${input.clientRequestId}`.pipe(
          Effect.mapError(storageError),
        );
      const result = yield* fromRow(accepted[0]!);
      if ((yield* encodeOperation(result.operation)) !== (yield* encodeOperation(op)))
        return yield* invalid("Concurrent proposal reused clientRequestId with another operation.");
      yield* notify(result);
      return result;
    },
  );

  const decide: IssueChangeService["Service"]["decide"] = Effect.fn("IssueChangeService.decide")(
    function* (input, actor) {
      if (actor.kind !== "user" || !actor.scopes.includes("orchestration:operate"))
        return yield* new IssueChangeError({
          code: "forbidden",
          message: "Only the user with operate scope can decide an issue change.",
        });
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const change = yield* get(input.id);
            if (input.decision === "resolved") {
              if (change.status === "resolved") return;
              if (change.status !== "needs_attention")
                return yield* invalid("Only an unresolved create can be marked resolved.");
              yield* sql`UPDATE issue_changes SET status = 'resolved', decided_by = ${actor.subject}, result = 'Marked resolved by the user. No remaining writes will run.', in_flight_step = NULL WHERE change_id = ${change.id}`;
              return;
            }
            if (input.decision === "retry") {
              if (
                !["approved", "auto_approved"].includes(change.decision) ||
                change.status !== "failed"
              )
                return yield* invalid("Only an approved failed change can be retried.");
              const requeued = yield* sql<{
                effect_id: string;
              }>`UPDATE orchestration_v2_effect_outbox SET status = 'pending', attempt_count = 0, available_at = ${DateTime.formatIso(yield* DateTime.now)}, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
          WHERE effect_id = ${`effect:issue-change:${change.id}`} AND status = 'failed' RETURNING effect_id`;
              if (requeued.length === 0) return;
              yield* sql`UPDATE issue_changes SET status = 'queued', result = NULL WHERE change_id = ${change.id}`;
              return;
            }
            if (change.decision !== "pending") {
              if (input.decision !== change.decision)
                return yield* invalid("This proposal already has a final decision.");
              return;
            }
            yield* sql`UPDATE issue_changes SET decision = ${input.decision}, decided_by = ${actor.subject}, status = ${input.decision === "approved" ? "queued" : "rejected"}, result = ${input.decision === "rejected" ? "Rejected by the user." : null} WHERE change_id = ${input.id} AND decision = 'pending'`;
            if (input.decision === "approved") yield* enqueue(change);
          }),
        )
        .pipe(Effect.mapError((error) => (isChangeError(error) ? error : storageError(error))));
      yield* outbox.notifyAvailable();
      const result = yield* get(input.id);
      yield* notify(result);
      return result;
    },
  );

  const execute: IssueChangeService["Service"]["execute"] = (id) =>
    executionLock.withPermit(
      Effect.gen(function* () {
        const row = yield* rowById(id);
        const change = yield* fromRow(row);
        if (
          !["approved", "auto_approved"].includes(change.decision) ||
          ["succeeded", "conflict", "rejected", "needs_attention", "resolved"].includes(
            change.status,
          )
        )
          return;
        const op = change.operation;
        let steps = change.completedSteps;
        const saveStep = (key: string, issue?: ThreadLinkedIssue, authored?: IssueChangeBaseline) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                steps = { ...steps, [key]: issue === undefined ? {} : { issue } };
                const stepsJson = yield* encodeSteps(steps);
                yield* sql`UPDATE issue_changes SET steps_json = ${stepsJson}, in_flight_step = NULL WHERE change_id = ${id}`;
                if (issue !== undefined) yield* target(id, issue);
                if (authored !== undefined) yield* bodyBaseline(id, authored);
              }),
            )
            .pipe(Effect.mapError(storageError));
        const startStep = (key: string) =>
          sql`UPDATE issue_changes SET status = 'executing', in_flight_step = ${key}, result = NULL WHERE change_id = ${id}`.pipe(
            Effect.asVoid,
            Effect.mapError(storageError),
          );
        const conflict = (message: string) =>
          sql`UPDATE issue_changes SET status = 'conflict', result = ${message} WHERE change_id = ${id}`.pipe(
            Effect.asVoid,
            Effect.mapError(storageError),
          );
        if (change.baseline !== null && steps.write === undefined) {
          const current = yield* issues
            .readChangeState(change.baseline.issue)
            .pipe(Effect.mapError(githubError));
          const expected = change.baseline;
          const recoveredWrite =
            row.in_flight_step === "write" &&
            ((op.type === "body" &&
              current.body === op.body &&
              current.state === expected.state &&
              current.milestoneNumber === expected.milestoneNumber) ||
              (op.type === "state" &&
                current.state === op.state &&
                current.body === expected.body &&
                current.milestoneNumber === expected.milestoneNumber) ||
              (op.type === "milestone" &&
                current.milestoneNumber === op.milestoneNumber &&
                current.body === expected.body &&
                current.state === expected.state));
          if (
            current.issue.id !== expected.issue.id ||
            (!recoveredWrite &&
              (current.body !== expected.body ||
                current.state !== expected.state ||
                current.milestoneNumber !== expected.milestoneNumber))
          )
            return yield* conflict(
              "The issue changed since this preview. Submit a new proposal for approval.",
            );
          if (recoveredWrite)
            yield* saveStep("write", undefined, op.type === "body" ? current : undefined);
        }
        if (op.type === "create" || op.type === "split") {
          const drafts = op.type === "create" ? [op] : op.issues;
          for (let index = 0; index < drafts.length; index++) {
            const key = `create:${index}`;
            let child = steps[key]?.issue;
            if (child === undefined) {
              yield* startStep(key);
              const created = yield* issues
                .createIssue({
                  host: change.host,
                  repository: change.repository,
                  ...drafts[index]!,
                  writeKey: `${id}:${index}`,
                  recover: row.in_flight_step === key,
                  onCreated: (issue) =>
                    saveStep(key, issue, {
                      issue,
                      body: `${drafts[index]!.body}\n\n<!-- t3-issue-change:${id}:${index} -->`,
                      state: "open",
                      milestoneNumber: drafts[index]!.milestoneNumber,
                    }).pipe(
                      Effect.mapError(
                        (error) =>
                          new IssueReadError({
                            code: "upstream",
                            operation: "detail",
                            message: error.message,
                            createOutcome: "uncertain",
                          }),
                      ),
                    ),
                })
                .pipe(Effect.mapError(githubError));
              child = created.issue;
              if (steps[key] === undefined)
                yield* saveStep(key, child, {
                  ...created,
                  body: `${drafts[index]!.body}\n\n<!-- t3-issue-change:${id}:${index} -->`,
                });
            }
            const parent = change.baseline?.issue;
            if (parent !== undefined && steps[`link:${index}`] === undefined) {
              const relation = yield* issues.workRead(child).pipe(Effect.mapError(githubError));
              if (!relation.parentComplete)
                return yield* githubError({
                  message: "The created issue's parent is unavailable.",
                });
              if (relation.parent !== null && relation.parent.id !== parent.id)
                return yield* conflict(
                  "A created issue was reparented externally. Submit a new hierarchy proposal.",
                );
              if (relation.parent === null) {
                yield* startStep(`link:${index}`);
                yield* issues
                  .setSubIssue({ parent, child, action: "add" })
                  .pipe(Effect.mapError(githubError));
              }
              yield* saveStep(`link:${index}`);
            }
          }
        } else if (steps.write === undefined) {
          const baseline = change.baseline!;
          if (op.type === "sub_issue") {
            const current = yield* issues
              .workRead(change.childBaseline!)
              .pipe(Effect.mapError(githubError));
            if (!current.parentComplete || current.issue.id !== change.childBaseline!.id)
              return yield* conflict(
                "The child issue or its parent could not be verified. Submit a new proposal.",
              );
            const applied =
              op.action === "add"
                ? current.parent?.id === baseline.issue.id
                : current.parent === null;
            const expected =
              op.action === "add"
                ? current.parent === null
                : current.parent?.id === baseline.issue.id;
            if (!expected && !(row.in_flight_step === "write" && applied))
              return yield* conflict("The sub-issue's parent changed since this proposal.");
            if (!applied) {
              yield* startStep("write");
              yield* issues
                .setSubIssue({ parent: baseline.issue, child: current.issue, action: op.action })
                .pipe(Effect.mapError(githubError));
            }
          } else {
            yield* startStep("write");
            if (op.type === "body")
              yield* issues
                .updateBody({ ...baseline.issue, body: op.body })
                .pipe(Effect.mapError(githubError));
            if (op.type === "state")
              yield* issues
                .setState({ ...baseline.issue, state: op.state })
                .pipe(Effect.mapError(githubError));
            if (op.type === "milestone")
              yield* issues
                .setMilestone({ ...baseline.issue, milestoneNumber: op.milestoneNumber })
                .pipe(Effect.mapError(githubError));
          }
          yield* saveStep(
            "write",
            undefined,
            op.type === "body" ? { ...baseline, body: op.body } : undefined,
          );
        }
        yield* sql`UPDATE issue_changes SET status = 'succeeded', result = 'GitHub issue change completed.', in_flight_step = NULL WHERE change_id = ${id}`.pipe(
          Effect.mapError(storageError),
        );
      }).pipe(
        Effect.tap(() => get(id).pipe(Effect.flatMap(notify))),
        Effect.tapError((error) =>
          sql`UPDATE issue_changes SET status = ${error.createOutcome === "unresolved" ? "needs_attention" : "failed"}, result = ${error.message}, in_flight_step = CASE WHEN ${error.createOutcome === "rejected" ? 1 : 0} THEN NULL ELSE in_flight_step END WHERE change_id = ${id}`.pipe(
            Effect.andThen(get(id)),
            Effect.flatMap(notify),
            Effect.catch(() => Effect.void),
          ),
        ),
      ),
    );

  return IssueChangeService.of({
    propose,
    decide,
    execute,
    subscribe: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(updates);
          return Stream.concat(
            Stream.make(revision),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) =>
                "threadId" in input
                  ? event.threadId === input.threadId
                  : event.host === input.host.toLowerCase() &&
                    event.repository === input.repository.toLowerCase() &&
                    event.numbers.includes(input.number),
              ),
              Stream.map((event) => event.revision),
            ),
          );
        }),
      ),
    list: (input) =>
      ("threadId" in input
        ? sql<Row>`SELECT * FROM issue_changes WHERE requesting_thread_id = ${input.threadId} ORDER BY decision = 'pending' DESC, rowid DESC LIMIT 100`
        : sql<Row>`SELECT change.* FROM issue_changes change JOIN issue_change_targets target ON target.change_id = change.change_id WHERE target.host = ${input.host.toLowerCase()} AND target.repository = ${input.repository.toLowerCase()} AND target.issue_number = ${input.number} ORDER BY change.decision = 'pending' DESC, change.rowid DESC LIMIT 100`
      ).pipe(
        Effect.mapError(storageError),
        Effect.flatMap((rows) => Effect.forEach(rows, fromRow)),
      ),
  });
});
export const layer = Layer.effect(IssueChangeService, make);
