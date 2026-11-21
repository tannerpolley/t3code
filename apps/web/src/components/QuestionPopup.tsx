import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { MessageCircleQuestionIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useClientSettings } from "../hooks/useSettings";
import { useProject, useThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { ComposerBanner } from "./chat/ComposerBanner";
import { PendingQuestionForm } from "./PendingQuestionForm";
import {
  collectPendingQuestions,
  visibleQuestionQueue,
  type PendingQuestion,
} from "./QuestionPopup.logic";
import { Button } from "./ui/button";
import { useSettledQuestions } from "./useSettledQuestions";

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
  const questions = useSettledQuestions(useAtomValue(pendingQuestionsAtom));
  const { environmentId, threadId } = useParams({ strict: false });
  // Later and Close put questions off for this session; a new question has a new key.
  const [deferredKeys, setDeferredKeys] = useState<ReadonlySet<string>>(() => new Set());
  const queue = visibleQuestionQueue(questions, deferredKeys, { environmentId, threadId });
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
  const navigate = useNavigate();
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
      <ComposerBanner.Root density="spacious" className="shadow-xl">
        <div className="flex items-start gap-2 px-1 pb-2">
          <MessageCircleQuestionIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
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
        <PendingQuestionForm
          environmentId={environmentId}
          threadId={threadId}
          requestId={requestId}
        >
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
        </PendingQuestionForm>
      </ComposerBanner.Root>
    </div>
  );
}
