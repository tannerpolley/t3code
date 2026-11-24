import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act, fakeTimers, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
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
function Queue({ questions }: { questions: ReadonlyArray<PendingQuestion> }) {
  return (
    <output>
      {useSettledQuestions(questions)
        .map((question) => question.key)
        .join(",")}
    </output>
  );
}

it("opens a routed question once it stays visible for three seconds", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(0);
  await using screen = await render(<Queue questions={[routed]} />);
  expect(screen.container.textContent).toBe("");
  await act(() => vi.advanceTimersByTime(2_999));
  expect(screen.container.textContent).toBe("");
  await act(() => vi.advanceTimersByTime(1));
  expect(screen.container.textContent).toBe(routed.key);
  await act(() => vi.advanceTimersByTime(10_000));
  expect(screen.container.textContent).toBe(routed.key);
  expect(vi.getTimerCount()).toBe(0);
});
it("cancels a brief appearance and requires a fresh continuous window", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(0);
  await using screen = await render(<Queue questions={[routed]} />);
  await act(() => vi.advanceTimersByTime(1_000));
  await screen.rerender(<Queue questions={[]} />);
  await act(() => vi.advanceTimersByTime(3_000));
  expect(screen.container.textContent).toBe("");
  await screen.rerender(<Queue questions={[routed]} />);
  await act(() => vi.advanceTimersByTime(2_999));
  expect(screen.container.textContent).toBe("");
  await act(() => vi.advanceTimersByTime(1));
  expect(screen.container.textContent).toBe(routed.key);
});
it("opens an unrouted question immediately", async () => {
  const { routedTo: _parent, ...question } = routed;
  using _timers = fakeTimers();
  vi.setSystemTime(0);
  await using screen = await render(<Queue questions={[question]} />);
  expect(screen.container.textContent).toBe(question.key);
  expect(vi.getTimerCount()).toBe(0);
});
