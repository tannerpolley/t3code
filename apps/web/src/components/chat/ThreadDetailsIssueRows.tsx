import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueListResult,
  RepositoryIdentity,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadIssueRepository } from "@t3tools/client-runtime/state/issue-work";
import { ListIcon, MinusIcon, PlusIcon } from "lucide-react";
import { IssueRow } from "../issues/IssueRow";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironment } from "~/state/environments";
import { issueEnvironment, useLiveIssueWork } from "~/state/issues";
import { useIssueSectionCollapsed } from "../issues/useIssueSectionCollapsed";

import { IssueRoadmap } from "../issues/IssueRoadmap";
import {
  IssueFilterMenu,
  useIssueFilterPreferences,
  useIssueView,
} from "../issues/IssueFilterMenu";
import { groupIssuesByMilestone, type IssueGroup } from "../issues/issueTree.logic";
import {
  filterAndSortIssues,
  issueListStateFor,
  issueStateFilter,
  type IssueFilterPreferences,
} from "../issues/issueWorkspace.logic";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** Issue rows shown before "Show N more", matching the pull request rows. */
const VISIBLE_ISSUE_COUNT = 5;

export { threadIssueRepository } from "@t3tools/client-runtime/state/issue-work";

/**
 * The block's issues under the Filter menu's choices, grouped by milestone with "No Milestone" last,
 * then cut to `limit` rows across the groups in order. `hidden` counts the rows cut.
 */
export function threadIssueGroups(
  issues: IssueListResult["issues"],
  preferences: IssueFilterPreferences,
  limit: number,
): { readonly groups: IssueGroup[]; readonly total: number; readonly hidden: number } {
  const state = issueStateFilter(preferences);
  if (state === null) return { groups: [], total: 0, hidden: 0 };
  const filters = {
    query: "",
    state,
    milestone: preferences.milestone,
    assignee: preferences.assignee,
    sort: preferences.sort,
  };
  const shown = filterAndSortIssues(issues, filters);
  let remaining = limit;
  const groups = groupIssuesByMilestone([], shown).flatMap((group) => {
    if (remaining <= 0) return [];
    const kept = filterAndSortIssues(group.issues, filters).slice(0, remaining);
    remaining -= kept.length;
    return [{ ...group, issues: kept }];
  });
  return { groups, total: shown.length, hidden: Math.max(0, shown.length - limit) };
}

/**
 * The fork's own sibling section for the thread repository's issues, a fork feature kept out of
 * the vanilla Version Control section. Expanded by default and remembered per repository. The
 * Filter menu shares the Issues page's saved choices. A row opens the issue beside the thread, and
 * "Browse all issues" opens the full list there; the list stays live while agents work on it.
 */
export function ThreadDetailsIssueRows({
  environmentId,
  threadId,
  repositoryIdentity,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  repositoryIdentity: RepositoryIdentity | null | undefined;
}) {
  const enabled = useClientSettings((settings) => settings.versionControlIssues);
  const environment = useEnvironment(environmentId);
  const target = threadIssueRepository(repositoryIdentity);
  const capable = environment?.serverConfig?.environment.capabilities.githubIssues === true;
  if (!enabled || target === null || !capable) return null;
  return <IssueRows environmentId={environmentId} threadId={threadId} {...target} />;
}

const LIST_HEADINGS = { open: "Open issues", closed: "Closed issues", all: "Issues" } as const;

