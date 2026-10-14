import {
  CommandId,
  issueChangePreview,
  issueChangeTitle,
  RuntimeRequestId,
  type IssueChange,
  type OrchestrationV2UserInputQuestion,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";

// One question per change: requestUserInput derives the request id from this command id,
// and a repeated command id is answered from its receipt instead of asking again.
const prefix = "issue-change-question:";
const suffix = ":user-input";
const questionId = "issue-change";
// Questions are capped at 20,000 characters in total; a long body diff stays readable in the issue.
const previewLimit = 16_000;

export const issueChangeQuestionCommandId = (changeId: string) =>
  CommandId.make(`${prefix}${changeId}`);

export const issueChangeQuestionRequestId = (changeId: string) =>
  RuntimeRequestId.make(`${prefix}${changeId}${suffix}`);

/** Only the user answers these: agents are refused and they are never routed to an orchestrator. */
export const isIssueChangeQuestion = (requestId: RuntimeRequestId) => requestId.startsWith(prefix);

/** The change a question asks about, or undefined for any other request. */
export const issueChangeIdOfQuestion = (requestId: RuntimeRequestId) =>
  requestId.startsWith(prefix) && requestId.endsWith(suffix)
    ? requestId.slice(prefix.length, -suffix.length)
    : undefined;

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
