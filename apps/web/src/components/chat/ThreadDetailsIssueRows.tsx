import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueHostCapabilities,
  RepositoryIdentity,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  repositoryIssueCapabilities,
  threadIssueRepository,
} from "@t3tools/client-runtime/state/issue-work";
import { ChevronDownIcon, FoldVerticalIcon, ListIcon, UnfoldVerticalIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironment } from "~/state/environments";
import { issueEnvironment, useLiveIssueWork } from "~/state/issues";
import { useIssueSectionCollapsed } from "../issues/useIssueSectionCollapsed";

import { IssueRoadmap } from "../issues/IssueRoadmap";
import { IssueFilterMenu, useIssueFilterPreferences } from "../issues/IssueFilterMenu";
import {
  filterAndSortIssues,
  issueStateFilter,
  supportedIssueFilters,
} from "../issues/issueWorkspace.logic";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** Issue rows shown before "Show all issues", matching the pull request rows. */
const VISIBLE_ISSUE_COUNT = 5;

export { threadIssueRepository } from "@t3tools/client-runtime/state/issue-work";

/**
 * The fork's own section for the thread repository's issues, kept out of the vanilla Version
 * Control section. Its collapse state is remembered per repository, and its Filter menu shares
 * the Issues page's saved choices.
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
  const capabilities = repositoryIssueCapabilities(repositoryIdentity);
  const capable = environment?.serverConfig?.environment.capabilities.githubIssues === true;
  if (!enabled || target === null || capabilities === null || !capable) return null;
  return (
    <IssueRows
      environmentId={environmentId}
      threadId={threadId}
      capabilities={capabilities}
      {...target}
    />
  );
}

function IssueRows({
  environmentId,
  threadId,
  host,
  repository,
  capabilities,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  host: string;
  repository: string;
  capabilities: IssueHostCapabilities;
}) {
  const [savedPreferences, setPreferences] = useIssueFilterPreferences();
  const preferences = supportedIssueFilters(savedPreferences, capabilities);
  const [collapsed, toggleCollapsed] = useIssueSectionCollapsed(
    { environmentId, host, repository },
    "section",
  );
  const open = !collapsed;
  const result = useAtomValue(
    issueEnvironment.liveList({
      environmentId,
      input: { host, repository, state: "all", roadmap: true },
    }),
  );
  const cachedList = Option.getOrNull(AsyncResult.value(result));
  const liveIssueWork = useLiveIssueWork();
  const list = cachedList === null ? null : liveIssueWork(cachedList, environmentId);
  const [showAll, setShowAll] = useState(false);
  const state = issueStateFilter(preferences);
  const shown =
    list === null || state === null
      ? []
      : filterAndSortIssues(list.issues, {
          query: "",
          state,
          assignee: preferences.assignee,
          sort: preferences.sort,
        });
  const total = list === null ? null : shown.length;
  const hidden = Math.max(0, shown.length - VISIBLE_ISSUE_COUNT);
  const more = list?.nextCursor == null ? "" : "+";

  const browseAll = () =>
    useRightPanelStore
      .getState()
      .openIssueList(scopeThreadRef(environmentId, threadId), { host, repository });
  const showAllLabel = showAll
    ? "Show fewer issues"
    : `Show all issues (${hidden}${more} more)`;

  return (
    <ThreadDetailsSection
      headingId="thread-details-issues-heading"
      title="Issues"
      showHeading={false}
    >
      {/* The heading is the section's own collapse toggle, so no row inside repeats it. */}
      <div className="mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 px-1.5">
        <h3 className="min-w-0">
          <button
            type="button"
            aria-expanded={open}
            className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-2xs font-medium text-muted-foreground select-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onClick={toggleCollapsed}
          >
            <span className="truncate">Issues</span>
            {total === null ? null : (
              <span className="tabular-nums text-muted-foreground/70">
                {total}
                {more}
              </span>
            )}
            <ChevronDownIcon
              aria-hidden
              className={`size-3 shrink-0 transition-transform${open ? "" : " -rotate-90"}`}
            />
          </button>
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          <IssueHeaderButton label="Browse all issues" onClick={browseAll}>
            <ListIcon aria-hidden className="size-3.5" />
          </IssueHeaderButton>
          {open && total !== null && total > VISIBLE_ISSUE_COUNT ? (
            <IssueHeaderButton
              label={showAllLabel}
              pressed={showAll}
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? (
                <FoldVerticalIcon aria-hidden className="size-3.5" />
              ) : (
                <UnfoldVerticalIcon aria-hidden className="size-3.5" />
              )}
            </IssueHeaderButton>
          ) : null}
          <IssueFilterMenu
            host=""
            hosts={[]}
            onChange={setPreferences}
            onHostChange={() => {}}
            preferences={savedPreferences}
            singleRepository
            capabilities={capabilities}
          />
        </div>
      </div>
      {open ? (
        <div className="flex flex-col" aria-label={`Issues in ${repository}`} role="group">
          {list === null ? (
            result._tag === "Failure" ? (
              <p className="px-2.5 py-1.5 text-xs text-muted-foreground/70">Issues unavailable</p>
            ) : null
          ) : total === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground/70">No matching issues</p>
          ) : (
            <IssueRoadmap
              scope={{ host, repository }}
              environmentId={environmentId}
              issues={list.issues}
              visibleNumbers={new Set(shown.map((issue) => issue.number))}
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
          )}
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}

function IssueHeaderButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={pressed}
            onClick={onClick}
            size="icon-xs"
            variant="ghost-muted"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
