import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import {
  EnvironmentAuthorizationError as EnvironmentAuthorizationErrorClass,
  IssueReadError as IssueReadErrorClass,
  type EnvironmentId,
  type IssueListState,
  type IssueRef,
  type IssueSummary,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CircleDotIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { IssueDetailPanel } from "../components/issues/IssueDetailPanel";
import { IssueTree } from "../components/issues/IssueTree";
import {
  acceptIssueListPage,
  type IssueListSnapshot,
} from "../components/issues/issuePaging.logic";
import { groupIssuesByMilestone } from "../components/issues/issueTree.logic";
import {
  filterAndSortIssues,
  mergeIssueRepositoryTargets,
  repositoryKey,
  visibleIssueRepositoryTargets,
  type IssueRepositoryTarget,
  type IssueAssigneeFilter,
  type IssueMilestoneFilter,
  type IssueSort,
} from "../components/issues/issueWorkspace.logic";
import { RightPanelTabs } from "../components/RightPanelTabs";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePanelAnimationSettings, usePanelPresence } from "../panelAnimations";
import {
  ISSUES_PANEL_REF,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  selectActiveRightPanelSurface,
  issueSurface,
  useRightPanelStore,
  type IssueSurface,
  type RightPanelSurface,
} from "../rightPanelStore";
import { useAllEnvironmentShellsBootstrapped, useThreadShell } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useIssueLists, useIssueRepositories, type IssueListTarget } from "../state/issues";
import { cn } from "~/lib/utils";

export interface IssuesSearch {
  readonly environmentId?: EnvironmentId;
  readonly host?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly issueQuery?: string;
  readonly issueSort?: IssueSort;
  readonly issueMilestone?: IssueMilestoneFilter;
  readonly issueAssignee?: IssueAssigneeFilter;
  readonly issueState?: IssueListState;
  readonly selectedEnvironmentId?: EnvironmentId;
  readonly selectedHost?: string;
  readonly selectedRepository?: string;
  readonly selectedNumber?: number;
  readonly originThreadId?: ThreadId;
}

type IssuesSearchPatch = {
  readonly [Key in keyof IssuesSearch]?: IssuesSearch[Key] | undefined;
};

type IssueError = {
  readonly title: string;
  readonly description: string;
  readonly retryAt?: number;
  readonly scopeUnavailable?: boolean;
};

const EMPTY_SURFACES: ReadonlyArray<RightPanelSurface> = [];
const EMPTY_PENDING_SURFACES = new Set<string>();

const isIssueReadError = Schema.is(IssueReadErrorClass);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationErrorClass);
const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);

function optionalString(value: unknown, maxLength = 253): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function sameRepository(
  left: { readonly host: string; readonly repository: string },
  right: { readonly host: string; readonly repository: string },
): boolean {
  return repositoryKey(left.host, left.repository) === repositoryKey(right.host, right.repository);
}

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
  ]);
}

type IssuePagingState = {
  readonly cursor: string | null;
  readonly generation: number;
  readonly snapshot: IssueListSnapshot | null;
  readonly refreshing: boolean;
};

const DEFAULT_ISSUE_SORT: IssueSort = "updated";
const DEFAULT_ISSUE_MILESTONE_FILTER: IssueMilestoneFilter = "all";
const DEFAULT_ISSUE_ASSIGNEE_FILTER: IssueAssigneeFilter = "all";

function issueSort(value: IssueSort | undefined): IssueSort {
  return value === "oldest" || value === "number" || value === "title" ? value : DEFAULT_ISSUE_SORT;
}

function issueMilestoneFilter(value: IssueMilestoneFilter | undefined): IssueMilestoneFilter {
  return value === "with" || value === "without" ? value : DEFAULT_ISSUE_MILESTONE_FILTER;
}

function issueListState(value: IssueListState | undefined): IssueListState {
  return value === "all" ? value : "open";
}

