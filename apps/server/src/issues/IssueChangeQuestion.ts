import {
  CommandId,
  issueChangePreview,
  issueChangeTitle,
  type IssueChange,
  type OrchestrationV2UserInputQuestion,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
} from "@t3tools/contracts";

// requestUserInput derives the request id from the command id, so both carry this prefix.
const prefix = "issue-change-question:";
const questionId = "issue-change";
// Questions are capped at 20,000 characters in total; a long body diff stays readable in the issue.
const previewLimit = 16_000;

/** A fresh command per ask: each proposal retry may ask again. */
export const issueChangeQuestionCommandId = (changeId: string, attempt: string) =>
  CommandId.make(`${prefix}${changeId}:${attempt}`);

/** Only the user answers these: agents are refused and they are never routed to an orchestrator. */
export const isIssueChangeQuestion = (requestId: RuntimeRequestId) => requestId.startsWith(prefix);

export function issueChangeQuestion(change: IssueChange): OrchestrationV2UserInputQuestion {
  const preview = issueChangePreview(change);
  return {
    id: questionId,
    header: "Issue change",
    question: `${issueChangeTitle(change)} in ${change.repository}\n\n${
      preview.length > previewLimit
        ? `${preview.slice(0, previewLimit)}\n… The preview is cut short here; the issue's detail view shows the full change.`
        : preview
    }`.trim(),
    // Don't ask mode answers with the first option, so Decline must stay first.
    options: [
      { label: "Decline", description: "Leave the issue unchanged." },
      { label: "Approve", description: "Make this change on GitHub." },
    ],
    allowCustomAnswer: false,
  };
}

/** The decision an answer names. Don't ask mode appends its note after a blank line. */
export function issueChangeAnswerDecision(answers: ProviderUserInputAnswers) {
  const answer = answers[questionId];
  const label = typeof answer === "string" ? answer.split("\n\n")[0]!.trim() : undefined;
  return label === "Approve" ? "approved" : label === "Decline" ? "rejected" : null;
}
