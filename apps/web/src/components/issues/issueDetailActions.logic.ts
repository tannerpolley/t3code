import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, RepositoryIssueSummary, ThreadId } from "@t3tools/contracts";

export type IssueComposerAction = "ask" | "explain" | "implement";

export function issueImplementDestination(
  input: {
    environmentId: EnvironmentId;
    rootThreadId: ThreadId | null | undefined;
    hasParent: boolean;
    paused: boolean;
  },
  resolve: MessageResolver = m,
) {
  if (input.hasParent) {
    return {
      threadRef: null,
      disabledReason: resolve(msg("Implement sub-issues from the parent issue's worker")),
    };
  }
  if (input.paused) {
    return {
      threadRef: null,
      disabledReason: resolve(msg("Repository work is paused; resume it in Project settings")),
    };
  }
  if (input.rootThreadId == null) {
    return {
      threadRef: null,
      disabledReason: resolve(msg("No orchestrator for this repository; use Start agent")),
    };
  }
  return {
    threadRef: scopeThreadRef(input.environmentId, input.rootThreadId),
    disabledReason: null,
  };
}

export function issueComposerPrompt(
  action: IssueComposerAction,
  issue: Pick<RepositoryIssueSummary, "number" | "title" | "url">,
) {
  const reference = `#${issue.number}: ${issue.title || "Untitled issue"}\n\n${issue.url}`;
  switch (action) {
    case "ask":
      return reference;
    case "explain":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- Agents receive this prompt in English.
      return `Explain this issue: ${reference}\n\nRead the issue and its latest comments. Explain the problem, intended outcome, and relevant code. Leave implementation for a separate request.`;
    case "implement":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- Agents receive this prompt in English.
      return `Implement this issue: ${reference}\n\nRead the issue and its latest comments, then delegate it with delegate_task using the issue argument, following the repository's model roles.`;
  }
}

/** An issue tab's link: the one it was opened from, else its GitHub page; other trackers need a URL. */
export function issueReferenceCopyTarget(
  issue: { tracker: string; host?: string; scope: string; key: string; url?: string } | null,
  resolve: MessageResolver = m,
) {
  const value =
    issue?.url ??
    (issue?.tracker === "github"
      ? `https://${issue.host ?? "github.com"}/${issue.scope}/issues/${issue.key}`
      : null);
  return value === null
    ? null
    : {
        kind: "issue" as const,
        value,
        clipboardTarget: "issue link",
        successTitle: resolve(msg("Issue link copied")),
        failureTitle: resolve(msg("Failed to copy issue link")),
      };
}

export function handoffPrompt(
  existing: {
    readonly prompt: string;
    /** Store only the handoff contribution so later handoffs preserve user text. */
    readonly lastHandoffPrompt: string | undefined;
  },
  incoming: string,
): string {
  if (existing.prompt.trim().length === 0) return incoming;
  const last = existing.lastHandoffPrompt ?? "";
  const kept =
    last.length === 0
      ? existing.prompt
      : existing.prompt === last
        ? ""
        : existing.prompt.endsWith(`\n\n${last}`)
          ? existing.prompt.slice(0, -(last.length + 2))
          : existing.prompt;
  if (kept.trim().length === 0) return incoming;
  return incoming.length === 0 ? kept : `${kept}\n\n${incoming}`;
}
