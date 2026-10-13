import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { PendingQuestion } from "./QuestionPopup.logic";
import { useSettledQuestions } from "./useSettledQuestions";

const routed: PendingQuestion = {
  key: "child-question",
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("child"),
  requestId: RuntimeRequestId.make("request"),
  createdAt: 0,
  routedTo: ThreadId.make("parent"),
};
let renderer: ReactTestRenderer | undefined;
let shown: ReadonlyArray<PendingQuestion> = [];
function Queue({ questions }: { questions: ReadonlyArray<PendingQuestion> }) {
  const settled = useSettledQuestions(questions);
  useEffect(() => {
    shown = settled;
  }, [settled]);
  return null;
}
async function render(questions: ReadonlyArray<PendingQuestion>) {
  await act(() => {
    if (renderer) renderer.update(<Queue questions={questions} />);
    else renderer = create(<Queue questions={questions} />);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("opens a routed question once it stays visible for three seconds", async () => {
  await render([routed]);
  expect(shown).toEqual([]);
  await act(() => vi.advanceTimersByTime(2_999));
  expect(shown).toEqual([]);
  await act(() => vi.advanceTimersByTime(1));
  expect(shown).toEqual([routed]);
  await act(() => vi.advanceTimersByTime(10_000));
  expect(shown).toEqual([routed]);
  expect(vi.getTimerCount()).toBe(0);
});
it("cancels a brief appearance and requires a fresh continuous window", async () => {
  await render([routed]);
  await act(() => vi.advanceTimersByTime(1_000));
  await render([]);
  await act(() => vi.advanceTimersByTime(3_000));
  expect(shown).toEqual([]);
  await render([routed]);
  await act(() => vi.advanceTimersByTime(2_999));
  expect(shown).toEqual([]);
  await act(() => vi.advanceTimersByTime(1));
  expect(shown).toEqual([routed]);
});
it("opens an unrouted question immediately", async () => {
  const { routedTo: _parent, ...question } = routed;
  await render([question]);
  expect(shown).toEqual([question]);
  expect(vi.getTimerCount()).toBe(0);
});
