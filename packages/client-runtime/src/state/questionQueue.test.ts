import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { collectPendingQuestions, deferQuestions, visibleQuestionQueue } from "./questionQueue.ts";

function shell(id: string, minute: number, requestId = id) {
  return {
    id: ThreadId.make(id),
    archivedAt: null,
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(requestId),
      kind: "user_input" as const,
      createdAt: DateTime.makeUnsafe(`2026-11-25T10:0${minute}:00Z`),
    },
  };
}

it("defers the head with Later and the visible queue with Close across environments", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const viewed = shell("same-thread", 0);
  const first = shell("same-thread", 1);
  const second = shell("second", 2);
  const sideChat = shell("side-chat", 3);
  const archived = shell("archived", 0);
  const secret = shell("secret", 0);
  const approval = shell("approval", 0);
  const questions = collectPendingQuestions([
    {
      environmentId: local,
      threads: [
        second,
        viewed,
        sideChat,
        { ...archived, archivedAt: archived.pendingRuntimeRequest.createdAt },
        { ...secret, pendingRuntimeRequest: { ...secret.pendingRuntimeRequest, userOnly: true } },
        {
          ...approval,
          pendingRuntimeRequest: { ...approval.pendingRuntimeRequest, kind: "command" },
        },
      ],
    },
    { environmentId: remote, threads: [first] },
  ]);
  const shown = { environmentId: local, threadId: viewed.id };
  const shownSide = { environmentId: local, threadId: sideChat.id };
  const initial = new Set<string>();
  const queue = visibleQuestionQueue(questions, initial, shown, shownSide);
  expect(queue.map(({ thread }) => thread)).toEqual([
    { environmentId: remote, threadId: first.id },
    { environmentId: local, threadId: second.id },
  ]);
  const later = deferQuestions(initial, queue, "later");
  const remaining = visibleQuestionQueue(questions, later, shown, shownSide);
  expect(remaining).toEqual(queue.slice(1));
  const closed = deferQuestions(later, remaining, "close");
  expect(visibleQuestionQueue(questions, closed, shown, shownSide)).toEqual([]);
  expect(visibleQuestionQueue(questions, closed, null, null).map(({ thread }) => thread)).toEqual([
    shown,
    shownSide,
  ]);

  const updated = collectPendingQuestions([
    { environmentId: local, threads: [second] },
    { environmentId: remote, threads: [shell("same-thread", 4, "new-request")] },
  ]);
  expect(
    visibleQuestionQueue(updated, closed, null, null).map(({ requestId }) => requestId),
  ).toEqual(["new-request"]);
});
