import { useMemo } from "react";
import type {
  EnvironmentId,
  IssueMilestone,
  IssueRepositoryRef,
  IssueSummary,
} from "@t3tools/contracts";
import { IssueRow } from "./IssueRow";
import { Badge } from "~/components/ui/badge";
import { issueRoadmap, openIssueBlockers } from "./issueRoadmap.logic";

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
  const sections = useMemo(
    () => issueRoadmap({ host: scope.host, repository: scope.repository }, milestones, issues),
    [scope.host, scope.repository, milestones, issues],
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
      {sections.map((section) => {
        const rows = section.rows.filter((row) => shown.has(row.issue.number));
        return (
          <section key={section.id} aria-label={section.title}>
            <h3 className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {section.title}
            </h3>
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
                  <div className="flex flex-wrap items-center gap-1 ps-6 text-xs text-muted-foreground">
                    {cycle ? (
                      <Badge variant="secondary" size="sm">
                        dependency cycle
                      </Badge>
                    ) : null}
                    {issue.relationshipsComplete === false || issue.blockedBy === undefined ? (
                      <span>Dependencies unavailable</span>
                    ) : null}
                    {openIssueBlockers(issue).length > 0 ? (
                      <span>
                        blocked by{" "}
                        {openIssueBlockers(issue).map((blocker, index) => (
                          <span key={`${blocker.host}/${blocker.repository}#${blocker.number}`}>
                            {index > 0 ? ", " : ""}
                            <a
                              className="underline"
                              href={`https://${blocker.host}/${blocker.repository}/issues/${blocker.number}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {blocker.host.toLowerCase() === scope.host.toLowerCase() &&
                              blocker.repository.toLowerCase() === scope.repository.toLowerCase()
                                ? ""
                                : `${blocker.repository}`}
                              #{blocker.number}
                            </a>
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
