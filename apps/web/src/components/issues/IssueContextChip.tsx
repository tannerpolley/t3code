import type { IssueContextRecord, ScopedThreadRef } from "@t3tools/contracts";
import { CircleDashedIcon } from "lucide-react";
import { useOpenIssueLink } from "~/lib/openIssueLink";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { IssueLinkPreview, useIssuePreviewTarget } from "./IssueLinkPreview";
import { ContextChipPopover } from "../contextChipParts";
import { IssueStateIcon, issueStatePresentation } from "./IssueStateIcon";

export function IssueContextChip({
  record,
  copyMarkdown,
  threadRef,
}: {
  record: IssueContextRecord;
  copyMarkdown?: string;
  threadRef?: ScopedThreadRef | null;
}) {
  const target = useIssuePreviewTarget(threadRef?.environmentId, record.url);
  const openIssue = useOpenIssueLink(threadRef ?? undefined);
  const issue = record.state === null ? null : { ...record, state: record.state };
  const state = issue === null ? "State unavailable" : issueStatePresentation(issue).label;
  if (target !== null)
    return (
      <IssueLinkPreview
        environmentId={target.environmentId}
        url={record.url}
        title={record.title}
        link={
          <ContextChip
            kind="issue"
            render={<a href={record.url} target="_blank" rel="noopener noreferrer" />}
            aria-label={`Open issue #${record.number}: ${record.title}, ${state}`}
            data-markdown-copy={copyMarkdown}
            onClick={(event) => openIssue(event, record.url, target.environmentId)}
          >
            {issue === null ? <CircleDashedIcon /> : <IssueStateIcon issue={issue} />}
            <ContextChipLabel>
              #{record.number} {record.title}
            </ContextChipLabel>
          </ContextChip>
        }
      />
    );
  return (
    <ContextChipPopover
      kind="issue"
      icon={issue === null ? <CircleDashedIcon /> : <IssueStateIcon issue={issue} />}
      label={`#${record.number} ${record.title}`}
      accessibleLabel={`Issue #${record.number}: ${record.title}, ${state}`}
      {...(copyMarkdown === undefined ? {} : { copyMarkdown })}
    >
      <div className="max-w-80 space-y-1 overflow-hidden py-0.5 text-left">
        <div className="text-xs font-medium">
          Issue #{record.number} · {state}
        </div>
        <div className="wrap-break-word">{record.title}</div>
        <div className="text-secondary-label text-3xs">
          {record.host} / {record.repository}
        </div>
        <a
          href={record.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-xs underline"
        >
          {record.url}
        </a>
      </div>
    </ContextChipPopover>
  );
}
