import type {
  IssueChange,
  OrchestrationV2DomainEvent,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as IssueChangeService from "./IssueChangeService.ts";
import {
  isIssueChangeQuestion,
  issueChangeIdOfQuestion,
  issueChangeQuestion,
  issueChangeQuestionCommandId,
  issueChangeQuestionRequestId,
} from "./IssueChangeQuestion.ts";

const afterAsking =
  "The owner is being asked in this thread; do not ask them yourself. Their answer arrives here as a message and the server applies it. Proposing again with the same clientRequestId returns the current status.";
const withoutAsking =
  "The owner decides this change on the Issues page; do not ask them yourself. Proposing again with the same clientRequestId returns the current status.";

/**
 * Asks the owner about a pending change in the requesting thread, without
 * waiting, and returns the change with what the proposing agent should know.
 * The question outlives the agent's turn; `workerLive` applies the answer.
 * A change is asked about once, however often it is proposed.
 */
export const askOwner = (
  services: {
    readonly threads: ThreadManagementService.ThreadManagementService["Service"];
    readonly changes: IssueChangeService.IssueChangeService["Service"];
  },
  change: IssueChange,
  caller: { readonly threadId: ThreadId; readonly providerSessionId: string },
) =>
  Effect.gen(function* () {
    const { threads, changes } = services;
    const shell = yield* threads.getThreadShell(caller.threadId);
    if (shell?.activeRunId == null) return false;
    const asked = yield* threads.askUser({
      thread: { ...shell, activeRunId: shell.activeRunId },
      mcpCredentialId: caller.providerSessionId,
      commandId: issueChangeQuestionCommandId(change.id),
      questions: [issueChangeQuestion(change)],
    });
    if (asked) yield* changes.recordQuestion(change.id, issueChangeQuestionRequestId(change.id));
    return asked;
  }).pipe(
    // The change stays pending and decidable on the Issues page.
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not ask about an issue change", { changeId: change.id, cause }).pipe(
        Effect.as(false),
      ),
    ),
    Effect.map((asked) => ({ ...change, result: asked ? afterAsking : withoutAsking })),
  );

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const changes = yield* IssueChangeService.IssueChangeService;
  /** Applies a question's answer; a dismissed or open question leaves the change pending. */
  const apply = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    Effect.gen(function* () {
      const changeId = issueChangeIdOfQuestion(requestId);
      if (changeId === undefined) return;
      const { request, item } = yield* projections.getRuntimeResponseContext(threadId, requestId);
      if (request?.status !== "resolved" || request.answers === undefined) return;
      yield* changes.applyAnswer(changeId, {
        answers: request.answers,
        respondedBy: item?.type === "user_input_request" ? item.respondedBy : undefined,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not apply an issue change answer", { requestId, cause }),
      ),
    );
  const handle = (event: OrchestrationV2DomainEvent) =>
    event.type === "runtime-request.updated" &&
    event.payload.status === "resolved" &&
    isIssueChangeQuestion(event.payload.id)
      ? apply(event.threadId, event.payload.id)
      : Effect.void;
  /** Applies answers committed while no worker was listening, such as before a restart. */
  const sweep = changes.awaitingAnswer.pipe(
    Effect.flatMap((questions) =>
      Effect.forEach(questions, (question) => apply(question.threadId, question.requestId), {
        discard: true,
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not sweep issue change answers", { cause }),
    ),
  );
  return { handle, sweep } as const;
});

/** Applies each issue change answer as it commits, after sweeping for any it missed. */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { handle, sweep } = yield* make;
    const sink = yield* EventSink.EventSinkV2;
    // Subscribe before sweeping so nothing committed in between is missed.
    const afterSequence = yield* sink.latestSequence().pipe(Effect.orDie);
    yield* forkParked(
      Effect.gen(function* () {
        yield* sink.stream({ afterSequence, eventType: "runtime-request.updated" }).pipe(
          Stream.runForEach(({ event }) => handle(event)),
          Effect.forkScoped,
        );
        yield* sweep;
      }),
    );
  }),
);
