import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2UserInputQuestion,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const DONT_ASK_NOTE =
  "The user is away (Don't ask mode). Choose the option you'd recommend, continue, and list the decisions you made in your final message.";

/**
 * Each question's first option (the agent's recommendation by convention),
 * then a blank line and the note. Dialogs that decode a label read the text
 * before the first blank line.
 */
export function dontAskAnswers(
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
): Record<string, string> {
  return Object.fromEntries(
    questions.map((question) => {
      const first = question.options[0];
      return [
        question.id,
        first === undefined ? DONT_ASK_NOTE : `${first.value ?? first.label}\n\n${DONT_ASK_NOTE}`,
      ];
    }),
  );
}

/**
 * The answer Don't ask mode gives one request: approve once, or answer each
 * question with `dontAskAnswers`. Null when the request is not pending, cannot
 * be answered, or its turn item has not been committed yet (adapters commit
 * request and item separately).
 */
export function dontAskResponse(
  threadId: ThreadId,
  { request, item }: ProjectionStore.ProjectionRuntimeResponseContext,
): Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }> | null {
  if (request?.status !== "pending" || request.responseCapability.type === "not_resumable") {
    return null;
  }
  const command = {
    type: "runtime-request.respond",
    // Stable per request, so the event reactor and the switch-on sweep answer it once.
    commandId: CommandId.make(`dont-ask:${threadId}:${request.id}`),
    threadId,
    requestId: request.id,
    respondedBy: "dont_ask_mode",
  } as const;
  if (request.kind === "user_input") {
    if (item?.type !== "user_input_request") return null;
    return { ...command, answers: dontAskAnswers(item.questions) };
  }
  if (request.kind === "dynamic_tool_call" || request.kind === "auth_refresh") return null;
  if (item?.type !== "approval_request") return null;
  return { ...command, decision: "accept" };
}

/** Answers requests through the same respond command as the UI, while `dontAskMode` is on. */
export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  const isOn = settings.getDontAskMode.pipe(Effect.orElseSucceed(() => false));
  const respond = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    projections.getRuntimeResponseContext(threadId, requestId).pipe(
      Effect.flatMap((context) => {
        const command = dontAskResponse(threadId, context);
        // Re-read the setting right before each answer, so switching off stops
        // a running sweep and a sweep left over from an earlier switch-on.
        return command === null ? Effect.void : Effect.when(orchestrator.dispatch(command), isOn);
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Don't ask mode could not answer a request", {
          threadId,
          requestId,
          cause,
        }),
      ),
    );
  /** Answers the request a committed event announces, if the mode is on. */
  const handle = (event: OrchestrationV2DomainEvent) => {
    const requestId =
      event.type === "runtime-request.updated" && event.payload.status === "pending"
        ? event.payload.id
        : event.type === "turn-item.updated" &&
            (event.payload.type === "user_input_request" ||
              event.payload.type === "approval_request") &&
            event.payload.completedAt === null
          ? event.payload.requestId
          : undefined;
    return requestId === undefined
      ? Effect.void
      : Effect.when(respond(event.threadId, requestId), isOn).pipe(Effect.asVoid);
  };
  /** Answers every request waiting in any thread. */
  const sweep = Effect.gen(function* () {
    for (const threadId of yield* projections.getRecoveryThreadIds("pending-requests")) {
      const { runtimeRequests } = yield* projections.getThreadRecords(threadId, [
        "runtimeRequests",
      ]);
      for (const request of runtimeRequests) {
        if (request.status === "pending") yield* respond(threadId, request.id);
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Don't ask mode could not sweep pending requests", { cause }),
    ),
  );
  return { isOn, handle, sweep } as const;
});

// Reacts to each committed request or request item, and sweeps whenever the
// setting turns on, so waiting agents resume at once. The startup sweep only
// finds requests that survive a restart (message-answered questions); native
// provider requests left waiting are expired by runtime recovery instead.
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { isOn, handle, sweep } = yield* make;
    const sink = yield* EventSink.EventSinkV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    // Subscribe before parking so nothing committed meanwhile is missed.
    const changes = yield* settings.subscribeChanges;
    const afterSequence = yield* sink.latestSequence().pipe(Effect.orDie);
    yield* forkParked(
      Effect.gen(function* () {
        yield* Stream.merge(
          sink.stream({ afterSequence, eventType: "runtime-request.updated" }),
          sink.stream({ afterSequence, eventType: "turn-item.updated" }),
        ).pipe(
          Stream.runForEach(({ event }) => handle(event)),
          Effect.forkScoped,
        );
        let on = yield* isOn;
        if (on) yield* sweep;
        yield* changes.pipe(
          Stream.runForEach((next) => {
            const turnedOn = next.dontAskMode && !on;
            on = next.dontAskMode;
            return turnedOn ? sweep : Effect.void;
          }),
        );
      }),
    );
  }),
);
