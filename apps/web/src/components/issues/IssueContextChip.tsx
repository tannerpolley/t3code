import type { EnvironmentId, IssueContextRecord, ScopedThreadRef } from "@t3tools/contracts";
import { CircleDashedIcon } from "lucide-react";
import { useOpenIssueLink } from "~/lib/openIssueLink";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import { useProjects, useServerConfigs } from "~/state/entities";
import { IssueLinkPreview } from "../issue/IssueLinkPreview";
import { ContextChipPopover } from "../contextChipParts";
import { IssueStateIcon, issueStatePresentation, useIssueStateLabel } from "./IssueStateIcon";

export function IssueContextChip({
  record,
  copyMarkdown,
  threadRef,
  environmentId: draftEnvironmentId,
}: {
  record: IssueContextRecord;
  copyMarkdown?: string;
  threadRef?: ScopedThreadRef | null;
  environmentId?: EnvironmentId | null;
}) {
  const environmentId = threadRef?.environmentId ?? draftEnvironmentId;
  const projects = useProjects();
  const configs = useServerConfigs();
  const target =
    environmentId != null && configs.get(environmentId)?.environment.capabilities.issues === true
      ? resolveIssueLinkTarget({
          url: record.url,
          projects: projects.filter((project) => project.environmentId === environmentId),
        })
      : null;
  const openIssue = useOpenIssueLink(threadRef ?? undefined);
  const issue = record.state === null ? null : { ...record, state: record.state };
  const state = useIssueStateLabel(
    issue === null ? "State unavailable" : issueStatePresentation(issue).label,
  );
  if (target !== null && environmentId != null)
    return (
      <IssueLinkPreview
        target={{ environmentId, input: target.ref }}
        originalUrl={record.url}
        link={
          <ContextChip
            kind="issue"
            render={<a href={record.url} target="_blank" rel="noopener noreferrer" />}
            aria-label={`Open issue #${record.number}: ${record.title}, ${state}`}
            data-markdown-copy={copyMarkdown}
            onClick={(event) => openIssue(event, record.url, environmentId)}
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
