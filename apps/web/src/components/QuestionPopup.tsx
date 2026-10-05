import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { RuntimeRequestId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Atom } from "effect/unstable/reactivity";
import { MessageCircleQuestionIcon, XIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useClientSettings } from "../hooks/useSettings";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { derivePendingUserInputs } from "../session-logic";
import { useProject, useThreadShell } from "../state/entities";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { ComposerBanner } from "./chat/ComposerBanner";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import {
  collectPendingQuestions,
  visibleQuestionQueue,
  type PendingQuestion,
} from "./QuestionPopup.logic";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

let previousQuestions: ReadonlyArray<PendingQuestion> = [];
// Reads the shells the sidebar already holds; only the shown question loads its thread.
const pendingQuestionsAtom = Atom.make((get) => {
  const next = collectPendingQuestions(
    Array.from(
      enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom)),
      (environmentId) => ({
        environmentId,
        threads: get(threadEnvironment.snapshotAtom(environmentId))?.threads ?? [],
      }),
    ),
  );
  if (
    next.length === previousQuestions.length &&
    next.every((question, index) => question.key === previousQuestions[index]?.key)
  ) {
    return previousQuestions;
  }
  previousQuestions = next;
  return previousQuestions;
}).pipe(Atom.withLabel("web-pending-questions"));

/** Floating answer panel for questions from any thread, behind the Open questions automatically setting. */
export function QuestionPopup() {
  const enabled = useClientSettings((settings) => settings.openQuestionsAutomatically);
  return enabled ? <QuestionPopupQueue /> : null;
}

function QuestionPopupQueue() {
  const questions = useAtomValue(pendingQuestionsAtom);
  const { environmentId, threadId } = useParams({ strict: false });
  // Later and Close put questions off for this session; a new question has a new key.
  const [deferredKeys, setDeferredKeys] = useState<ReadonlySet<string>>(() => new Set());
  const queue = useMemo(
    () => visibleQuestionQueue(questions, deferredKeys, { environmentId, threadId }),
    [deferredKeys, environmentId, questions, threadId],
  );
  const head = queue[0];
  if (!head) return null;
  const defer = (keys: ReadonlyArray<string>) =>
    setDeferredKeys((existing) => new Set([...existing, ...keys]));
  return (
    <QuestionPopupCard
      key={head.key}
      question={head}
      total={queue.length}
      onLater={() => defer([head.key])}
      onClose={() => defer(queue.map((question) => question.key))}
    />
  );
}

function QuestionPopupCard({
  question,
  total,
  onLater,
  onClose,
}: {
  question: PendingQuestion;
  total: number;
  onLater: () => void;
  onClose: () => void;
}) {
  const { environmentId, threadId, requestId } = question;
  const threadRef = scopeThreadRef(environmentId, threadId);
  const thread = useThreadShell(threadRef);
  const project = useProject(thread ? scopeProjectRef(environmentId, thread.projectId) : null);
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(threadRef));
  const prompt = useMemo(
    () =>
      derivePendingUserInputs(requests?.userInputs ?? []).find(
        (input) => input.requestId === requestId,
      ) ?? null,
    [requests, requestId],
  );
  const navigate = useNavigate();
  // The same commands the thread's own question card sends.
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, "answer question");
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, "dismiss question");
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [responding, setResponding] = useState(false);
  const inFlight = useRef(false);

  const onToggleOption = useCallback(
    (questionId: string, optionValue: string) => {
      const entry = prompt?.questions.find((candidate) => candidate.id === questionId);
      if (!entry) return;
      setAnswers((existing) => ({
        ...existing,
        [questionId]: togglePendingUserInputOptionSelection(
          entry,
          existing[questionId],
          optionValue,
        ),
      }));
    },
    [prompt],
  );
  const onDismiss = useCallback(
    (id: RuntimeRequestId) => {
      void dismiss({ environmentId, input: { threadId, requestId: id } });
    },
    [dismiss, environmentId, threadId],
  );

  // Until the thread's detail brings the question, the header and controls still show,
  // so a question that cannot load never blocks the ones behind it.
  const canRespond = prompt !== null && prompt.responseCapability !== "not_resumable";
  const progress = prompt
    ? derivePendingUserInputProgress(prompt.questions, answers, questionIndex)
    : null;
  const activeQuestion = progress?.activeQuestion ?? null;

  const onAdvance = () => {
    if (!prompt || !progress || !canRespond || !progress.canAdvance || inFlight.current) return;
    if (!progress.isLastQuestion) {
      setQuestionIndex(progress.questionIndex + 1);
      return;
    }
    const resolved = buildPendingUserInputAnswers(prompt.questions, answers);
    if (!resolved) return;
    inFlight.current = true;
    setResponding(true);
    void respond({ environmentId, input: { threadId, requestId, answers: resolved } }).finally(
      () => {
        inFlight.current = false;
        setResponding(false);
      },
    );
  };

  return (
    <div
      data-question-popup
      role="dialog"
      aria-label="Question from an agent"
      className="fixed right-4 bottom-4 z-40 w-[min(26rem,calc(100vw-2rem))]"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <ComposerBanner.Root placement="floating" density="spacious" className="shadow-xl">
        <div className="flex items-start gap-2 px-1 pb-2">
          <MessageCircleQuestionIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-info"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{thread?.title ?? "Thread"}</div>
            {project ? (
              <div className="truncate text-muted-foreground text-xs">{project.title}</div>
            ) : null}
          </div>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">1 of {total}</span>
          <Button size="icon-xs" variant="ghost" aria-label="Close questions" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        {prompt ? (
          <ComposerPendingUserInputPanel
            pendingUserInputs={[prompt]}
            respondingRequestIds={responding || !canRespond ? [requestId] : []}
            answers={answers}
            questionIndex={questionIndex}
            onToggleOption={onToggleOption}
            onAdvance={onAdvance}
            onDismiss={onDismiss}
            keyboardShortcuts={false}
          />
        ) : null}
        {progress && activeQuestion && activeQuestion.allowCustomAnswer !== false ? (
          <Textarea
            className="mt-2"
            rows={2}
            placeholder="Or type your own answer"
            aria-label="Your own answer"
            value={progress.customAnswer}
            disabled={responding || !canRespond}
            onChange={(event) => {
              const value = event.target.value;
              setAnswers((existing) => ({
                ...existing,
                [activeQuestion.id]: setPendingUserInputCustomAnswer(
                  existing[activeQuestion.id],
                  value,
                ),
              }));
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              onAdvance();
            }}
          />
        ) : null}
        <div className="mt-2 flex items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId },
              })
            }
          >
            Open thread
          </Button>
          <Button size="xs" variant="ghost" onClick={onLater}>
            Later
          </Button>
          <span className="flex-1" />
          {progress && progress.questionIndex > 0 ? (
            <Button
              size="xs"
              variant="outline"
              disabled={responding}
              onClick={() => setQuestionIndex(progress.questionIndex - 1)}
            >
              Back
            </Button>
          ) : null}
          <Button
            size="xs"
            disabled={responding || !canRespond || !progress?.canAdvance}
            onClick={onAdvance}
          >
            {progress?.isLastQuestion === false ? "Next" : "Submit"}
          </Button>
        </div>
      </ComposerBanner.Root>
    </div>
  );
}
