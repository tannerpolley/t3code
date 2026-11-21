import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useRef, useState, type ReactNode } from "react";

import { derivePendingUserInputProgress } from "../pendingUserInput";
import { useProject, useThreadShell } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function PendingQuestionForm({
  environmentId,
  threadId,
  requestId,
  children,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  requestId: RuntimeRequestId;
  children?: ReactNode;
}) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const thread = useThreadShell(threadRef);
  const project = useProject(thread ? scopeProjectRef(environmentId, thread.projectId) : null);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(threadRef));
  const prompt = requests?.userInputs.find((input) => input.requestId === requestId) ?? null;
  // The same commands the thread's own question card sends.
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, "answer question");
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, "dismiss question");
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [responding, setResponding] = useState(false);
  const inFlight = useRef(false);

  const onToggleOption = (questionId: string, optionValue: string) => {
    const entry = prompt?.questions.find((candidate) => candidate.id === questionId);
    if (!entry) return;
    setAnswers((existing) => ({
      ...existing,
      [questionId]: togglePendingUserInputOptionSelection(entry, existing[questionId], optionValue),
    }));
  };
  const onDismiss = (id: RuntimeRequestId) => {
    if (!canOperate || !prompt) return;
    void dismiss({ environmentId, input: { threadId, requestId: id } });
  };

  // Until the thread's detail brings the question, the header and controls still show,
  // so a question that cannot load never blocks the ones behind it.
  const canRespond = canOperate && prompt !== null && prompt.responseCapability !== "not_resumable";
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

  if (!prompt && !children) return null;
  return (
    <>
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
                activeQuestion,
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
        {children}
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
    </>
  );
}
