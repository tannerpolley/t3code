import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import {
  EnvironmentAuthorizationError as EnvironmentAuthorizationErrorClass,
  IssueReadError as IssueReadErrorClass,
  type EnvironmentId,
  type IssueRef,
  type IssueSummary,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CircleDotIcon,
  LockIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { IssueDetailPanel } from "../components/issues/IssueDetailPanel";
import { IssueFilterMenu } from "../components/issues/IssueFilterMenu";
import { IssueTree, IssueTreeRow, IssueTreeTag } from "../components/issues/IssueTree";
import {
  acceptIssueListPage,
  type IssueListSnapshot,
} from "../components/issues/issuePaging.logic";
import { groupIssuesByMilestone } from "../components/issues/issueTree.logic";
import {
  DEFAULT_ISSUE_FILTER_PREFERENCES,
  IssueFilterPreferences,
  filterAndSortIssues,
  groupRepositoriesByOwner,
  issueListStateFor,
  issueStateFilter,
  mergeIssueRepositoryTargets,
  repositoryKey,
  repositoryKnownEmpty,
  repositoryListed,
  repositoryShown,
  type IssueRepositoryTarget,
} from "../components/issues/issueWorkspace.logic";
import { RightPanelTabs } from "../components/RightPanelTabs";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { useLocalStorage } from "../hooks/useLocalStorage";
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

const ISSUE_FILTERS_STORAGE_KEY = "t3code:issues-filters";

type IssuePagingState = {
  readonly cursor: string | null;
  readonly generation: number;
  readonly snapshot: IssueListSnapshot | null;
  readonly refreshing: boolean;
};

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (raw: Record<string, unknown>): IssuesSearch => {
    const environmentId = optionalString(raw.environmentId, 200);
    const host = optionalString(raw.host);
    const repository = optionalString(raw.repository, 200);
    const number = optionalNumber(raw.number);
    const issueQuery = optionalString(raw.issueQuery, 200);
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
  const [preferences, setPreferences] = useLocalStorage(
    ISSUE_FILTERS_STORAGE_KEY,
    DEFAULT_ISSUE_FILTER_PREFERENCES,
    IssueFilterPreferences,
  );
  const stateFilter = issueStateFilter(preferences);
  const listState = issueListStateFor(stateFilter ?? "open");
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
  // A repository link shows that repository whatever the Filter menu says.
  const shownRepositories = useMemo(() => {
    if (stateFilter === null) return [];
    if (explicitScope) return urlRepository === null ? [] : [urlRepository];
    const host = search.host?.toLowerCase();
    return repositoryTargets.filter(
      (target) =>
        (host === undefined || target.host === host) && repositoryShown(target, preferences),
    );
  }, [explicitScope, preferences, repositoryTargets, search.host, stateFilter, urlRepository]);
  const baseListTargets = useMemo<ReadonlyArray<IssueListTarget>>(
    () =>
      shownRepositories
        .filter((target) => !repositoryKnownEmpty(target, stateFilter ?? "open"))
        .map((target) => ({
          environmentId: target.environmentId,
          input: { host: target.host, repository: target.repository, state: listState },
        })),
    [listState, shownRepositories, stateFilter],
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
  const stateNoun = (count: number) =>
    filters.state === "all" ? (count === 1 ? "issue" : "issues") : filters.state;
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
    const snapshot = state?.snapshot ?? null;
    const error = scopeKey === null ? null : (issueErrors.get(scopeKey) ?? null);
    const filteredIssues = snapshot
      ? filterAndSortIssues(snapshot.issues, filters, target.repository)
      : [];
    const settled = scopeKey === null || (snapshot !== null && snapshot.issuesComplete && !error);
    const count = filteredIssues.length;
    const pinned = preferences.pinned.includes(key);
    if (!explicitScope && !repositoryListed({ count, settled, pinned }, preferences, narrowed)) {
      return [];
    }
    const selectedIssueNumber =
      activeIssueSurface !== null &&
      activeIssueSurface.environmentId === target.environmentId &&
      sameRepository(activeIssueSurface, target)
        ? activeIssueSurface.number
        : undefined;
    const countLabel: ReactNode =
      scopeKey === null ? (
        `0 ${stateNoun(0)}`
      ) : snapshot === null && error === null ? (
        <Spinner className="size-3" />
      ) : snapshot === null ? (
        <span className="text-amber-600 dark:text-amber-400">unavailable</span>
      ) : (
        `${count}${snapshot.issuesComplete ? "" : "+"} ${stateNoun(count)}`
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
  const ownerGroups = groupRepositoriesByOwner(repositoryEntries, viewerLogins);
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
      <p className="py-1.5 ps-10 pe-4 text-xs text-muted-foreground">{text}</p>
    );
    if (scopeKey === null) return message(`No ${filters.state} issues`);
    if (snapshot === null && error === null) {
      return (
        <div className="flex items-center gap-2 py-1.5 ps-10 text-xs text-muted-foreground">
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
        {filteredIssues.length > 0 ? (
          <IssueTree
            key={scopeKey}
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
          <div className="my-1 ms-10 me-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
            <span>{error.title}. Showing the last issues loaded.</span>
            <Button onClick={refreshIssues} size="xs" variant="outline">
              Retry
            </Button>
          </div>
        ) : null}
        {snapshot.nextCursor !== null ? (
          <div className="py-1 ps-10">
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

  const ownerTree = ownerGroups.map((group) => {
    const ownerOpen = isExpanded(
      `owner:${group.key}`,
      openAll ||
        group.repositories.some(
          (entry) => entry.error !== null || entry.selectedIssueNumber !== undefined,
        ),
    );
    const ownerCount = group.repositories.reduce((sum, entry) => sum + entry.count, 0);
    const ownerIncomplete = group.repositories.some((entry) => !entry.settled);
    const ownerPanelId = `issue-owner-${group.key.replace(/[^a-z0-9_-]/gi, "-")}`;
    return (
      <section key={group.key}>
        <IssueTreeRow
          level={0}
          controls={ownerPanelId}
          expanded={ownerOpen}
          onToggle={() => toggleExpanded(`owner:${group.key}`, ownerOpen)}
          count={`${group.repositories.length} ${group.repositories.length === 1 ? "repo" : "repos"} · ${ownerCount}${ownerIncomplete ? "+" : ""} ${stateNoun(ownerCount)}`}
        >
          <span className="min-w-0 truncate text-sm font-semibold">{group.owner}</span>
          <IssueTreeTag>
            {group.isOrganization ? "Org" : group.isViewer ? "Personal" : "User"}
          </IssueTreeTag>
          {hosts.length > 1 ? (
            <span className="truncate text-[11px] text-muted-foreground">{group.host}</span>
          ) : null}
        </IssueTreeRow>
        {ownerOpen ? (
          <div id={ownerPanelId}>
            {group.repositories.map((entry) => {
              const repositoryOpen = isExpanded(
                `repository:${entry.key}`,
                openAll || entry.error !== null || entry.selectedIssueNumber !== undefined,
              );
              const panelId = `issue-repository-${entry.key.replace(/[^a-z0-9_-]/gi, "-")}`;
              return (
                <section key={entry.key}>
                  <div className="group/repository flex items-center">
                    <IssueTreeRow
                      level={1}
                      controls={panelId}
                      expanded={repositoryOpen}
                      onToggle={() => toggleExpanded(`repository:${entry.key}`, repositoryOpen)}
                      count={entry.countLabel}
                    >
                      <span className="min-w-0 truncate text-[13px] font-medium">
                        {entry.repository.slice(entry.repository.indexOf("/") + 1)}
                      </span>
                      {entry.isPrivate ? (
                        <LockIcon
                          aria-label="Private"
                          className="size-3 shrink-0 text-muted-foreground"
                        />
                      ) : null}
                      {entry.isArchived ? <IssueTreeTag>Archived</IssueTreeTag> : null}
                      {entry.isFork ? <IssueTreeTag>Fork</IssueTreeTag> : null}
                      {entry.pinned ? <IssueTreeTag>Pinned</IssueTreeTag> : null}
                      {capableEnvironmentList.length > 1 ? (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {environmentLabels.get(entry.environmentId) ?? entry.environmentId}
                        </span>
                      ) : null}
                    </IssueTreeRow>
                    <Button
                      aria-label={
                        entry.pinned
                          ? `Unpin ${entry.repository}`
                          : `Always show ${entry.repository}`
                      }
                      title={entry.pinned ? "Unpin" : "Always show, whatever the filters say"}
                      aria-pressed={entry.pinned}
                      className={cn(
                        "shrink-0",
                        !entry.pinned &&
                          "opacity-0 pointer-coarse:opacity-100 group-hover/repository:opacity-100 focus-visible:opacity-100",
                      )}
                      onClick={() => togglePinned(entry.key, entry.pinned)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      {entry.pinned ? <PinOffIcon /> : <PinIcon />}
                    </Button>
                  </div>
                  {repositoryOpen ? <div id={panelId}>{renderRepositoryBody(entry)}</div> : null}
                </section>
              );
            })}
          </div>
        ) : null}
      </section>
    );
  });

  const showAllRepositories =
    repositoryTargets.length > 0 ? (
      <Button onClick={() => selectRepository(null)} size="xs" variant="outline">
        Show all repositories
      </Button>
    ) : null;

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
      Loading repositories and issues
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
      {showAllRepositories}
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
  ) : stateFilter === null ? (
    <Empty className="min-h-56 flex-none py-12">
      <EmptyHeader>
        <EmptyTitle>No issue states shown</EmptyTitle>
        <EmptyDescription>Select Open or Closed in Filter to show issues.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <>
      <div className="flex items-baseline justify-between px-4 pb-1.5 text-[11px] text-muted-foreground">
        <span className="font-semibold uppercase tracking-wide">Repositories</span>
        <span className="tabular-nums">
          {repositoryEntries.length} of {repositoryTargets.length} shown
        </span>
      </div>
      {ownerGroups.length > 0 ? (
        <div className="px-2 pb-2">{ownerTree}</div>
      ) : (
        <Empty className="min-h-40 flex-none py-8">
          <EmptyHeader>
            <EmptyTitle>No repositories match these filters</EmptyTitle>
            <EmptyDescription>Change the filters or search to show repositories.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {fetchedAt !== null ? (
        <p className="px-4 pb-4 text-right text-[11px] text-muted-foreground">
          Updated{" "}
          {new Date(fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
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
          {viewerLogins.map((login) => (
            <span
              key={login}
              className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
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
              onChange={(event) => updateSearch({ issueQuery: event.target.value || undefined })}
              placeholder="Find a repository or issue"
              type="search"
              value={query}
            />
          </InputGroup>
          <IssueFilterMenu
            host={explicitScope ? "" : (search.host ?? "")}
            hosts={explicitScope ? [] : hosts}
            onChange={setPreferences}
            onHostChange={(host) => updateSearch({ host: host || undefined })}
            preferences={preferences}
          />
          {stateFilter !== null && repositoryEntries.length > 0 ? (
            <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
              {totalCount}
              {totalIncomplete ? "+" : ""} {stateNoun(totalCount)}
            </span>
          ) : null}
        </div>
        {explicitScope && urlRepository !== null ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              Showing{" "}
              <span className="font-medium text-foreground">{urlRepository.repository}</span>
            </span>
            {showAllRepositories}
          </div>
        ) : null}
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
