import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  createPendingQuestionsAtom,
  deferQuestions,
  visibleQuestionQueue,
  type PendingQuestion,
} from "@t3tools/client-runtime/state/question-queue";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { seedUserInputDraftAnswers } from "@t3tools/client-runtime/state/thread-requests";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { OverlayPortal } from "../../components/ui/OverlayPortal";
import { environmentCatalog } from "../../connection/catalog";
import { cn } from "../../lib/cn";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

const pendingQuestionsAtom = createPendingQuestionsAtom(
  environmentCatalog.catalogValueAtom,
  threadEnvironment.snapshotAtom,
);

export function BackgroundQuestionPopup(props: { readonly shownThread: ScopedThreadRef | null }) {
  const selectDetail = useSelectWorkspaceDetail();
  const questions = useAtomValue(pendingQuestionsAtom);
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => new Set());
  const queue = visibleQuestionQueue(questions, deferred, props.shownThread, null);
  const head = queue[0];
  if (!head) return null;
  return (
    <OverlayPortal>
      <QuestionPopupCard
        key={head.key}
        question={head}
        total={queue.length}
        onOpenThread={() =>
          selectDetail({
            name: "Thread",
            params: { environmentId: head.thread.environmentId, threadId: head.thread.threadId },
          })
        }
        onLater={() => setDeferred((current) => deferQuestions(current, queue, "later"))}
        onClose={() => setDeferred((current) => deferQuestions(current, queue, "close"))}
      />
    </OverlayPortal>
  );
}