function IssueRows({
  environmentId,
  threadId,
  host,
  repository,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  host: string;
  repository: string;
}) {
  const [preferences, setPreferences] = useIssueFilterPreferences();
  const [issueView, setIssueView] = useIssueView(host, repository);
  const [collapsed, toggleCollapsed] = useIssueSectionCollapsed(
    { environmentId, host, repository },
    issueView === "roadmap" ? "roadmap" : `list:${issueStateFilter(preferences) ?? "open"}`,
  );
  const open = !collapsed;
  const listState =
    issueView === "roadmap" ? "open" : issueListStateFor(issueStateFilter(preferences) ?? "open");
  const result = useAtomValue(
    // Both views read blockers and live work so issue circles show blocked and in progress.
    (issueView === "roadmap" ? issueEnvironment.roadmapList : issueEnvironment.liveList)({
      environmentId,
      input: { host, repository, state: listState, roadmap: true },
    }),
  );
  const cachedList = Option.getOrNull(AsyncResult.value(result));
  const liveIssueWork = useLiveIssueWork();
  const list = cachedList === null ? null : liveIssueWork(cachedList, environmentId);
  const [showAll, setShowAll] = useState(false);
  const view =
    list === null
      ? null
      : threadIssueGroups(
          list.issues,
          issueView === "roadmap" ? { ...preferences, open: true, closed: false } : preferences,
          showAll ? Number.POSITIVE_INFINITY : VISIBLE_ISSUE_COUNT,
        );
  const more = list?.nextCursor == null ? "" : "+";

  return (
    <ThreadDetailsSection
      headingId="thread-details-issues-heading"
      title="Issues"
      actions={
        <IssueFilterMenu
          host=""
          hosts={[]}
          onChange={setPreferences}
          onHostChange={() => {}}
          preferences={preferences}
          singleRepository
          view={{ value: issueView, onChange: setIssueView }}
        />
      }
    >
      <div className="flex flex-col" aria-label={`Issues in ${repository}`} role="group">
        <CollapsibleSectionHeader
          expanded={open}
          onClick={toggleCollapsed}
          accessory={
            view === null ? null : (
              <span className="text-xs tabular-nums text-muted-foreground/70">
                {view.total}
                {more}
              </span>
            )
          }
        >
          {issueView === "roadmap"
            ? "Roadmap"
            : LIST_HEADINGS[issueStateFilter(preferences) ?? "open"]}
        </CollapsibleSectionHeader>
        {open && issueView === "roadmap" && list !== null ? (
          <>
            <IssueRoadmap
              scope={{ host, repository }}
              environmentId={environmentId}
              milestones={list.milestones}
              issues={list.issues}
              visibleNumbers={
                new Set(
                  filterAndSortIssues(list.issues, {
                    query: "",
                    state: "open",
                    milestone: preferences.milestone,
                    assignee: preferences.assignee,
                    sort: preferences.sort,
                  }).map((issue) => issue.number),
                )
              }
              limit={showAll ? Infinity : VISIBLE_ISSUE_COUNT}
              onSelect={(issue) =>
                useRightPanelStore.getState().openIssue(scopeThreadRef(environmentId, threadId), {
                  environmentId,
                  host,
                  repository,
                  number: issue.number,
                  url: issue.url,
                })
              }
            />
            {view !== null && view.total > VISIBLE_ISSUE_COUNT ? (
              <ThreadDetailsControl tone="muted" onClick={() => setShowAll(!showAll)}>
                {showAll ? "Show less" : "Show all loaded issues"}
              </ThreadDetailsControl>
            ) : null}
            <ThreadDetailsControl
              tone="muted"
              onClick={() =>
                useRightPanelStore
                  .getState()
                  .openIssueList(scopeThreadRef(environmentId, threadId), { host, repository })
              }
            >
              Browse all issues
            </ThreadDetailsControl>
          </>
        ) : open ? (
          <IssueRowsBody
            environmentId={environmentId}
            threadId={threadId}
            host={host}
            repository={repository}
            view={view}
            failed={result._tag === "Failure"}
            more={more}
            showAll={showAll}
            onShowAllChange={setShowAll}
          />
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

function IssueRowsBody({
  environmentId,
  threadId,
  host,
  repository,
  view,
  failed,
  more,
  showAll,
  onShowAllChange,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  host: string;
  repository: string;
  view: ReturnType<typeof threadIssueGroups> | null;
  failed: boolean;
  more: string;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
}) {
  if (view === null) {
    return failed ? (
      <p className="px-2.5 py-1.5 text-xs text-muted-foreground/70">Issues unavailable</p>
    ) : null;
  }
  const { groups, total, hidden } = view;

  return (
    <>
      {groups.map((group) => (
        <IssueMilestoneGroup
          key={group.id}
          group={group}
          environmentId={environmentId}
          threadId={threadId}
          host={host}
          repository={repository}
        />
      ))}
      {total === 0 ? (
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground/70">No matching issues</p>
      ) : null}
      {total > VISIBLE_ISSUE_COUNT ? (
        <ThreadDetailsControl tone="muted" onClick={() => onShowAllChange(!showAll)}>
          {showAll ? (
            <MinusIcon aria-hidden className="-mx-0.5 size-4 shrink-0" />
          ) : (
            <PlusIcon aria-hidden className="-mx-0.5 size-4 shrink-0" />
          )}
          {showAll ? "Show less" : `Show ${hidden}${more} more`}
        </ThreadDetailsControl>
      ) : null}
      <ThreadDetailsControl
        tone="muted"
        onClick={() =>
          useRightPanelStore
            .getState()
            .openIssueList(scopeThreadRef(environmentId, threadId), { host, repository })
        }
      >
        <ListIcon aria-hidden className="-mx-0.5 size-4 shrink-0" />
        Browse all issues
      </ThreadDetailsControl>
    </>
  );
}

/**
 * One milestone's issues, collapsed by hand and remembered per repository and milestone (default
 * expanded), matching how Lineage's groups collapse.
 */
function IssueMilestoneGroup({
  group,
  environmentId,
  threadId,
  host,
  repository,
}: {
  group: IssueGroup;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  host: string;
  repository: string;
}) {
  const [collapsed, toggleCollapsed] = useIssueSectionCollapsed(
    { environmentId, host, repository },
    group.id,
  );
  return (
    <div className="flex flex-col">
      <CollapsibleSectionHeader expanded={!collapsed} onClick={toggleCollapsed}>
        {group.title}
        {collapsed && ` (${group.issues.length})`}
      </CollapsibleSectionHeader>
      {!collapsed
        ? group.issues.map((issue) => (
            <IssueRow
              key={issue.number}
              issue={issue}
              environmentId={environmentId}
              selected={false}
              className="px-2.5"
              onSelect={() =>
                useRightPanelStore.getState().openIssue(scopeThreadRef(environmentId, threadId), {
                  environmentId,
                  host,
                  repository,
                  number: issue.number,
                  url: issue.url,
                })
              }
            />
          ))
        : null}
    </div>
  );
}
