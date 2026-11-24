import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import { IssueInboxSection, useIssueInbox } from "./IssueInbox";
import { IssueDoneDetails } from "./IssueDoneDetails";
import { useIssueQueue } from "./IssueQueueAction";
import type { EnvironmentId, IssueRepositoryRef, RepositoryIssueSummary } from "@t3tools/contracts";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { IssueSection } from "./IssueSection";
import { IssueRow } from "./IssueRow";
import { issueRoadmap, createIssueRoadmapClock } from "./issueRoadmap.logic";
import { useIssueStageLabels } from "./IssueStateIcon";

/** The same roadmap is used in the Issues pane, browser and thread details. */
export function IssueRoadmap({
  scope,
  environmentId,
  issues,
  visibleNumbers,
  onSelect,
  selectedIssueNumber,
  limit = Infinity,
  inbox,
}: {
  scope: IssueRepositoryRef;
  environmentId: EnvironmentId;
  issues: readonly RepositoryIssueSummary[];
  visibleNumbers?: ReadonlySet<number>;
  onSelect: (issue: RepositoryIssueSummary) => void;
  selectedIssueNumber?: number;
  limit?: number;
  /** Rendered above Backlog, where the owner triages new activity. */
  inbox?: ReactNode;
}) {
  const stageLabels = useIssueStageLabels();
  const clock = createIssueRoadmapClock(issues);
  const now = useSyncExternalStore(clock.subscribe, clock.snapshot, clock.snapshot);
  const queue = useIssueQueue(environmentId, scope);
  const pendingInbox = useIssueInbox(environmentId, scope);
  const sections = issueRoadmap(
    { host: scope.host, repository: scope.repository },
    issues,
    queue.data?.queue?.map((entry) => entry.issue.number),
    now,
    pendingInbox.data?.pendingIssueNumbers ??
      pendingInbox.data?.events
        .filter((event) => event.kind === "issue_opened")
        .map((event) => event.issueNumber),
  );
  const shown = new Set(
    sections
      .flatMap((section) => section.rows)
      .filter((row) => visibleNumbers === undefined || visibleNumbers.has(row.issue.number))
      .slice(0, limit)
      .map((row) => row.issue.number),
  );
  return (
    <div aria-label={`Roadmap for ${scope.repository}`}>
      {queue.supported &&
      queue.data?.rootThreadId === null &&
      (queue.data.queue?.length ?? 0) > 0 ? (
        <p className="px-3 py-1 text-xs text-muted-foreground" role="status">
          Waiting for a repository orchestrator. Right-click a thread and choose Make repository
          orchestrator to hand off queued issues.
        </p>
      ) : null}
      {sections
        .filter((section) => section.id !== "queued" || queue.supported)
        .map((section) => {
          const title = stageLabels[section.stage];
          const rows = section.rows.filter((row) => shown.has(row.issue.number));
          return (
            <Fragment key={section.id}>
              {section.id === "backlog"
                ? (inbox ?? (
                    <IssueInboxSection
                      environmentId={environmentId}
                      reference={scope}
                      issues={issues}
                    />
                  ))
                : null}
              <IssueSection scope={{ ...scope, environmentId }} section={`roadmap:${section.id}`}>
                {(collapsed, toggleCollapsed) => (
                  <section aria-label={title}>
                    <CollapsibleSectionHeader
                      expanded={!collapsed}
                      onClick={toggleCollapsed}
                      accessory={<span className="tabular-nums">{rows.length}</span>}
                    >
                      {title}
                    </CollapsibleSectionHeader>
                    {!collapsed ? (
                      <ul>
                        {rows.map(({ issue, cycle }) => (
                          <li key={issue.number} className="px-2 py-1">
                            <IssueRow
                              issue={issue}
                              environmentId={environmentId}
                              selected={selectedIssueNumber === issue.number}
                              onSelect={() => onSelect(issue)}
                              className="flex-1 px-1"
                              cycle={cycle}
                            />
                            {issue.state === "closed" ? (
                              <IssueDoneDetails
                                issue={issue}
                                scope={scope}
                                environmentId={environmentId}
                              />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                )}
              </IssueSection>
            </Fragment>
          );
        })}
    </div>
  );
}