function QuestionPopupCard(props: {
  readonly question: PendingQuestion;
  readonly total: number;
  readonly onOpenThread: () => void;
  readonly onLater: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { thread: ref, requestId } = props.question;
  const { environmentId, threadId } = ref;
  const thread = useThreadShell(ref);
  const project = useProject(thread ? scopeProjectRef(environmentId, thread.projectId) : null);
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(ref));
  const prompt = requests?.userInputs.find((request) => request.requestId === requestId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: false });
  const [draft, setDraft] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [index, setIndex] = useState(0);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const { bottom, top } = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { nativeTextStyle } = useMarkdownPreviewStyles();
  const keyboardHeight = useKeyboardState((keyboard) => keyboard.height);

  const drafts = prompt ? seedUserInputDraftAnswers(prompt.questions, draft) : draft;
  const progress = prompt ? derivePendingUserInputProgress(prompt.questions, drafts, index) : null;
  const question = progress?.activeQuestion;
  const canRespond =
    canOperate && prompt !== undefined && prompt.responseCapability !== "not_resumable";
  const disabled = !canRespond || responding;
  const run = async (send: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setResponding(true);
    setError(null);
    const result = await send();
    inFlight.current = false;
    setResponding(false);
    if (result._tag === "Success") props.onLater();
    else if (!isAtomCommandInterrupted(result)) {
      setError(
        thrownErrorMessage(squashAtomCommandFailure(result), m) ??
          gt("Failed to submit user input."),
      );
    }
  };
  const advance = () => {
    if (!prompt || !progress?.canAdvance || disabled) return;
    if (!progress.isLastQuestion) {
      setIndex(progress.questionIndex + 1);
      return;
    }
    const answers = buildPendingUserInputAnswers(prompt.questions, drafts);
    if (answers)
      void run(() => respond({ environmentId, input: { threadId, requestId, answers } }));
  };

  return (
    <KeyboardAvoidingView
      pointerEvents="box-none"
      behavior="padding"
      className="absolute inset-0 items-end justify-end px-3"
      style={{ paddingBottom: bottom + 12 }}
    >
      <View
        className="w-full max-w-[420px] gap-2 rounded-3xl border border-border bg-card-alt p-3 shadow-lg"
        style={{ maxHeight: Math.min(height * 0.66, height - keyboardHeight - top - bottom - 24) }}
        accessibilityLabel={gt("Question from an agent")}
        testID="background-question-popup"
      >
        <View className="flex-row items-center gap-2">
          <SymbolView name="questionmark.bubble" size={18} tintColorClassName="accent-primary" />
          <View className="min-w-0 flex-1">
            <AppText className="font-t3-bold text-foreground" numberOfLines={1}>
              {thread?.title ?? gt("Thread")}
            </AppText>
            {project ? (
              <AppText className="text-xs text-foreground-muted" numberOfLines={1}>
                {project.title}
              </AppText>
            ) : null}
          </View>
          {props.total > 1 ? (
            <AppText className="text-xs text-foreground-muted">
              {gt("1 of {total}", { total: props.total })}
            </AppText>
          ) : null}
          <Pressable
            className="size-11 items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel={gt("Close questions")}
            onPress={props.onClose}
          >
            <SymbolView name="xmark" size={17} tintColorClassName="accent-foreground-muted" />
          </Pressable>
        </View>
        <ScrollView
          className="min-h-0"
          style={{ flexGrow: 0, flexShrink: 1 }}
          contentContainerClassName="gap-2"
          keyboardShouldPersistTaps="handled"
        >
          {question && progress ? (
            <>
              <AppText className="font-t3-bold text-foreground">{question.header}</AppText>
              <SelectableMarkdownText
                markdown={question.question}
                textStyle={nativeTextStyle}
                preserveSoftBreaks
              />
              {question.options.map((option) => {
                const value = option.value ?? option.label.trim();
                const checked = isPendingUserInputOptionSelected(
                  question,
                  drafts[question.id],
                  value,
                );
                return (
                  <Pressable
                    key={value}
                    accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                    accessibilityState={{ checked, disabled }}
                    disabled={disabled}
                    className={cn(
                      "gap-1 rounded-xl border px-3 py-2",
                      checked ? "border-primary bg-primary/10" : "border-border bg-input",
                    )}
                    onPress={() =>
                      setDraft({
                        ...draft,
                        [question.id]: togglePendingUserInputOptionSelection(
                          question,
                          drafts[question.id],
                          value,
                        ),
                      })
                    }
                  >
                    <AppText className="font-t3-medium text-foreground">{option.label}</AppText>
                    {option.description && option.description !== option.label ? (
                      <AppText className="text-xs text-foreground-muted">
                        {option.description}
                      </AppText>
                    ) : null}
                    {option.preview ? (
                      <SelectableMarkdownText
                        markdown={option.preview}
                        textStyle={nativeTextStyle}
                        preserveSoftBreaks
                      />
                    ) : null}
                  </Pressable>
                );
              })}
              {question.allowCustomAnswer !== false ? (
                <AppTextInput
                  accessibilityLabel={gt("Your own answer")}
                  placeholder={gt("Or type your own answer")}
                  className="min-h-11 rounded-xl border border-border bg-input px-3 py-2 text-foreground"
                  multiline
                  editable={!disabled}
                  onChangeText={(value) =>
                    setDraft({
                      ...draft,
                      [question.id]: setPendingUserInputCustomAnswer(
                        question,
                        drafts[question.id],
                        value,
                      ),
                    })
                  }
                  value={progress.customAnswer}
                />
              ) : null}
            </>
          ) : null}
          {error ? (
            <AppText accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </AppText>
          ) : null}
        </ScrollView>
        <View className="flex-row flex-wrap items-center gap-1">
          <Button
            label={gt("Open thread")}
            tone="text"
            size="compact"
            onPress={props.onOpenThread}
          />
          <Button label={gt("Later")} tone="text" size="compact" onPress={props.onLater} />
          {progress && progress.questionIndex > 0 ? (
            <Button
              label={gt("Back", { $context: "previous question" })}
              size="compact"
              onPress={() => setIndex(progress.questionIndex - 1)}
              disabled={responding}
            />
          ) : null}
          {progress ? (
            <Button
              label={progress.isLastQuestion ? gt("Submit") : gt("Next")}
              tone="primary"
              size="compact"
              onPress={advance}
              disabled={disabled || !progress.canAdvance}
              loading={responding}
            />
          ) : null}
          {prompt?.dismissible && canOperate ? (
            <Button
              label={gt("Dismiss without answering")}
              tone="text"
              size="compact"
              disabled={responding}
              onPress={() =>
                void run(() => dismiss({ environmentId, input: { threadId, requestId } }))
              }
            />
          ) : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
