import { useSyncExternalStore } from "react";
import { IssueDoneDetails } from "./IssueDoneDetails";
import { useIssueQueue } from "./IssueQueueAction";
import type {
  EnvironmentId,
  IssueMilestone,
  IssueRepositoryRef,
  IssueSummary,
} from "@t3tools/contracts";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { IssueSection } from "./IssueSection";
import { IssueRow } from "./IssueRow";
import { Badge } from "~/components/ui/badge";
import { issueRoadmap, openIssueBlockers, createIssueRoadmapClock } from "./issueRoadmap.logic";

/** The same roadmap is used in the Issues pane, browser and thread details. */
export function IssueRoadmap({
  scope,
  environmentId,
  milestones,
  issues,
  visibleNumbers,
  onSelect,
  selectedIssueNumber,
  limit = Infinity,
}: {
  scope: IssueRepositoryRef;
  environmentId: EnvironmentId;
  milestones: readonly IssueMilestone[];
  issues: readonly IssueSummary[];
  visibleNumbers?: ReadonlySet<number>;
  onSelect: (issue: IssueSummary) => void;
  selectedIssueNumber?: number;
  limit?: number;
}) {
  const clock = createIssueRoadmapClock(issues);
  const now = useSyncExternalStore(clock.subscribe, clock.snapshot, clock.snapshot);
  const queue = useIssueQueue(environmentId, scope);
  const sections = issueRoadmap(
    { host: scope.host, repository: scope.repository },
    milestones,
    issues,
    queue.data?.queue?.map((entry) => entry.issue.number),
    now,
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
          Waiting for a repository orchestrator. Register one with Start agent to hand off queued
          issues.
        </p>
      ) : null}
      {sections
        .filter((section) => section.id !== "queued" || queue.supported)
        .map((section) => {
          const rows = section.rows.filter((row) => shown.has(row.issue.number));
          return (
            <IssueSection
              key={section.id}
              scope={{ ...scope, environmentId }}
              section={`roadmap:${section.id}`}
            >
              {(collapsed, toggleCollapsed) => (
                <section aria-label={section.title}>
                  <CollapsibleSectionHeader
                    expanded={!collapsed}
                    onClick={toggleCollapsed}
                    accessory={<span className="tabular-nums">{rows.length}</span>}
                  >
                    {section.title}
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
                          />
                          {issue.state === "closed" ? (
                            <IssueDoneDetails
                              issue={issue}
                              scope={scope}
                              environmentId={environmentId}
                            />
                          ) : null}
                          {issue.state === "open" ? (
                            <div className="flex flex-wrap items-center gap-1 ps-6 text-xs text-muted-foreground">
                              {cycle ? (
                                <Badge variant="secondary" size="sm">
                                  dependency cycle
                                </Badge>
                              ) : null}
                              {issue.relationshipsComplete === false ||
                              issue.blockedBy === undefined ? (
                                <span>Dependencies unavailable</span>
                              ) : null}
                              {openIssueBlockers(issue).length > 0 ? (
                                <span>
                                  blocked by{" "}
                                  {openIssueBlockers(issue).map((blocker, index) => (
                                    <span
                                      key={`${blocker.host}/${blocker.repository}#${blocker.number}`}
                                    >
                                      {index > 0 ? ", " : ""}
                                      <a
                                        className="underline"
                                        href={`https://${blocker.host}/${blocker.repository}/issues/${blocker.number}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        {blocker.host.toLowerCase() === scope.host.toLowerCase() &&
                                        blocker.repository.toLowerCase() ===
                                          scope.repository.toLowerCase()
                                          ? ""
                                          : `${blocker.repository}`}
                                        #{blocker.number}
                                      </a>
                                    </span>
                                  ))}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              )}
            </IssueSection>
          );
        })}
    </div>
  );
}
