import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { collectPendingQuestions, visibleQuestionQueue } from "./QuestionPopup.logic";

function thread(
  id: string,
  request: { kind: "user_input" | "command"; at: string } | null,
  archived = false,
) {
  return {
    id: ThreadId.make(id),
    archivedAt: archived ? DateTime.makeUnsafe("2026-09-30T00:00:00Z") : null,
    pendingRuntimeRequest: request
      ? {
          id: RuntimeRequestId.make(`request-${id}`),
          kind: request.kind,
          createdAt: DateTime.makeUnsafe(request.at),
        }
      : null,
  };
}

const one = EnvironmentId.make("one");
const two = EnvironmentId.make("two");

describe("question popup queue", () => {
  it("lists pending questions across environments oldest first, skipping settled questions, approvals and archived threads", () => {
    const questions = collectPendingQuestions([
      {
        environmentId: one,
        threads: [
          thread("late", { kind: "user_input", at: "2026-09-30T10:05:00Z" }),
          thread("approval", { kind: "command", at: "2026-09-30T10:00:00Z" }),
          thread("archived", { kind: "user_input", at: "2026-09-30T09:00:00Z" }, true),
          thread("idle", null),
        ],
      },
      {
        environmentId: two,
        threads: [thread("early", { kind: "user_input", at: "2026-09-30T10:01:00Z" })],
      },
    ]);
    expect(questions.map((question) => [question.environmentId, question.threadId])).toEqual([
      [two, "early"],
      [one, "late"],
    ]);
  });

  it("hides deferred questions and the open thread's question, and shows a new question again", () => {
    const [first, second] = collectPendingQuestions([
      {
        environmentId: one,
        threads: [
          thread("a", { kind: "user_input", at: "2026-09-30T10:00:00Z" }),
          thread("b", { kind: "user_input", at: "2026-09-30T10:01:00Z" }),
        ],
      },
    ]);
    const deferred = new Set([first!.key]);
    expect(visibleQuestionQueue([first!, second!], deferred, {})).toEqual([second]);
    expect(
      visibleQuestionQueue([first!, second!], new Set(), { environmentId: one, threadId: "b" }),
    ).toEqual([first]);
    // The same thread asking again brings a new request id, so Later no longer hides it.
    const askedAgain = collectPendingQuestions([
      {
        environmentId: one,
        threads: [
          {
            ...thread("a", { kind: "user_input", at: "2026-09-30T10:02:00Z" }),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-a-2"),
              kind: "user_input" as const,
              createdAt: DateTime.makeUnsafe("2026-09-30T10:02:00Z"),
            },
          },
        ],
      },
    ]);
    expect(visibleQuestionQueue(askedAgain, deferred, {})).toEqual(askedAgain);
  });
});