function issueAssigneeFilter(value: IssueAssigneeFilter | undefined): IssueAssigneeFilter {
  return value === "assigned" || value === "unassigned" ? value : DEFAULT_ISSUE_ASSIGNEE_FILTER;
}

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (raw: Record<string, unknown>): IssuesSearch => {
    const environmentId = optionalString(raw.environmentId, 200);
    const host = optionalString(raw.host);
    const repository = optionalString(raw.repository, 200);
    const number = optionalNumber(raw.number);
    const issueQuery = optionalString(raw.issueQuery, 200);
    const issueSortValue = optionalString(raw.issueSort) as IssueSort | undefined;
    const issueMilestoneValue = optionalString(raw.issueMilestone) as
      | IssueMilestoneFilter
      | undefined;
    const issueAssigneeValue = optionalString(raw.issueAssignee) as IssueAssigneeFilter | undefined;
    const issueStateValue = optionalString(raw.issueState) as IssueListState | undefined;
    const selectedEnvironmentId = optionalString(raw.selectedEnvironmentId, 200);
    const selectedHost = optionalString(raw.selectedHost);
    const selectedRepository = optionalString(raw.selectedRepository, 200);
    const selectedNumber = optionalNumber(raw.selectedNumber);
    const originThreadId = optionalString(raw.originThreadId, 200);
    const result: IssuesSearch = {
      ...(environmentId === undefined ? {} : { environmentId: environmentId as EnvironmentId }),
      ...(host === undefined ? {} : { host }),
      ...(repository === undefined ? {} : { repository }),
      ...(number === undefined ? {} : { number }),
      ...(issueQuery === undefined ? {} : { issueQuery }),
      ...(issueSortValue === undefined ? {} : { issueSort: issueSortValue }),
      ...(issueMilestoneValue === undefined ? {} : { issueMilestone: issueMilestoneValue }),
      ...(issueAssigneeValue === undefined ? {} : { issueAssignee: issueAssigneeValue }),
      ...(issueStateValue === undefined ? {} : { issueState: issueStateValue }),
      ...(selectedEnvironmentId === undefined
        ? {}
        : { selectedEnvironmentId: selectedEnvironmentId as EnvironmentId }),
      ...(selectedHost === undefined ? {} : { selectedHost }),
      ...(selectedRepository === undefined ? {} : { selectedRepository }),
      ...(selectedNumber === undefined ? {} : { selectedNumber }),
      ...(originThreadId === undefined ? {} : { originThreadId: originThreadId as ThreadId }),
    };
    return result;
  },
  component: IssuesRouteView,
});

function IssuesRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const isNarrow = useMediaQuery("max-md");
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
  const listState = issueListState(search.issueState);
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
  const originThreadRef = useMemo<ScopedThreadRef | null>(
    () =>
      search.environmentId !== undefined && search.originThreadId !== undefined
        ? scopeThreadRef(search.environmentId, search.originThreadId)
        : null,
    [search.environmentId, search.originThreadId],
  );
  const originThread = useThreadShell(originThreadRef);
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
  const explicitScopeMissing =
    explicitScope && urlRepository === null && !issueRepositories.isPending;
  const visibleRepositories = useMemo(
    () =>
      explicitScope
        ? urlRepository === null
          ? []
          : [urlRepository]
        : visibleIssueRepositoryTargets(repositoryTargets, {
            host: search.host,
            state: listState,
          }),
    [explicitScope, listState, repositoryTargets, search.host, urlRepository],
  );
  const hiddenEmptyRepositoryCount = explicitScope
    ? 0
    : repositoryTargets.length - visibleRepositories.length;
  const baseListTargets = useMemo<ReadonlyArray<IssueListTarget>>(
    () =>
      visibleRepositories.map((target) => ({
        environmentId: target.environmentId,
        input: { host: target.host, repository: target.repository, state: listState },
      })),
    [listState, visibleRepositories],
  );
  const [pagingByKey, setPagingByKey] = useState<Record<string, IssuePagingState>>({});
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const generationRef = useRef(0);
  const listTargets = useMemo(
    () =>
      baseListTargets.map((target) => {
        const state = pagingByKey[issueListScopeKey(target)];
        return {
          ...target,
          input: {
            ...target.input,
            ...(state?.cursor === null || state?.cursor === undefined
              ? {}
              : { cursor: state.cursor }),
          },
        };
      }),
    [baseListTargets, pagingByKey],
  );
  const issueLists = useIssueLists(listTargets);
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
          current[key] ??
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
        next[key] = { ...state, snapshot: snapshot ?? state.snapshot, refreshing: false };
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

  const updateSearch = useCallback(
    (patch: IssuesSearchPatch) =>
      void navigate({
        replace: true,
        search: (previous: IssuesSearch): IssuesSearch => {
          const next = { ...previous, ...patch };
          return {
            ...(next.environmentId ? { environmentId: next.environmentId } : {}),
            ...(next.host ? { host: next.host } : {}),
            ...(next.repository ? { repository: next.repository } : {}),
            ...(next.number ? { number: next.number } : {}),
            ...(next.issueQuery ? { issueQuery: next.issueQuery } : {}),
            ...(next.issueSort ? { issueSort: next.issueSort } : {}),
            ...(next.issueMilestone ? { issueMilestone: next.issueMilestone } : {}),
            ...(next.issueAssignee ? { issueAssignee: next.issueAssignee } : {}),
            ...(next.issueState === "all" ? { issueState: next.issueState } : {}),
            ...(next.selectedEnvironmentId
              ? { selectedEnvironmentId: next.selectedEnvironmentId }
              : {}),
            ...(next.selectedHost ? { selectedHost: next.selectedHost } : {}),
            ...(next.selectedRepository ? { selectedRepository: next.selectedRepository } : {}),
            ...(next.selectedNumber ? { selectedNumber: next.selectedNumber } : {}),
            ...(next.originThreadId ? { originThreadId: next.originThreadId } : {}),
          };
        },
      }),
    [navigate],
  );

  const selectRepository = useCallback(
    (target: IssueRepositoryTarget | null) => {
      updateSearch({
        host: target?.host,
        repository: target?.repository,
        number: undefined,
        selectedEnvironmentId: undefined,
        selectedHost: undefined,
        selectedRepository: undefined,
        selectedNumber: undefined,
      });
    },
    [updateSearch],
  );
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
    setDetailRefreshToken((token) => token + 1);
    issueRepositories.refresh();
    issueLists.refresh(baseListTargets);
  }, [baseListTargets, issueLists, issueRepositories]);
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

  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, ISSUES_PANEL_REF),
  );
  const selectedRightPanelSurface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, ISSUES_PANEL_REF),
  );
  const activeIssueSurface =
    rightPanelState.isOpen && selectedRightPanelSurface?.kind === "issue"
      ? selectedRightPanelSurface
      : null;
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const rightPanelPresence = usePanelPresence(
    rightPanelState.isOpen && selectedRightPanelSurface !== null,
    { activeSurface: selectedRightPanelSurface, surfaces: rightPanelState.surfaces },
    panelAnimationsActive,
    ISSUES_PANEL_REF.threadId,
    panelAnimationDurationMs,
  );
  const renderedSurface = rightPanelPresence.value?.activeSurface ?? null;
  const renderedIssueSurface = renderedSurface?.kind === "issue" ? renderedSurface : null;
  const renderedSurfaces = rightPanelPresence.value?.surfaces ?? EMPTY_SURFACES;
  const resolveSurfaceEnvironmentId = useCallback(
    (surface: IssueSurface): EnvironmentId | null => {
      if (surface.environmentId !== undefined) return surface.environmentId as EnvironmentId;
      return (
        repositoryTargets.find((target) => sameRepository(target, surface))?.environmentId ?? null
      );
    },
    [repositoryTargets],
  );
  const panelEnvironmentId = renderedIssueSurface
    ? resolveSurfaceEnvironmentId(renderedIssueSurface)
    : null;
  const syncSelectedSurface = useCallback(
    (surface: IssueSurface | null) =>
      updateSearch(
        surface === null
          ? {
              selectedEnvironmentId: undefined,
              selectedHost: undefined,
              selectedRepository: undefined,
              selectedNumber: undefined,
            }
          : {
              selectedEnvironmentId: surface.environmentId as EnvironmentId | undefined,
              selectedHost: surface.host,
              selectedRepository: surface.repository,
              selectedNumber: surface.number,
            },
      ),
    [updateSearch],
  );
  const activateSurface = useCallback(
    (surface: IssueSurface) => {
      useRightPanelStore.getState().activateSurface(ISSUES_PANEL_REF, surface.id);
      syncSelectedSurface(surface);
    },
    [syncSelectedSurface],
  );
  const closeSurface = useCallback(
    (surface: IssueSurface) => {
      useRightPanelStore.getState().closeSurface(ISSUES_PANEL_REF, surface.id);
      const next = selectActiveRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        ISSUES_PANEL_REF,
      );
      syncSelectedSurface(next?.kind === "issue" ? next : null);
    },
    [syncSelectedSurface],
  );
  const closeOtherSurfaces = useCallback(
    (surface: IssueSurface) => {
      useRightPanelStore.getState().closeOtherSurfaces(ISSUES_PANEL_REF, surface.id);
      syncSelectedSurface(surface);
    },
    [syncSelectedSurface],
  );
  const closeSurfacesToRight = useCallback(
    (surface: IssueSurface) => {
      useRightPanelStore.getState().closeSurfacesToRight(ISSUES_PANEL_REF, surface.id);
      syncSelectedSurface(surface);
    },
    [syncSelectedSurface],
  );
  const closeAllSurfaces = useCallback(() => {
    useRightPanelStore.getState().closeAllSurfaces(ISSUES_PANEL_REF);
    syncSelectedSurface(null);
  }, [syncSelectedSurface]);
  const selectIssue = useCallback(
    (issue: IssueSummary, target: IssueRepositoryTarget, snapshot: IssueListSnapshot | null) => {
      const reference: IssueRef = {
        host: snapshot?.repository.host ?? target.host,
        repository: snapshot?.repository.repository ?? target.repository,
        number: issue.number,
      };
      const surfaceTarget = {
        ...reference,
        environmentId: target.environmentId,
        ...(safeExternalUrl(issue.url) ? { url: issue.url } : {}),
      };
      useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, surfaceTarget);
      syncSelectedSurface(issueSurface(surfaceTarget));
    },
    [syncSelectedSurface],
  );

  const selectedUrlTarget = useMemo(() => {
    if (search.selectedNumber === undefined || search.selectedRepository === undefined) return null;
    const host = search.selectedHost ?? "github.com";
    const environmentId =
      search.selectedEnvironmentId ??
      repositoryTargets.find((target) =>
        sameRepository(target, { host, repository: search.selectedRepository! }),
      )?.environmentId;
    if (environmentId === undefined) return null;
    return {
      environmentId,
      host,
      repository: search.selectedRepository,
      number: search.selectedNumber,
    };
  }, [
    repositoryTargets,
    search.selectedEnvironmentId,
    search.selectedHost,
    search.selectedNumber,
    search.selectedRepository,
  ]);
  const listUrlTarget = useMemo(
    () =>
      search.number === undefined || urlRepository === null
        ? null
        : {
            environmentId: urlRepository.environmentId,
            host: urlRepository.host,
            repository: urlRepository.repository,
            number: search.number,
          },
    [search.number, urlRepository],
  );
  const urlTarget = selectedUrlTarget ?? listUrlTarget;
  const openedUrlTargetKey = urlTarget
    ? `${urlTarget.environmentId}:${urlTarget.host}:${urlTarget.repository}:${urlTarget.number}`
    : null;
  const openedUrlTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      urlTarget === null ||
      openedUrlTargetKey === null ||
      openedUrlTargetRef.current === openedUrlTargetKey
    )
      return;
    openedUrlTargetRef.current = openedUrlTargetKey;
    useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, urlTarget);
  }, [openedUrlTargetKey, urlTarget]);

  const originThreadForSurface =
    activeIssueSurface &&
    originThreadRef !== null &&
    originThread !== null &&
    originThread.environmentId ===
      (activeIssueSurface.environmentId ?? originThreadRef.environmentId)
      ? originThreadRef
      : null;
  const openBesideThread = useCallback(() => {
    if (activeIssueSurface === null || originThreadForSurface === null) return;
    useRightPanelStore.getState().openIssue(originThreadForSurface, {
      environmentId: activeIssueSurface.environmentId ?? originThreadForSurface.environmentId,
      host: activeIssueSurface.host,
      repository: activeIssueSurface.repository,
      number: activeIssueSurface.number,
      ...(activeIssueSurface.url ? { url: activeIssueSurface.url } : {}),
    });
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: originThreadForSurface.environmentId,
        threadId: originThreadForSurface.threadId,
      },
    });
  }, [activeIssueSurface, navigate, originThreadForSurface]);

  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const narrowDetailRef = useRef<HTMLDivElement>(null);
  const showNarrowDetail =
    isNarrow &&
    rightPanelState.isOpen &&
    renderedIssueSurface !== null &&
    panelEnvironmentId !== null;
  useEffect(() => {
    if (showNarrowDetail) narrowDetailRef.current?.focus();
  }, [renderedIssueSurface?.id, showNarrowDetail]);
  const closeNarrowDetail = useCallback(() => {
    useRightPanelStore.getState().close(ISSUES_PANEL_REF);
    syncSelectedSurface(null);
    window.requestAnimationFrame(() => listHeadingRef.current?.focus());
  }, [syncSelectedSurface]);

  const capabilitiesKnown =
    environments.some((environment) => environment.serverConfig !== null) ||
    environmentsBootstrapped;
  const refreshing = Object.values(pagingByKey).some((state) => state.refreshing);
  const scopeUnavailable = [...issueErrors.values()].some((error) => error.scopeUnavailable);
  const selectedRepositoryKey =
    urlRepository === null ? "" : repositoryKey(urlRepository.host, urlRepository.repository);
  const hosts = [...new Set(repositoryTargets.map((target) => target.host))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const filters = {
    query: search.issueQuery ?? "",
    sort: issueSort(search.issueSort),
    milestone: issueMilestoneFilter(search.issueMilestone),
    assignee: issueAssigneeFilter(search.issueAssignee),
  };

  const repositoryChooser =
    repositoryTargets.length > 0 ? (
      <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="sr-only">GitHub repository</span>
        <select
          aria-label="GitHub repository"
          className="min-w-0 max-w-full rounded-[var(--control-radius)] border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={selectedRepositoryKey}
          onChange={(event) =>
            selectRepository(
              repositoryTargets.find(
                (target) => repositoryKey(target.host, target.repository) === event.target.value,
              ) ?? null,
            )
          }
        >
          <option value="">All repositories</option>
          {repositoryTargets.map((target) => (
            <option
              key={repositoryKey(target.host, target.repository)}
              value={repositoryKey(target.host, target.repository)}
            >
              {target.repository}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  const repositorySections = visibleRepositories.map((target) => {
    const baseTarget = baseListTargets.find(
      (candidate) =>
        candidate.environmentId === target.environmentId && sameRepository(candidate.input, target),
    );
    if (baseTarget === undefined) return null;
    const key = issueListScopeKey(baseTarget);
    const state = pagingByKey[key];
    const snapshot = state?.snapshot ?? null;
    const error = issueErrors.get(key) ?? null;
    const projectPending =
      issueLists.answers.some(
        (answer) => issueListScopeKey(answer.target) === key && answer.waiting,
      ) ||
      (snapshot === null && issueLists.isPending);
    const filteredIssues = snapshot ? filterAndSortIssues(snapshot.issues, filters) : [];
    const groups = snapshot
      ? groupIssuesByMilestone(snapshot.milestones, filteredIssues).map((group) => ({
          ...group,
          issues: filterAndSortIssues(group.issues, filters),
        }))
      : [];
    const selectedIssueNumber =
      activeIssueSurface !== null &&
      activeIssueSurface.environmentId === target.environmentId &&
      sameRepository(activeIssueSurface, target)
        ? activeIssueSurface.number
        : undefined;

    return (
      <section key={key} className="border-b border-border/60 pb-3 last:border-b-0">
        <div className="px-4 pb-2 pt-3">
          <h2 className="text-sm font-semibold">{target.repository}</h2>
          <p className="text-xs text-muted-foreground">
            {target.host}
            {target.isPrivate ? " · private" : ""}
            {target.ownerIsOrganization ? " · organization" : ""}
            {capableEnvironmentList.length > 1
              ? ` · ${environmentLabels.get(target.environmentId) ?? target.environmentId}`
              : ""}
          </p>
        </div>
        {snapshot === null && error === null ? (
          <div className="flex min-h-24 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-4" />
            Loading issues
          </div>
        ) : snapshot === null && error !== null ? (
          <div className="mx-4 flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-3 text-sm">
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
        ) : snapshot !== null ? (
          <>
            {snapshot.issues.length === 0 && snapshot.issuesComplete ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">
                {listState === "open" ? "No open issues." : "No issues."}
              </p>
            ) : filteredIssues.length === 0 && snapshot.issues.length > 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">
                No issues match these filters.
              </p>
            ) : (
              <IssueTree
                key={key}
                groups={groups}
                issuesComplete={snapshot.issuesComplete}
                onSelect={(issue) => selectIssue(issue, target, snapshot)}
                {...(selectedIssueNumber === undefined ? {} : { selectedIssueNumber })}
              />
            )}
            {error !== null ? (
              <div className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
                <span>{error.title}. Showing the last issues loaded.</span>
                <Button onClick={refreshIssues} size="xs" variant="outline">
                  Retry
                </Button>
              </div>
            ) : null}
            {snapshot.nextCursor !== null ? (
              <div className="flex justify-center px-2 pb-2">
                <Button
                  disabled={projectPending || state?.refreshing === true}
                  onClick={() => loadMore(key)}
                  size="sm"
                  variant="outline"
                >
                  {projectPending ? <Spinner className="size-3.5" /> : null}
                  Load more issues
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    );
  });

  const listContent = !capabilitiesKnown ? (
    <div className="flex min-h-56 items-center justify-center">
      <Spinner className="size-4" />
    </div>
  ) : capableEnvironmentIds.size === 0 ? (
    <Empty className="min-h-56 flex-none py-12">
      <EmptyHeader>
        <EmptyTitle>Issues unavailable</EmptyTitle>
        <EmptyDescription>Update a T3 Code server with GitHub Issues support.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : repositoryTargets.length === 0 && issueRepositories.isPending ? (
    <div className="flex min-h-56 items-center justify-center gap-2 text-xs text-muted-foreground">
      <Spinner className="size-4" />
      Loading repositories
    </div>
  ) : repositoryTargets.length === 0 && repositoryErrors.length > 0 ? (
    <Empty className="min-h-56 flex-none py-12">
      <EmptyHeader>
        <EmptyTitle>{repositoryErrors[0]!.title}</EmptyTitle>
        <EmptyDescription>{repositoryErrors[0]!.description}</EmptyDescription>
      </EmptyHeader>
      <Button onClick={refreshIssues} size="xs" variant="outline">
        Retry
      </Button>
    </Empty>
  ) : explicitScopeMissing ? (
    <Empty className="min-h-56 flex-none py-12">
      <EmptyHeader>
        <EmptyTitle>Repository unavailable</EmptyTitle>
        <EmptyDescription>
          This repository is not one you own or administer on GitHub.
        </EmptyDescription>
      </EmptyHeader>
      {repositoryChooser}
    </Empty>
  ) : repositoryTargets.length === 0 ? (
    <Empty className="min-h-56 flex-none py-12">
      <EmptyHeader>
        <EmptyTitle>No GitHub repositories</EmptyTitle>
        <EmptyDescription>
          No repositories you own or administer have issues enabled.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : visibleRepositories.length === 0 ? (
    <Empty className="min-h-56 flex-none py-12">
      <EmptyHeader>
        <EmptyTitle>No open issues</EmptyTitle>
        <EmptyDescription>Choose Open and closed to include closed issues.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <>
      {repositorySections}
      {hiddenEmptyRepositoryCount > 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {hiddenEmptyRepositoryCount} repositories with no open issues are hidden.
        </p>
      ) : null}
    </>
  );

  const listColumn = (
    <section className={cn("flex min-w-0 flex-1 flex-col", showNarrowDetail && "hidden md:flex")}>
      <header className="shrink-0 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <CircleDotIcon aria-hidden className="size-4 text-emerald-500" />
          <h1
            ref={listHeadingRef}
            tabIndex={-1}
            className="min-w-0 flex-1 text-base font-semibold outline-none"
          >
            GitHub Issues
          </h1>
          <Button
            aria-label="Refresh issues"
            disabled={refreshing || baseListTargets.length === 0}
            onClick={refreshIssues}
            size="icon-xs"
            variant="ghost"
          >
            <RefreshCwIcon aria-hidden className={cn(refreshing && "animate-spin")} />
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            aria-label="Search issues"
            className="min-w-44 flex-1 rounded-[var(--control-radius)] border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => updateSearch({ issueQuery: event.target.value || undefined })}
            placeholder="Search issues"
            type="search"
            value={search.issueQuery ?? ""}
          />
          {repositoryChooser}
          <select
            aria-label="Filter issues by state"
            className="rounded-[var(--control-radius)] border border-input bg-background px-2 py-1.5 text-xs text-foreground"
            onChange={(event) => updateSearch({ issueState: event.target.value as IssueListState })}
            value={listState}
          >
            <option value="open">Open</option>
            <option value="all">Open and closed</option>
          </select>
          <select
            aria-label="Filter issues by GitHub host"
            className="rounded-[var(--control-radius)] border border-input bg-background px-2 py-1.5 text-xs text-foreground"
            disabled={explicitScope}
            onChange={(event) => updateSearch({ host: event.target.value || undefined })}
            value={explicitScope ? "" : (search.host ?? "")}
          >
            <option value="">All hosts</option>
            {hosts.map((host) => (
              <option key={host} value={host}>
                {host}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter issues by milestone"
            className="rounded-[var(--control-radius)] border border-input bg-background px-2 py-1.5 text-xs text-foreground"
            onChange={(event) =>
              updateSearch({ issueMilestone: event.target.value as IssueMilestoneFilter })
            }
            value={filters.milestone}
          >
            <option value="all">All milestones</option>
            <option value="with">With milestone</option>
            <option value="without">No milestone</option>
          </select>
          <select
            aria-label="Filter issues by assignment"
            className="rounded-[var(--control-radius)] border border-input bg-background px-2 py-1.5 text-xs text-foreground"
            onChange={(event) =>
              updateSearch({ issueAssignee: event.target.value as IssueAssigneeFilter })
            }
            value={filters.assignee}
          >
            <option value="all">All assignments</option>
            <option value="assigned">Assigned</option>
            <option value="unassigned">Unassigned</option>
          </select>
          <select
            aria-label="Sort issues"
            className="rounded-[var(--control-radius)] border border-input bg-background px-2 py-1.5 text-xs text-foreground"
            onChange={(event) => updateSearch({ issueSort: event.target.value as IssueSort })}
            value={filters.sort}
          >
            <option value="updated">Recently updated</option>
            <option value="oldest">Oldest updated</option>
            <option value="number">Issue number</option>
            <option value="title">Title</option>
          </select>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pt-3">{listContent}</div>
    </section>
  );

  const rightPanel =
    !isNarrow &&
    rightPanelPresence.present &&
    renderedIssueSurface !== null &&
    panelEnvironmentId !== null ? (
      <RightPanelTabs
        activeSurfaceId={renderedIssueSurface.id}
        browserAvailable={false}
        defaultWidth={typeof window === "undefined" ? 560 : Math.floor(window.innerWidth / 2)}
        desktopByTabId={{}}
        deviceAvailable={false}
        diffAvailable={false}
        environmentId={panelEnvironmentId}
        filesAvailable={false}
        mode="inline"
        onActivate={(surface) => {
          if (surface.kind === "issue") activateSurface(surface);
        }}
        onAddBrowser={() => undefined}
        onAddBrowserInProfile={() => undefined}
        onAddDevice={() => undefined}
        onAddDiff={() => undefined}
        onAddFiles={() => undefined}
        onAddPullRequest={() => undefined}
        onAddPullRequests={() => undefined}
        onAddTerminal={() => undefined}
        onCloseAllSurfaces={closeAllSurfaces}
        onCloseOtherSurfaces={(surface) => {
          if (surface.kind === "issue") closeOtherSurfaces(surface);
        }}
        onCloseSurface={(surface) => {
          if (surface.kind === "issue") closeSurface(surface);
        }}
        onCloseSurfacesToRight={(surface) => {
          if (surface.kind === "issue") closeSurfacesToRight(surface);
        }}
        onCopyFilePath={() => undefined}
        open={rightPanelState.isOpen}
        pendingSurfaceIds={EMPTY_PENDING_SURFACES}
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        previewSessions={{}}
        surfaces={renderedSurfaces}
        terminalAvailable={false}
        terminalLabelsById={new Map()}
        widthStorageKey="t3code:issues-panel-width"
      >
        <IssueDetailPanel
          environmentId={panelEnvironmentId}
          {...(originThreadForSurface === null ? {} : { onOpenBesideThread: openBesideThread })}
          refreshToken={detailRefreshToken}
          reference={{
            host: renderedIssueSurface.host,
            repository: renderedIssueSurface.repository,
            number: renderedIssueSurface.number,
          }}
          threadRef={originThreadForSurface}
        />
      </RightPanelTabs>
    ) : null;

  const narrowDetail =
    showNarrowDetail && renderedIssueSurface !== null && panelEnvironmentId !== null ? (
      <div
        ref={narrowDetailRef}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none md:hidden"
      >
        <div className="flex h-11 shrink-0 items-center border-b border-border/60 px-2">
          <Button aria-label="Back to issues" onClick={closeNarrowDetail} size="sm" variant="ghost">
            <ArrowLeftIcon aria-hidden />
            Issues
          </Button>
        </div>
        <IssueDetailPanel
          environmentId={panelEnvironmentId}
          {...(originThreadForSurface === null ? {} : { onOpenBesideThread: openBesideThread })}
          refreshToken={detailRefreshToken}
          reference={{
            host: renderedIssueSurface.host,
            repository: renderedIssueSurface.repository,
            number: renderedIssueSurface.number,
          }}
          threadRef={originThreadForSurface}
        />
      </div>
    ) : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="relative flex min-h-0 flex-1">
        {listColumn}
        {rightPanel}
        {narrowDetail}
      </div>
    </SidebarInset>
  );
}
