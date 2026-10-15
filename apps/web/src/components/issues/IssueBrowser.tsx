import { IssueMilestoneControls, IssueRepositoryControls } from "./IssueMilestoneControls";
import { IssueInboxSection } from "./IssueInbox";
import { IssueStateIcon } from "./IssueStateIcon";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import {
  EnvironmentAuthorizationError as EnvironmentAuthorizationErrorClass,
  IssueReadError as IssueReadErrorClass,
  type IssueSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { LockIcon, PinIcon, PinOffIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { type ReactNode, type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type IssueSurface,
} from "~/rightPanelStore";
import { useAllEnvironmentShellsBootstrapped } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import {
  useLiveIssueWork,
  useIssueLists,
  useIssueRepositories,
  type IssueListTarget,
} from "~/state/issues";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { PageBackButton } from "../PageBackButton";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { IssueFilterMenu, useIssueFilterPreferences, useIssueViews } from "./IssueFilterMenu";
import { acceptIssueListPage, type IssueListSnapshot } from "./issuePaging.logic";
import { IssueTree, IssueTreeRow, IssueTreeTag } from "./IssueTree";
import { IssueRoadmap } from "./IssueRoadmap";
import { groupIssuesByMilestone } from "./issueTree.logic";
import {
  filterAndSortIssues,
  viewerRepositoriesFirst,
  issueListStateFor,
  issueStateFilter,
  mergeIssueRepositoryTargets,
  repositoryKey,
  repositoryKnownEmpty,
  repositoryListed,
  repositoryShown,
  sameRepository,
  type IssueRepositoryTarget,
} from "./issueWorkspace.logic";

type IssueError = {
  readonly title: string;
  readonly description: string;
  readonly retryAt?: number;
  readonly scopeUnavailable?: boolean;
};

type IssueTarget = Omit<IssueSurface, "id" | "kind">;

const isIssueReadError = Schema.is(IssueReadErrorClass);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationErrorClass);
const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);

function issueError(cause: Cause.Cause<unknown>, fallback: string | null): IssueError {
  const error = Cause.squash(cause);
  if (isIssueReadError(error)) {
    switch (error.code) {
      case "unauthenticated":
        return { title: "GitHub authentication required", description: error.message };
      case "verification-unavailable":
        return { title: "GitHub sign-in could not be verified", description: error.message };
      case "rate-limited":
        return {
          title: "GitHub rate limit reached",
          description: error.message,
          ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        };
      case "scope-unavailable":
        return {
          title: "Repository unavailable",
          description: error.message,
          scopeUnavailable: true,
        };
      case "unsupported":
      case "missing-tool":
        return { title: "GitHub issues unavailable", description: error.message };
      case "inaccessible":
        return { title: "Issue list unavailable", description: error.message };
      case "invalid-cursor":
      case "invalid-response":
        return { title: "GitHub returned an invalid issue response", description: error.message };
      case "upstream":
        return { title: "GitHub could not load issues", description: error.message };
    }
  }
  if (isEnvironmentAuthorizationError(error)) {
    return { title: "Environment authorization required", description: error.message };
  }
  if (isEnvironmentRpcUnavailableError(error)) {
    return { title: "Environment offline", description: "Reconnect this environment and retry." };
  }
  return {
    title: "Could not load issues",
    description: fallback ?? "The issue request failed. Retry to try again.",
  };
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function retryDeadline(retryAt: number): string {
  const date = new Date(retryAt);
  return Number.isNaN(date.getTime()) ? String(retryAt) : date.toLocaleString();
}

function issueListScopeKey(target: IssueListTarget): string {
  return JSON.stringify([
    target.environmentId,
    repositoryKey(target.input.host, target.input.repository),
    target.input.state ?? "open",
    target.roadmapView === true,
  ]);
}

type IssuePagingState = {
  readonly cursor: string | null;
  readonly generation: number;
  readonly snapshot: IssueListSnapshot | null;
  readonly refreshing: boolean;
};

/** The repositories every issue-capable environment can read, merged across environments. */
export function useIssueRepositoryTargets() {
  const { environments } = useEnvironments();
  const environmentsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const environmentLabels = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const capableEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.githubIssues === true,
          )
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const capableEnvironmentList = useMemo(
    () =>
      [...capableEnvironmentIds].toSorted((left, right) =>
        (environmentLabels.get(left) ?? left).localeCompare(environmentLabels.get(right) ?? right),
      ),
    [capableEnvironmentIds, environmentLabels],
  );
  const issueRepositories = useIssueRepositories(capableEnvironmentList);
  // ponytail: when two environments share a GitHub account, the first (by label) reads each
  // repository. Per-environment sections if that ever matters.
  const repositoryTargets = useMemo(
    () =>
      mergeIssueRepositoryTargets(
        capableEnvironmentList.flatMap((environmentId) => {
          const answer = issueRepositories.answers.find(
            (entry) => entry.environmentId === environmentId,
          );
          return answer === undefined
            ? []
            : [{ environmentId, repositories: answer.result.repositories }];
        }),
      ),
    [capableEnvironmentList, issueRepositories.answers],
  );
  const repositoryErrors = useMemo(
    () => issueRepositories.failures.map((failure) => issueError(failure.cause, null)),
    [issueRepositories.failures],
  );
  const capabilitiesKnown =
    environments.some((environment) => environment.serverConfig !== null) ||
    environmentsBootstrapped;
  return {
    environmentLabels,
    capableEnvironmentIds,
    capableEnvironmentList,
    issueRepositories,
    repositoryTargets,
    repositoryErrors,
    capabilitiesKnown,
  };
}

