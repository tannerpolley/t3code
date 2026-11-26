import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { seedUserInputDraftAnswers } from "@t3tools/client-runtime/state/thread-requests";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { MessageCircleQuestionIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useClientSettings } from "../hooks/useSettings";
import { derivePendingUserInputProgress } from "../pendingUserInput";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useProject, useThreadShell } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { ComposerBanner } from "./chat/ComposerBanner";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  createPendingQuestionsAtom,
  deferQuestions,
  visibleQuestionQueue,
  type PendingQuestion,
} from "@t3tools/client-runtime/state/question-queue";

const pendingQuestionsAtom = createPendingQuestionsAtom(
  environmentCatalog.catalogValueAtom,
  threadEnvironment.snapshotAtom,
);

export function QuestionPopup({ shownThread }: { shownThread: ScopedThreadRef | null }) {
  const enabled = useClientSettings((settings) => settings.openQuestionsAutomatically);
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => new Set());
  if (!enabled) return null;
  return (
    <QuestionPopupQueue
      shownThread={shownThread}
      deferred={deferred}
      onDefer={(queue, action) =>
        setDeferred((existing) => deferQuestions(existing, queue, action))
      }
    />
  );
}

function QuestionPopupQueue({
  shownThread,
  deferred,
  onDefer,
}: {
  shownThread: ScopedThreadRef | null;
  deferred: ReadonlySet<string>;
  onDefer: (queue: ReadonlyArray<PendingQuestion>, action: "later" | "close") => void;
}) {
  const questions = useAtomValue(pendingQuestionsAtom);
  const sideThreadId = useRightPanelStore((state) => {
    const active = selectActiveRightPanelSurface(state.byThreadKey, shownThread);
    return active?.kind === "thread" ? active.threadId : null;
  });
  const shownSideThread =
    shownThread && sideThreadId
      ? { environmentId: shownThread.environmentId, threadId: sideThreadId }
      : null;
  const queue = visibleQuestionQueue(questions, deferred, shownThread, shownSideThread);
  const head = queue[0];
  if (!head) return null;
  return (
    <QuestionPopupCard
      key={head.key}
      question={head}
      total={queue.length}
      onLater={() => onDefer(queue, "later")}
      onClose={() => onDefer(queue, "close")}
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
  const gt = useGT();
  const m = useMessages();
  const { thread: threadRef, requestId } = question;
  const { environmentId, threadId } = threadRef;
  const thread = useThreadShell(threadRef);
  const project = useProject(thread ? scopeProjectRef(environmentId, thread.projectId) : null);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(threadRef));
  const prompt = requests?.userInputs.find((input) => input.requestId === requestId);
  const respond = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismiss = useOrchestrationCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const responseInFlight = useRef(false);

  const answers = prompt ? seedUserInputDraftAnswers(prompt.questions, draft) : draft;
  const progress = prompt
    ? derivePendingUserInputProgress(prompt.questions, answers, questionIndex)
    : null;
  const activeQuestion = progress?.activeQuestion;
  const canRespond =
    canOperate && prompt !== undefined && prompt.responseCapability !== "not_resumable";

  const runResponse = async (send: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (responseInFlight.current) return;
    responseInFlight.current = true;
    setResponding(true);
    setError(null);
    const result = await send();
    responseInFlight.current = false;
    setResponding(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(
        thrownErrorMessage(squashAtomCommandFailure(result), m) ??
          gt("Failed to submit user input."),
      );
    }
  };

  const advance = () => {
    if (!prompt || !progress?.canAdvance || !canRespond || responseInFlight.current) return;
    if (!progress.isLastQuestion) {
      setQuestionIndex(progress.questionIndex + 1);
      return;
    }
    const resolved = buildPendingUserInputAnswers(prompt.questions, answers);
    if (resolved) {
      void runResponse(() =>
        respond({ environmentId, input: { threadId, requestId, answers: resolved } }),
      );
    }
  };

  return (
    <div
      data-question-popup
      role="dialog"
      aria-label={gt("Question from an agent")}
      className="fixed right-4 bottom-4 z-40 w-[min(26rem,calc(100vw-2rem))]"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.stopPropagation();
        onClose();
      }}
    >
      <ComposerBanner.Root density="spacious" detached>
        <div className="flex items-start gap-2 px-1 pb-2">
          <MessageCircleQuestionIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{thread?.title ?? gt("Thread")}</div>
            {project ? (
              <div className="truncate text-xs text-muted-foreground">{project.title}</div>
            ) : null}
          </div>
          {total > 1 ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {gt("1 of {total}", { total })}
            </span>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Close questions")}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        <div className="max-h-[65dvh] overflow-y-auto">
          {prompt ? (
            <ComposerPendingUserInputPanel
              pendingUserInputs={[prompt]}
              cwd={
                project
                  ? projectScriptCwd({
                      project: { cwd: project.workspaceRoot },
                      worktreePath: thread?.worktreePath ?? null,
                    })
                  : undefined
              }
              threadRef={threadRef}
              disabled={!canOperate}
              keyboardShortcuts={false}
              respondingRequestIds={responding ? [requestId] : []}
              answers={answers}
              questionIndex={questionIndex}
              onToggleOption={(questionId, optionValue) => {
                const entry = prompt.questions.find((candidate) => candidate.id === questionId);
                if (!entry) return;
                setDraft((existing) => ({
                  ...existing,
                  [questionId]: togglePendingUserInputOptionSelection(
                    entry,
                    existing[questionId],
                    optionValue,
                  ),
                }));
              }}
              onAdvance={advance}
              onDismiss={(id) => {
                if (!canOperate || !prompt.dismissible || id !== requestId) return;
                void runResponse(() => dismiss({ environmentId, input: { threadId, requestId } }));
              }}
            />
          ) : null}
          {progress && activeQuestion && activeQuestion.allowCustomAnswer !== false ? (
            <div className="mt-2">
              <Textarea
                rows={2}
                placeholder={gt("Or type your own answer")}
                aria-label={gt("Your own answer")}
                value={progress.customAnswer}
                disabled={responding || !canRespond}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((existing) => ({
                    ...existing,
                    [activeQuestion.id]: setPendingUserInputCustomAnswer(
                      activeQuestion,
                      existing[activeQuestion.id],
                      value,
                    ),
                  }));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  advance();
                }}
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            render={<Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />}
          >
            <T>Open thread</T>
          </Button>
          <Button size="xs" variant="ghost" onClick={onLater}>
            <T>Later</T>
          </Button>
          <span className="flex-1" />
          {progress && progress.questionIndex > 0 ? (
            <Button
              size="xs"
              variant="outline"
              disabled={responding}
              onClick={() => setQuestionIndex(progress.questionIndex - 1)}
            >
              <T>Back</T>
            </Button>
          ) : null}
          {progress ? (
            <Button
              size="xs"
              disabled={responding || !canRespond || !progress.canAdvance}
              onClick={advance}
            >
              {progress.isLastQuestion ? gt("Submit") : gt("Next")}
            </Button>
          ) : null}
        </div>
      </ComposerBanner.Root>
    </div>
  );
}
