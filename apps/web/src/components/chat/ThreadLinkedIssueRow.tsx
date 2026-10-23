import { startIssueDrag } from "../issues/issueComposerContext";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId, ThreadLinkedIssue } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { issueEnvironment, useLiveIssueSummary } from "~/state/issues";
import { IssueHoverCard } from "../issues/IssueHoverCard";
import { IssueRow } from "../issues/IssueRow";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** The durable issue link remains reachable even when repository browsing is hidden or unavailable. */
export function ThreadLinkedIssueRow({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const issue = useThreadShell(threadRef)?.linkedIssue;
  if (!issue) return null;
  return (
    <ThreadDetailsSection headingId="thread-details-linked-issue-heading" title="Linked issue">
      <LinkedIssueContent
        environmentId={environmentId}
        issue={issue}
        onSelect={() =>
          useRightPanelStore.getState().openIssue(threadRef, { environmentId, ...issue })
        }
      />
    </ThreadDetailsSection>
  );
}

/** Show issue state only when its summary is available. */
function LinkedIssueContent({
  environmentId,
  issue,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly issue: ThreadLinkedIssue;
  readonly onSelect: () => void;
}) {
  const detail = useAtomValue(
    issueEnvironment.detail({
      environmentId,
      input: { host: issue.host, repository: issue.repository, number: issue.number },
    }),
  );
  const summary = useLiveIssueSummary(
    Option.getOrNull(AsyncResult.value(detail))?.issue,
    issue,
    environmentId,
  );
  const referenceLabel = `${issue.repository} #${issue.number}`;
  return summary ? (
    <IssueRow
      issue={summary}
      environmentId={environmentId}
      selected={false}
      onSelect={onSelect}
      referenceLabel={referenceLabel}
      className="px-2.5"
    />
  ) : (
    <IssueHoverCard
      target={{
        environmentId,
        input: { host: issue.host, repository: issue.repository, number: issue.number },
      }}
      title={issue.title}
      render={
        <button
          type="button"
          draggable
          onDragStart={(event) => startIssueDrag(event, issue)}
          className={`${PULL_REQUEST_ROW_CLASS} px-2.5`}
          onClick={onSelect}
        >
          <span aria-hidden className="size-4 shrink-0" />
          <PullRequestRowLines
            number={null}
            title={issue.title || "Untitled issue"}
            meta={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{referenceLabel}</span>}
          />
        </button>
      }
    />
  );
}