export interface IssueBrowserSearch {
  readonly host?: string | undefined;
  readonly repository?: string | undefined;
  readonly issueQuery?: string | undefined;
}

/**
 * The GitHub issue list: repositories and milestone groups under the Filter menu. The
 * Issues page and the right panel's Issues surface both render it and decide where a selected
 * issue opens.
 */
export function IssueBrowser({
  variant,
  repositories,
  search,
  onSearchChange,
  onShowAllRepositories,
  selectedIssue = null,
  onSelectIssue,
  onRefresh,
  headingRef,
  className,
}: {
  /** The page adds a back button and clears the collapsed sidebar's titlebar controls. */
  readonly variant: "page" | "panel";
  readonly repositories: ReturnType<typeof useIssueRepositoryTargets>;
  readonly search: IssueBrowserSearch;
  readonly onSearchChange: (patch: IssueBrowserSearch) => void;
  /** Clears a repository scope. */
  readonly onShowAllRepositories?: () => void;
  readonly selectedIssue?: IssueTarget | null;
  readonly onSelectIssue: (target: IssueTarget) => void;
  readonly onRefresh?: () => void;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly className?: string | undefined;
}) {
  const {
    environmentLabels,
    capableEnvironmentIds,
    capableEnvironmentList,
    issueRepositories,
    repositoryTargets,
    repositoryErrors,
    capabilitiesKnown,
  } = repositories;
  const [preferences, setPreferences] = useIssueFilterPreferences();
  const [savedViews, setViews] = useIssueViews();
  const views = useMemo<typeof savedViews>(
    () => (variant === "panel" ? savedViews : {}),
    [variant, savedViews],
  );
  const stateFilter = issueStateFilter(preferences);
  const listState = issueListStateFor(stateFilter ?? "open");
  const explicitScope = search.repository !== undefined;
  const urlRepository = useMemo(
    () =>
      search.repository === undefined
        ? null
        : (repositoryTargets.find((target) =>
            sameRepository(target, {
              host: search.host ?? target.host,
              repository: search.repository!,
            }),
          ) ?? null),
    [repositoryTargets, search.host, search.repository],
  );
  const scopedKey =
    urlRepository === null ? null : repositoryKey(urlRepository.host, urlRepository.repository);
  const explicitScopeMissing =
    explicitScope && urlRepository === null && !issueRepositories.isPending;
  // A repository link shows that repository whatever the Filter menu says.
  const shownRepositories = useMemo(() => {
    if (explicitScope)
      return urlRepository === null ||
        (stateFilter === null &&
          views[repositoryKey(urlRepository.host, urlRepository.repository)] !== "roadmap")
        ? []
        : [urlRepository];
    const host = search.host?.toLowerCase();
    return repositoryTargets.filter(
      (target) =>
        (stateFilter !== null ||
          views[repositoryKey(target.host, target.repository)] === "roadmap") &&
        (host === undefined || target.host === host) &&
        repositoryShown(target, preferences),
    );
  }, [
    explicitScope,
    preferences,
    repositoryTargets,
    search.host,
    stateFilter,
    urlRepository,
    views,
  ]);
  const baseListTargets = useMemo<ReadonlyArray<IssueListTarget>>(
    () =>
      shownRepositories
        .filter(
          (target) =>
            !repositoryKnownEmpty(
              target,
              views[repositoryKey(target.host, target.repository)] === "roadmap"
                ? "open"
                : (stateFilter ?? "open"),
            ),
        )
        .map((target) => {
          const roadmapView = views[repositoryKey(target.host, target.repository)] === "roadmap";
          // Every view reads blockers and live work so issue circles show blocked and in progress.
          return {
            environmentId: target.environmentId,
            roadmapView,
            live: explicitScope,
            input: {
              host: target.host,
              repository: target.repository,
              state: roadmapView ? "open" : listState,
              roadmap: true,
            },
          };
        }),
    [explicitScope, listState, shownRepositories, stateFilter, views],
  );
  const [pagingByKey, setPagingByKey] = useState<Record<string, IssuePagingState>>({});
  const generationRef = useRef(0);
  const listTargets = useMemo(
    () =>
      baseListTargets.flatMap((target) => {
        const state = pagingByKey[issueListScopeKey(target)];
        const cursors = new Set<string | null>([state?.cursor ?? null]);
        if ((target.roadmapView || target.live) && !state?.refreshing) cursors.add(null);
        return [...cursors].map((cursor) => ({
          ...target,
          input: { ...target.input, ...(cursor === null ? {} : { cursor }) },
        }));
      }),
    [baseListTargets, pagingByKey],
  );
  const issueLists = useIssueLists(listTargets);
  const liveIssueWork = useLiveIssueWork();
  const issueErrors = useMemo(() => {
    const errors = new Map<string, IssueError>();
    for (const failure of issueLists.failures) {
      errors.set(issueListScopeKey(failure.target), issueError(failure.cause, null));
    }
    return errors;
  }, [issueLists.failures]);

  useEffect(() => {
    if (issueLists.answers.length === 0) return;
    setPagingByKey((current) => {
      let next = current;
      for (const answer of issueLists.answers) {
        if (answer.waiting) continue;
        const key = issueListScopeKey(answer.target);
        const cursor = answer.target.input.cursor ?? null;
        const state =
          next[key] ??
          ({
            cursor: null,
            generation: generationRef.current,
            snapshot: null,
            refreshing: false,
          } satisfies IssuePagingState);
        const snapshot = acceptIssueListPage(state.snapshot, {
          scopeKey: key,
          generation: state.generation,
          cursor,
          result: answer.result,
        });
        if (snapshot === state.snapshot && !state.refreshing) continue;
        if (next === current) next = { ...current };
        next[key] = {
          ...state,
          cursor:
            state.snapshot?.pages.has(state.cursor ?? "") &&
            snapshot !== null &&
            !snapshot.pages.has(state.cursor ?? "")
              ? null
              : state.cursor,
          snapshot: snapshot ?? state.snapshot,
          refreshing: false,
        };
      }
      return next;
    });
  }, [issueLists.answers]);

  useEffect(() => {
    if (issueLists.failures.length === 0) return;
    setPagingByKey((current) => {
      let next = current;
      for (const failure of issueLists.failures) {
        const key = issueListScopeKey(failure.target);
        const state = current[key];
        if (state?.refreshing !== true) continue;
        if (next === current) next = { ...current };
        next[key] = { ...state, refreshing: false };
      }
      return next;
    });
  }, [issueLists.failures]);

  const refreshIssues = useCallback(() => {
    const nextGeneration = generationRef.current + 1;
    generationRef.current = nextGeneration;
    setPagingByKey((current) => {
      const next = { ...current };
      for (const target of baseListTargets) {
        const key = issueListScopeKey(target);
        const state = current[key];
        next[key] = {
          cursor: null,
          generation: nextGeneration,
          snapshot: state?.snapshot ?? null,
          refreshing: true,
        };
      }
      return next;
    });
    onRefresh?.();
    issueRepositories.refresh();
    issueLists.refresh(baseListTargets);
  }, [baseListTargets, issueLists, issueRepositories, onRefresh]);
  const loadMore = useCallback((key: string) => {
    setPagingByKey((current) => {
      const state = current[key];
      if (
        state === undefined ||
        state.refreshing ||
        state.snapshot?.generation !== state.generation ||
        state.snapshot.nextCursor === null ||
        state.snapshot.nextCursor === undefined
      ) {
        return current;
      }
      return { ...current, [key]: { ...state, cursor: state.snapshot.nextCursor } };
    });
  }, []);
  const selectIssue = (
    issue: IssueSummary,
    target: IssueRepositoryTarget,
    snapshot: IssueListSnapshot | null,
  ) =>
    onSelectIssue({
      environmentId: target.environmentId,
      host: snapshot?.repository.host ?? target.host,
      repository: snapshot?.repository.repository ?? target.repository,
      number: issue.number,
      ...(safeExternalUrl(issue.url) ? { url: issue.url } : {}),
    });

  const refreshing = Object.values(pagingByKey).some((state) => state.refreshing);
  const hosts = [...new Set(repositoryTargets.map((target) => target.host))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const query = search.issueQuery ?? "";
  const filters = {
    query,
    state: stateFilter ?? "open",
    sort: preferences.sort,
    milestone: preferences.milestone,
    assignee: preferences.assignee,
  };
  const narrowed = query.trim() !== "" || filters.milestone !== "all" || filters.assignee !== "all";
  const stateNoun = (count: number, state: "all" | "open" | "closed" = filters.state) =>
    state === "all" ? (count === 1 ? "issue" : "issues") : state;
  const viewerLogins = [
    ...new Set(issueRepositories.answers.map((answer) => answer.result.viewer.login)),
  ];
  const fetchedAt = Object.values(pagingByKey).reduce<string | null>(
    (latest, state) =>
      state.snapshot !== null && (latest === null || state.snapshot.fetchedAt > latest)
        ? state.snapshot.fetchedAt
        : latest,
    null,
  );

  // Owners and repositories start collapsed, as a compact overview. A search, a repository
  // link, a failure or the open issue opens them; a user's own choice wins after that.
  const [expansionChoices, setExpansionChoices] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const isExpanded = (key: string, openByDefault: boolean) =>
    expansionChoices.get(key) ?? openByDefault;
  const toggleExpanded = (key: string, expanded: boolean) =>
    setExpansionChoices((current) => new Map(current).set(key, !expanded));

  const repositoryEntries = shownRepositories.flatMap((target) => {
    const key = repositoryKey(target.host, target.repository);
    const baseTarget = baseListTargets.find(
      (candidate) =>
        candidate.environmentId === target.environmentId && sameRepository(candidate.input, target),
    );
    const scopeKey = baseTarget === undefined ? null : issueListScopeKey(baseTarget);
    const state = scopeKey === null ? undefined : pagingByKey[scopeKey];
    const cachedSnapshot = state?.snapshot ?? null;
    const snapshot =
      cachedSnapshot === null ? null : liveIssueWork(cachedSnapshot, target.environmentId);
    const error = scopeKey === null ? null : (issueErrors.get(scopeKey) ?? null);
    const filteredIssues = snapshot
      ? filterAndSortIssues(
          snapshot.issues,
          views[key] === "roadmap" ? { ...filters, state: "open" } : filters,
          target.repository,
        )
      : [];
    const settled = scopeKey === null || (snapshot !== null && snapshot.issuesComplete && !error);
    const count = filteredIssues.length;
    const pinned = preferences.pinned.includes(key);
    if (!explicitScope && !repositoryListed({ count, settled, pinned }, preferences, narrowed)) {
      return [];
    }
    const selectedIssueNumber =
      selectedIssue !== null &&
      selectedIssue.environmentId === target.environmentId &&
      sameRepository(selectedIssue, target)
        ? selectedIssue.number
        : undefined;
    const entryState = views[key] === "roadmap" ? "open" : filters.state;
    const countLabel: ReactNode =
      scopeKey === null ? (
        `0 ${stateNoun(0, entryState)}`
      ) : snapshot === null && error === null ? (
        <Spinner className="size-3" />
      ) : snapshot === null ? (
        <span className="text-warning-foreground">unavailable</span>
      ) : (
        `${count}${snapshot.issuesComplete ? "" : "+"} ${stateNoun(count, entryState)}`
      );
    return [
      {
        ...target,
        key,
        scopeKey,
        state,
        snapshot,
        error,
        filteredIssues,
        count,
        settled,
        pinned,
        countLabel,
        selectedIssueNumber,
      },
    ];
  });
  type RepositoryEntry = (typeof repositoryEntries)[number];
  const listedRepositories = viewerRepositoriesFirst(repositoryEntries, viewerLogins);
  const viewerOwners = new Set(viewerLogins.map((login) => login.toLowerCase()));
  const openAll = explicitScope || query.trim() !== "";
  const totalCount = repositoryEntries.reduce((sum, entry) => sum + entry.count, 0);
  const totalIncomplete = repositoryEntries.some((entry) => !entry.settled);

  const togglePinned = (key: string, pinned: boolean) =>
    setPreferences((current) => ({
      ...current,
      pinned: pinned ? current.pinned.filter((entry) => entry !== key) : [...current.pinned, key],
    }));

  const renderRepositoryBody = (entry: RepositoryEntry) => {
    const { scopeKey, state, snapshot, error, filteredIssues } = entry;
    const message = (text: string) => (
      <p className="py-1.5 ps-6 pe-4 text-xs text-muted-foreground">{text}</p>
    );
    if (scopeKey === null)
      return message(`No ${views[entry.key] === "roadmap" ? "open" : filters.state} issues`);
    if (snapshot === null && error === null) {
      return (
        <div className="flex items-center gap-2 py-1.5 ps-6 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          Loading issues
        </div>
      );
    }
    if (snapshot === null && error !== null) {
      return (
        <div className="my-1 ms-10 me-3 flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-sm">
          <div>
            <p className="font-medium">{error.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{error.description}</p>
            {error.retryAt !== undefined ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Retry after {retryDeadline(error.retryAt)}.
              </p>
            ) : null}
          </div>
          <Button onClick={refreshIssues} size="xs" variant="outline">
            Retry
          </Button>
        </div>
      );
    }
    if (snapshot === null) return null;
    // Empty milestones are context in the full list and noise in narrowed results.
    const groups = groupIssuesByMilestone(snapshot.milestones, filteredIssues)
      .map((group) => ({
        ...group,
        issues: filterAndSortIssues(group.issues, filters, entry.repository),
      }))
      .filter((group) => !narrowed || group.issues.length > 0);
    const pending =
      issueLists.answers.some(
        (answer) => issueListScopeKey(answer.target) === scopeKey && answer.waiting,
      ) || state?.refreshing === true;
    return (
      <>
        {variant === "panel" && !explicitScope ? (
          <label className="mx-6 mb-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Switch
              size="sm"
              checked={views[entry.key] === "roadmap"}
              onCheckedChange={(checked) =>
                setViews((current) => ({
                  ...current,
                  [entry.key]: checked ? "roadmap" : "milestones",
                }))
              }
            />
            Roadmap view
          </label>
        ) : null}
        {views[entry.key] === "roadmap" ? (
          <IssueRoadmap
            scope={entry}
            environmentId={entry.environmentId}
            milestones={snapshot.milestones}
            issues={snapshot.issues}
            visibleNumbers={new Set(filteredIssues.map((issue) => issue.number))}
            onSelect={(issue) => selectIssue(issue, entry, snapshot)}
            {...(entry.selectedIssueNumber === undefined
              ? {}
              : { selectedIssueNumber: entry.selectedIssueNumber })}
          />
        ) : filteredIssues.length > 0 ? (
          <IssueTree
            key={scopeKey}
            environmentId={entry.environmentId}
            renderMilestoneActions={(milestone) => (
              <IssueMilestoneControls
                environmentId={entry.environmentId}
                reference={{ host: entry.host, repository: entry.repository }}
                milestone={milestone}
              />
            )}
            groups={groups}
            issuesComplete={snapshot.issuesComplete}
            onSelect={(issue) => selectIssue(issue, entry, snapshot)}
            {...(entry.selectedIssueNumber === undefined
              ? {}
              : { selectedIssueNumber: entry.selectedIssueNumber })}
          />
        ) : snapshot.issues.length > 0 && narrowed ? (
          message("No issues match these filters")
        ) : snapshot.issuesComplete ? (
          message(`No ${filters.state === "all" ? "" : `${filters.state} `}issues`)
        ) : (
          message("No matching issues loaded yet")
        )}
        {error !== null ? (
          <div className="my-1 ms-10 me-3 flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs">
            <span>{error.title}. Showing the last issues loaded.</span>
            <Button onClick={refreshIssues} size="xs" variant="outline">
              Retry
            </Button>
          </div>
        ) : null}
        {snapshot.nextCursor !== null ? (
          <div className="py-1 ps-6">
            <Button
              disabled={pending}
              onClick={() => loadMore(scopeKey)}
              size="xs"
              variant="outline"
            >
              {pending ? <Spinner className="size-3" /> : null}
              Load more issues
            </Button>
          </div>
        ) : null}
      </>
    );
  };

  // A pane scoped to one project already names it, so its issues show without a repository row.
  const scopedToOne = explicitScope && urlRepository !== null;
  const repositoryTree = listedRepositories.map((entry) => {
    if (scopedToOne)
      return (
        <section key={entry.key}>
          <IssueRepositoryControls
            environmentId={entry.environmentId}
            reference={{ host: entry.host, repository: entry.repository }}
          />
          <IssueInboxSection
            issues={entry.snapshot?.issues}
            environmentId={entry.environmentId}
            reference={{ host: entry.host, repository: entry.repository }}
          />
          {renderRepositoryBody(entry)}
        </section>
      );
    const repositoryOpen = isExpanded(
      `repository:${entry.key}`,
      openAll || entry.error !== null || entry.selectedIssueNumber !== undefined,
    );
    const panelId = `issue-repository-${entry.key.replace(/[^a-z0-9_-]/gi, "-")}`;
    return (
      <section key={entry.key}>
        <div className="group/repository flex items-center">
          <IssueTreeRow
            level={0}
            controls={panelId}
            expanded={repositoryOpen}
            onToggle={() => toggleExpanded(`repository:${entry.key}`, repositoryOpen)}
            count={entry.countLabel}
          >
            <span className="min-w-0 truncate text-sm font-medium">
              {/* Another owner's repository keeps its owner so a fork and its upstream stay apart. */}
              {viewerOwners.has(entry.owner.toLowerCase()) ? null : (
                <span className="font-normal text-muted-foreground">{entry.owner}/</span>
              )}
              {entry.repository.slice(entry.repository.indexOf("/") + 1)}
            </span>
            {hosts.length > 1 ? (
              <span className="truncate text-2xs text-muted-foreground">{entry.host}</span>
            ) : null}
            {entry.isPrivate ? (
              <LockIcon aria-label="Private" className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
            {entry.isArchived ? <IssueTreeTag>Archived</IssueTreeTag> : null}
            {entry.isFork ? <IssueTreeTag>Fork</IssueTreeTag> : null}
            {entry.pinned ? <IssueTreeTag>Pinned</IssueTreeTag> : null}
            {capableEnvironmentList.length > 1 ? (
              <span className="truncate text-2xs text-muted-foreground">
                {environmentLabels.get(entry.environmentId) ?? entry.environmentId}
              </span>
            ) : null}
          </IssueTreeRow>
          {/* Unpinned, the pin shows on row hover or focus; the wrapper owns that fade. */}
          <span
            className={
              entry.pinned
                ? "shrink-0"
                : "shrink-0 opacity-0 pointer-coarse:opacity-100 group-hover/repository:opacity-100 focus-within:opacity-100"
            }
          >
            <Button
              aria-label={
                entry.pinned ? `Unpin ${entry.repository}` : `Always show ${entry.repository}`
              }
              title={entry.pinned ? "Unpin" : "Always show, whatever the filters say"}
              aria-pressed={entry.pinned}
              onClick={() => togglePinned(entry.key, entry.pinned)}
              size="icon-xs"
              variant="ghost"
            >
              {entry.pinned ? <PinOffIcon /> : <PinIcon />}
            </Button>
          </span>
        </div>
        {repositoryOpen ? (
          <div id={panelId}>
            <IssueRepositoryControls
              environmentId={entry.environmentId}
              reference={{ host: entry.host, repository: entry.repository }}
            />
            <IssueInboxSection
              issues={entry.snapshot?.issues}
              environmentId={entry.environmentId}
              reference={{ host: entry.host, repository: entry.repository }}
            />
            {renderRepositoryBody(entry)}
          </div>
        ) : null}
      </section>
    );
  });

  const showAllRepositories =
    onShowAllRepositories && repositoryTargets.length > 0 ? (
      <Button onClick={onShowAllRepositories} size="xs" variant="outline">
        Show all repositories
      </Button>
    ) : null;

  const listContent = !capabilitiesKnown ? (
    <div className="flex min-h-56 items-center justify-center">
      <Spinner className="size-4" />
    </div>
  ) : capableEnvironmentIds.size === 0 ? (
    <Empty className="min-h-56 flex-none">
      <EmptyHeader>
        <EmptyTitle>Issues unavailable</EmptyTitle>
        <EmptyDescription>Update a T3 Code server with GitHub Issues support.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : repositoryTargets.length === 0 && issueRepositories.isPending ? (
    <div className="flex min-h-56 items-center justify-center gap-2 text-xs text-muted-foreground">
      <Spinner className="size-4" />
      Loading repositories and issues
    </div>
  ) : repositoryTargets.length === 0 && repositoryErrors.length > 0 ? (
    <Empty className="min-h-56 flex-none">
      <EmptyHeader>
        <EmptyTitle>{repositoryErrors[0]!.title}</EmptyTitle>
        <EmptyDescription>{repositoryErrors[0]!.description}</EmptyDescription>
      </EmptyHeader>
      <Button onClick={refreshIssues} size="xs" variant="outline">
        Retry
      </Button>
    </Empty>
  ) : explicitScopeMissing ? (
    <Empty className="min-h-56 flex-none">
      <EmptyHeader>
        <EmptyTitle>Repository unavailable</EmptyTitle>
        <EmptyDescription>
          This repository is not one you own or administer on GitHub.
        </EmptyDescription>
      </EmptyHeader>
      {showAllRepositories}
    </Empty>
  ) : repositoryTargets.length === 0 ? (
    <Empty className="min-h-56 flex-none">
      <EmptyHeader>
        <EmptyTitle>No GitHub repositories</EmptyTitle>
        <EmptyDescription>
          No repositories you own or administer have issues enabled.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : stateFilter === null ? (
    <Empty className="min-h-56 flex-none">
      <EmptyHeader>
        <EmptyTitle>No issue states shown</EmptyTitle>
        <EmptyDescription>Select Open or Closed in Filter to show issues.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <>
      {/* A repository scope already names its one repository in the header. */}
      {explicitScope && urlRepository !== null ? null : (
        <div className="flex items-baseline justify-between px-4 pb-1.5 text-2xs text-muted-foreground">
          <span className="font-semibold uppercase tracking-wide">Repositories</span>
          <span className="tabular-nums">
            {repositoryEntries.length} of {repositoryTargets.length} shown
          </span>
        </div>
      )}
      {listedRepositories.length > 0 ? (
        <div className="px-2 pb-2">{repositoryTree}</div>
      ) : (
        <Empty size="compact" className="min-h-40 flex-none">
          <EmptyHeader>
            <EmptyTitle>No repositories match these filters</EmptyTitle>
            <EmptyDescription>Change the filters or search to show repositories.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {fetchedAt !== null ? (
        <p className="px-4 pb-4 text-right text-2xs text-muted-foreground">
          Updated{" "}
          {new Date(fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </p>
      ) : null}
    </>
  );

  const Heading = variant === "page" ? "h1" : "h2";
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <header
        className={cn(
          "shrink-0 border-b border-border/60 px-4 py-3",
          variant === "page" && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <div className="flex items-center gap-2">
          {variant === "page" ? <PageBackButton /> : null}
          <IssueStateIcon issue={{ state: "open" }} />
          <Heading
            ref={headingRef}
            tabIndex={-1}
            className="min-w-0 flex-1 text-base font-semibold outline-none"
          >
            GitHub Issues
          </Heading>
          {viewerLogins.map((login) => (
            <span
              key={login}
              className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-success" />
              {login}
            </span>
          ))}
          <Button
            disabled={refreshing || baseListTargets.length === 0}
            onClick={refreshIssues}
            size="xs"
            variant="outline"
          >
            <RefreshCwIcon aria-hidden className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <InputGroup className="min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Find a repository or issue"
              onChange={(event) => onSearchChange({ issueQuery: event.target.value || undefined })}
              placeholder="Find a repository or issue"
              type="search"
              value={query}
            />
          </InputGroup>
          <IssueFilterMenu
            host={explicitScope ? "" : (search.host ?? "")}
            hosts={explicitScope ? [] : hosts}
            onChange={setPreferences}
            onHostChange={(host) => onSearchChange({ host: host || undefined })}
            preferences={preferences}
            view={
              variant === "panel" && scopedKey !== null
                ? {
                    value: views[scopedKey] ?? "milestones",
                    onChange: (value) =>
                      setViews((current) => ({ ...current, [scopedKey]: value })),
                  }
                : undefined
            }
          />
          {stateFilter !== null && repositoryEntries.length > 0 ? (
            <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
              {totalCount}
              {totalIncomplete ? "+" : ""}{" "}
              {stateNoun(
                totalCount,
                repositoryEntries.some((entry) => views[entry.key] === "roadmap")
                  ? "all"
                  : filters.state,
              )}
            </span>
          ) : null}
        </div>
        {explicitScope && urlRepository !== null && showAllRepositories ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            {showAllRepositories}
          </div>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pt-3">{listContent}</div>
    </section>
  );
}

/**
 * The issue list as a right-panel surface beside a thread; an issue opens in a tab next to it.
 * The tab's saved scope narrows it to one repository until "Show all repositories" widens it.
 * The newest issue tab stays selected, so returning to the list reopens the tree where it was.
 */
export function IssueListPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const repositories = useIssueRepositoryTargets();
  const [search, setSearch] = useState<IssueBrowserSearch>({});
  const scope = useRightPanelStore(
    (state) =>
      selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces.find(
        (surface) => surface.kind === "issues",
      )?.scope ?? null,
  );
  const lastIssue = useRightPanelStore(
    (state) =>
      selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces.findLast(
        (surface) => surface.kind === "issue",
      ) ?? null,
  );
  return (
    <IssueBrowser
      variant="panel"
      repositories={repositories}
      search={scope === null ? search : { ...search, ...scope }}
      onSearchChange={(patch) => setSearch((current) => ({ ...current, ...patch }))}
      {...(scope === null
        ? {}
        : {
            onShowAllRepositories: () =>
              useRightPanelStore.getState().openIssueList(threadRef, null),
          })}
      selectedIssue={lastIssue?.kind === "issue" ? lastIssue : null}
      onSelectIssue={(target) => useRightPanelStore.getState().openIssue(threadRef, target)}
    />
  );
}
