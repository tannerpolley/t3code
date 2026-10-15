import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  IssueComment,
  IssueSummary,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

export type IssueComposerAction = "ask" | "explain" | "implement";

export function issueImplementDestination(input: {
  environmentId: EnvironmentId;
  rootThreadId: ThreadId | null | undefined;
  currentThread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "lineage"> | null;
  parentOwnerThreadId: ThreadId | null;
}) {
  if (input.rootThreadId == null) {
    return {
      threadRef: null,
      disabledReason: "No orchestrator for this repository; use Start agent",
    };
  }
  const current = input.currentThread;
  const threadId =
    current?.environmentId === input.environmentId &&
    current.lineage.rootThreadId === input.rootThreadId &&
    current.id === input.parentOwnerThreadId
      ? current.id
      : input.rootThreadId;
  return { threadRef: scopeThreadRef(input.environmentId, threadId), disabledReason: null };
}

/** Only ordinary associations can be removed; managed work and PR references keep their owners. */
export function canUnlinkIssue(
  issue: Pick<IssueSummary, "liveWork">,
  environmentId: string,
  threadRef: ScopedThreadRef | null,
) {
  return (
    threadRef?.environmentId === environmentId &&
    issue.liveWork?.some(
      (work) => work.threadId === threadRef.threadId && work.canUnlink === true,
    ) === true
  );
}

export function issueMenuAvailability(input: {
  linked: boolean;
  hasComposer: boolean;
  state: "open" | "closed";
  canWrite: boolean;
  canUnlink: boolean;
}) {
  return {
    unlink: input.linked && input.canUnlink,
    composer: input.hasComposer,
    close: input.state === "open" && input.canWrite,
    reopen: input.state === "closed" && input.canWrite,
  };
}

export function issueComposerPrompt(
  action: IssueComposerAction,
  issue: Pick<IssueSummary, "number" | "title" | "url">,
) {
  const reference = `#${issue.number}: ${issue.title || "Untitled issue"}\n\n${issue.url}`;
  switch (action) {
    case "ask":
      return reference;
    case "explain":
      return `Explain this issue: ${reference}\n\nRead the issue and its latest comments. Explain the problem, intended outcome, and relevant code. Leave implementation for a separate request.`;
    case "implement":
      return `Implement this issue: ${reference}\n\nRead the issue and its latest comments, then delegate it with delegate_task using the issue argument, following the repository's model roles.`;
  }
}

/** Issue comments have no review-resolution state; GitHub bot logins retain their suffix. */
export function filterIssueComments(comments: ReadonlyArray<IssueComment>, showBots: boolean) {
  return showBots
    ? comments
    : comments.filter((comment) => !comment.author?.login.endsWith("[bot]"));
}

export function issueReferenceCopyTarget(
  issue: { host: string; repository: string; number: number } | null,
) {
  return issue === null
    ? null
    : {
        kind: "issue" as const,
        value: `https://${issue.host}/${issue.repository}/issues/${issue.number}`,
        clipboardTarget: "issue link",
        successTitle: "Issue link copied",
        failureTitle: "Failed to copy issue link",
      };
}
