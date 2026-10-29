import type { IssueContextMetadata, IssueContextRecord, IssueSummary } from "@t3tools/contracts";
import {
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import type { DragEvent } from "react";
import { COMPOSER_ISSUE_DRAG_TYPE, encodeIssueDragPayload } from "./issueComposerDrag";

export function issueContextMetadata(
  issue: Pick<IssueSummary, "number" | "title" | "url"> &
    Partial<
      Pick<IssueSummary, "state" | "stateReason" | "blockedBy" | "liveWork" | "pullRequests">
    >,
): IssueContextMetadata {
  const url = new URL(issue.url);
  return {
    host: url.host,
    repository: url.pathname.split("/").slice(1, 3).join("/"),
    number: issue.number,
    title: issue.title.slice(0, 2048),
    url: issue.url,
    state: issue.state ?? null,
    stateReason: issue.stateReason?.slice(0, 2048) ?? null,
    blockedBy: (issue.blockedBy ?? []).slice(0, 200).map(({ state }) => ({ state })),
    liveWork: (issue.liveWork ?? []).slice(0, 200).map(({ status }) => ({ status })),
    pullRequests: (issue.pullRequests ?? []).slice(0, 200).map(({ state }) => ({ state })),
  };
}

export function buildIssueReferenceContext(issue: IssueContextMetadata): IssueContextRecord {
  return {
    ...issue,
    version: 1,
    kind: "issue",
    contextId: toKindScopedComposerContextId("issue", issue.url),
    label: sanitizeComposerContextLabel(`#${issue.number} ${issue.title}`, "issue"),
  };
}

export function issueContextReference(record: IssueContextRecord) {
  return { kind: record.kind, contextId: record.contextId, label: record.label };
}

export function startIssueDrag(
  event: DragEvent<HTMLElement>,
  issue: Parameters<typeof issueContextMetadata>[0],
) {
  event.dataTransfer.setData(
    COMPOSER_ISSUE_DRAG_TYPE,
    encodeIssueDragPayload(issueContextMetadata(issue)),
  );
}

export function filterComposerIssues<T extends Pick<IssueSummary, "number" | "title">>(
  issues: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  return issues.filter(
    (issue) =>
      !normalized ||
      (/^\d+$/u.test(normalized)
        ? String(issue.number).startsWith(normalized)
        : issue.title.toLowerCase().includes(normalized)),
  );
}
