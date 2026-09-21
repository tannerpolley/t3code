import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  EnvironmentAuthorizationError as EnvironmentAuthorizationErrorClass,
  IssueReadError as IssueReadErrorClass,
  pullRequestHostOf,
  type EnvironmentId,
  type IssueListInput,
  type IssueListResult,
  type IssueRef,
  type IssueSummary,
  type ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
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
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShell,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { issueEnvironment } from "../state/issues";
import { useEnvironmentQuery } from "../state/query";
import { cn } from "~/lib/utils";

export interface IssuesSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly host?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly selectedEnvironmentId?: EnvironmentId;
  readonly selectedProjectId?: ProjectId;
  readonly selectedHost?: string;
  readonly selectedRepository?: string;
  readonly selectedNumber?: number;
  readonly originThreadId?: ThreadId;
}
type IssuesSearchPatch = {
  readonly [Key in keyof IssuesSearch]?: IssuesSearch[Key] | undefined;
};

type IssueProjectTarget = {
  readonly project: EnvironmentProject;
  readonly host: string;
  readonly repository: string;
};

type IssueError = {
  readonly title: string;
  readonly description: string;
  readonly retryAt?: number;
  readonly scopeUnavailable?: boolean;
};

const EMPTY_ISSUE_LIST_ATOM = Atom.make(AsyncResult.initial<IssueListResult, never>(false));
const EMPTY_SURFACES: ReadonlyArray<RightPanelSurface> = [];
const EMPTY_PENDING_SURFACES = new Set<string>();
let lastIssueSelection: ScopedProjectRef | null = null;

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

function issueProjectTarget(project: EnvironmentProject): IssueProjectTarget | null {
  const identity = project.repositoryIdentity;
  if (identity?.provider !== "github") return null;
  const repository =
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : undefined);
  if (!repository) return null;
  return {
    project,
    host: pullRequestHostOf(identity, "github"),
    repository,
  };
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
          title: "Project scope unavailable",
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

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (raw: Record<string, unknown>): IssuesSearch => {
    const environmentId = optionalString(raw.environmentId, 200);
    const projectId = optionalString(raw.projectId, 200);
    const host = optionalString(raw.host);
    const repository = optionalString(raw.repository, 200);
    const number = optionalNumber(raw.number);
    const selectedEnvironmentId = optionalString(raw.selectedEnvironmentId, 200);
    const selectedProjectId = optionalString(raw.selectedProjectId, 200);
    const selectedHost = optionalString(raw.selectedHost);
    const selectedRepository = optionalString(raw.selectedRepository, 200);
    const selectedNumber = optionalNumber(raw.selectedNumber);
    const originThreadId = optionalString(raw.originThreadId, 200);
    const result: IssuesSearch = {
      ...(environmentId === undefined ? {} : { environmentId: environmentId as EnvironmentId }),
      ...(projectId === undefined ? {} : { projectId: projectId as ProjectId }),
      ...(host === undefined ? {} : { host }),
      ...(repository === undefined ? {} : { repository }),
      ...(number === undefined ? {} : { number }),
      ...(selectedEnvironmentId === undefined
        ? {}
        : { selectedEnvironmentId: selectedEnvironmentId as EnvironmentId }),
      ...(selectedProjectId === undefined
        ? {}
        : { selectedProjectId: selectedProjectId as ProjectId }),
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
  const projects = useProjects();
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
  const eligibleProjects = useMemo(
    () =>
      projects
        .filter((project) => capableEnvironmentIds.has(project.environmentId))
        .flatMap((project) => {
          const target = issueProjectTarget(project);
          return target === null ? [] : [target];
        })
        .toSorted(
          (left, right) =>
            (environmentLabels.get(left.project.environmentId) ?? "").localeCompare(
              environmentLabels.get(right.project.environmentId) ?? "",
            ) ||
            left.project.title.localeCompare(right.project.title) ||
            left.project.id.localeCompare(right.project.id),
        ),
    [capableEnvironmentIds, environmentLabels, projects],
  );
  const explicitScope = search.environmentId !== undefined || search.projectId !== undefined;
  const urlProject = useMemo(
    () =>
      search.environmentId !== undefined && search.projectId !== undefined
        ? (eligibleProjects.find(
            (target) =>
              target.project.environmentId === search.environmentId &&
              target.project.id === search.projectId,
          ) ?? null)
        : null,
    [eligibleProjects, search.environmentId, search.projectId],
  );
  const originThreadRef = useMemo<ScopedThreadRef | null>(
    () =>
      search.environmentId !== undefined && search.originThreadId !== undefined
        ? scopeThreadRef(search.environmentId, search.originThreadId)
        : null,
    [search.environmentId, search.originThreadId],
  );
  const originThread = useThreadShell(originThreadRef);
  const originProject = useMemo(
    () =>
      originThread === null
        ? null
        : (eligibleProjects.find(
            (target) =>
              target.project.environmentId === originThread.environmentId &&
              target.project.id === originThread.projectId,
          ) ?? null),
    [eligibleProjects, originThread],
  );
  const lastProject = useMemo(
    () =>
      lastIssueSelection === null
        ? null
        : (eligibleProjects.find(
            (target) =>
              target.project.environmentId === lastIssueSelection?.environmentId &&
              target.project.id === lastIssueSelection?.projectId,
          ) ?? null),
    [eligibleProjects],
  );
  const selectedProject = useMemo(() => {
    if (explicitScope) return urlProject;
    return (
      originProject ??
      lastProject ??
      (eligibleProjects.length === 1 ? (eligibleProjects[0] ?? null) : null)
    );
  }, [eligibleProjects, explicitScope, lastProject, originProject, urlProject]);
  const explicitScopeMissing = explicitScope && urlProject === null;
  const selectedProjectRef = selectedProject
    ? {
        environmentId: selectedProject.project.environmentId,
        projectId: selectedProject.project.id,
      }
    : null;
  const selectedProjectRefKey = selectedProjectRef
    ? `${selectedProjectRef.environmentId}:${selectedProjectRef.projectId}`
    : null;
  const scopeKey = selectedProjectRefKey
    ? JSON.stringify([
        selectedProjectRefKey,
        search.host?.toLowerCase() ?? null,
        search.repository?.toLowerCase() ?? null,
      ])
    : null;
  const listInput = useMemo<IssueListInput | null>(() => {
    if (selectedProject === null) return null;
    return {
      projectId: selectedProject.project.id,
      ...(search.host ? { host: search.host } : {}),
      ...(search.repository ? { repository: search.repository } : {}),
    };
  }, [search.host, search.repository, selectedProject]);

  const [paging, setPaging] = useState<{
    scopeKey: string | null;
    cursor: string | null;
    generation: number;
    snapshot: IssueListSnapshot | null;
    refreshing: boolean;
  }>({ scopeKey: null, cursor: null, generation: 0, snapshot: null, refreshing: false });
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const generationRef = useRef(0);
  const appliedDataByRequestRef = useRef(new Map<string, IssueListResult>());
  const scopeChanged = paging.scopeKey !== scopeKey;
  const activeGeneration = scopeChanged
    ? Math.max(generationRef.current, paging.generation + 1)
    : paging.generation;
  if (scopeChanged && generationRef.current < activeGeneration)
    generationRef.current = activeGeneration;
  const activeCursor = scopeChanged ? null : paging.cursor;
  const activeRequestKey = `${scopeKey ?? ""}:${activeCursor ?? "<first>"}`;
  const activeListAtom =
    selectedProject !== null && listInput !== null
      ? issueEnvironment.list({
          environmentId: selectedProject.project.environmentId,
          input: { ...listInput, ...(activeCursor === null ? {} : { cursor: activeCursor }) },
        })
      : null;
  const firstListAtom =
    selectedProject !== null && listInput !== null
      ? issueEnvironment.list({
          environmentId: selectedProject.project.environmentId,
          input: listInput,
        })
      : null;
  const listResult = useAtomValue(activeListAtom ?? EMPTY_ISSUE_LIST_ATOM);
  const listQuery = useEnvironmentQuery(activeListAtom);
  const refreshFirstList = useAtomRefresh(firstListAtom ?? EMPTY_ISSUE_LIST_ATOM);

  useEffect(() => {
    if (!scopeChanged) return;
    const nextGeneration = Math.max(generationRef.current, paging.generation + 1);
    generationRef.current = nextGeneration;
    appliedDataByRequestRef.current.clear();
    setPaging({
      scopeKey,
      cursor: null,
      generation: nextGeneration,
      snapshot: null,
      refreshing: false,
    });
  }, [paging.generation, paging.scopeKey, scopeChanged, scopeKey]);

  useEffect(() => {
    if (
      scopeKey === null ||
      listResult._tag !== "Success" ||
      listResult.waiting ||
      listQuery.data === null ||
      activeGeneration !== generationRef.current
    ) {
      return;
    }
    if (appliedDataByRequestRef.current.get(activeRequestKey) === listQuery.data) return;
    const pageResult = listQuery.data;
    if (pageResult === null) return;
    appliedDataByRequestRef.current.set(activeRequestKey, pageResult);
    setPaging((current) => {
      if (current.scopeKey !== scopeKey || current.generation !== activeGeneration) {
        return current;
      }
      const snapshot = acceptIssueListPage(current.snapshot, {
        scopeKey,
        generation: activeGeneration,
        cursor: activeCursor,
        result: pageResult,
      });
      return snapshot === current.snapshot ? current : { ...current, snapshot, refreshing: false };
    });
  }, [
    activeCursor,
    activeGeneration,
    activeRequestKey,
    listQuery.data,
    listResult._tag,
    listResult.waiting,
    scopeKey,
  ]);

  useEffect(() => {
    if (listResult._tag !== "Failure" || activeGeneration !== generationRef.current) return;
    setPaging((current) =>
      current.scopeKey === scopeKey && current.generation === activeGeneration && current.refreshing
        ? { ...current, refreshing: false }
        : current,
    );
  }, [activeGeneration, listResult._tag, scopeKey]);

  const updateSearch = useCallback(
    (patch: IssuesSearchPatch) =>
      void navigate({
        replace: true,
        search: (previous: IssuesSearch): IssuesSearch => {
          const next = { ...previous, ...patch };
          return {
            ...(next.environmentId ? { environmentId: next.environmentId } : {}),
            ...(next.projectId ? { projectId: next.projectId } : {}),
            ...(next.host ? { host: next.host } : {}),
            ...(next.repository ? { repository: next.repository } : {}),
            ...(next.number ? { number: next.number } : {}),
            ...(next.selectedEnvironmentId
              ? { selectedEnvironmentId: next.selectedEnvironmentId }
              : {}),
            ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
            ...(next.selectedHost ? { selectedHost: next.selectedHost } : {}),
            ...(next.selectedRepository ? { selectedRepository: next.selectedRepository } : {}),
            ...(next.selectedNumber ? { selectedNumber: next.selectedNumber } : {}),
            ...(next.originThreadId ? { originThreadId: next.originThreadId } : {}),
          };
        },
      }),
    [navigate],
  );

  const selectProject = useCallback(
    (target: IssueProjectTarget) => {
      lastIssueSelection = {
        environmentId: target.project.environmentId,
        projectId: target.project.id,
      };
      updateSearch({
        environmentId: target.project.environmentId,
        projectId: target.project.id,
        host: undefined,
        repository: undefined,
        number: undefined,
        selectedEnvironmentId: undefined,
        selectedProjectId: undefined,
        selectedHost: undefined,
        selectedRepository: undefined,
        selectedNumber: undefined,
      });
    },
    [updateSearch],
  );
  const refreshIssues = useCallback(() => {
    if (scopeKey === null || selectedProject === null || listInput === null) return;
    const nextGeneration = generationRef.current + 1;
    generationRef.current = nextGeneration;
    setPaging((current) => ({
      scopeKey,
      cursor: null,
      generation: nextGeneration,
      snapshot: current.scopeKey === scopeKey ? current.snapshot : null,
      refreshing: true,
    }));
    setDetailRefreshToken((token) => token + 1);
    refreshFirstList();
  }, [listInput, refreshFirstList, scopeKey, selectedProject]);
  const loadMore = useCallback(() => {
    if (
      scopeKey === null ||
      paging.scopeKey !== scopeKey ||
      paging.refreshing ||
      paging.snapshot?.generation !== paging.generation ||
      paging.snapshot?.nextCursor === null ||
      paging.snapshot?.nextCursor === undefined ||
      listQuery.isPending
    ) {
      return;
    }
    setPaging((current) => ({ ...current, cursor: current.snapshot?.nextCursor ?? null }));
  }, [
    listQuery.isPending,
    paging.generation,
    paging.refreshing,
    paging.scopeKey,
    paging.snapshot?.generation,
    paging.snapshot?.nextCursor,
    scopeKey,
  ]);

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
      const matchingProjects = eligibleProjects.filter(
        (target) => target.project.id === surface.projectId,
      );
      return matchingProjects.length === 1 ? matchingProjects[0]!.project.environmentId : null;
    },
    [eligibleProjects],
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
              selectedProjectId: undefined,
              selectedHost: undefined,
              selectedRepository: undefined,
              selectedNumber: undefined,
            }
          : {
              selectedEnvironmentId: surface.environmentId as EnvironmentId | undefined,
              selectedProjectId: surface.projectId as ProjectId,
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
  const issueTargetFor = useCallback(
    (issue: IssueSummary): IssueRef | null => {
      if (selectedProject === null) return null;
      const repository = paging.snapshot?.repository.repository ?? selectedProject.repository;
      const host = paging.snapshot?.repository.host ?? selectedProject.host;
      return {
        projectId: selectedProject.project.id,
        host,
        repository,
        number: issue.number,
      };
    },
    [paging.snapshot?.repository.host, paging.snapshot?.repository.repository, selectedProject],
  );
  const selectIssue = useCallback(
    (issue: IssueSummary) => {
      if (selectedProject === null) return;
      const target = issueTargetFor(issue);
      if (target === null) return;
      const surfaceTarget = {
        ...target,
        environmentId: selectedProject.project.environmentId,
        ...(safeExternalUrl(issue.url) ? { url: issue.url } : {}),
      };
      useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, surfaceTarget);
      syncSelectedSurface(issueSurface(surfaceTarget));
    },
    [issueTargetFor, selectedProject, syncSelectedSurface],
  );

  const selectedUrlTarget = useMemo(() => {
    if (selectedProject === null) return null;
    if (
      search.selectedNumber === undefined ||
      search.selectedRepository === undefined ||
      search.selectedProjectId === undefined
    ) {
      return null;
    }
    return {
      environmentId: search.selectedEnvironmentId ?? selectedProject.project.environmentId,
      projectId: search.selectedProjectId,
      host: search.selectedHost ?? selectedProject.host,
      repository: search.selectedRepository,
      number: search.selectedNumber,
    };
  }, [
    search.selectedEnvironmentId,
    search.selectedHost,
    search.selectedNumber,
    search.selectedProjectId,
    search.selectedRepository,
    selectedProject,
  ]);
  const listUrlTarget = useMemo(() => {
    if (selectedProject === null || search.number === undefined || search.repository === undefined)
      return null;
    return {
      environmentId: selectedProject.project.environmentId,
      projectId: selectedProject.project.id,
      host: search.host ?? selectedProject.host,
      repository: search.repository,
      number: search.number,
    };
  }, [search.host, search.number, search.repository, selectedProject]);
  const urlTarget = selectedUrlTarget ?? listUrlTarget;
  const openedUrlTargetKey = urlTarget
    ? `${urlTarget.environmentId}:${urlTarget.projectId}:${urlTarget.host}:${urlTarget.repository}:${urlTarget.number}`
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
      (activeIssueSurface.environmentId ?? originThreadRef.environmentId) &&
    originThread.projectId === activeIssueSurface.projectId
      ? originThreadRef
      : null;
  const openBesideThread = useCallback(() => {
    if (activeIssueSurface === null || originThreadForSurface === null) return;
    useRightPanelStore.getState().openIssue(originThreadForSurface, {
      environmentId: activeIssueSurface.environmentId ?? originThreadForSurface.environmentId,
      projectId: activeIssueSurface.projectId,
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

  const treeSnapshot = paging.scopeKey === scopeKey ? paging.snapshot : null;
  const groups = useMemo(
    () =>
      treeSnapshot ? groupIssuesByMilestone(treeSnapshot.milestones, treeSnapshot.issues) : [],
    [treeSnapshot],
  );
  const listHost = treeSnapshot?.repository.host ?? selectedProject?.host;
  const listRepository = treeSnapshot?.repository.repository ?? selectedProject?.repository;
  const selectedIssueNumber =
    activeIssueSurface !== null &&
    selectedProject !== null &&
    listHost !== undefined &&
    listRepository !== undefined &&
    activeIssueSurface.environmentId === selectedProject.project.environmentId &&
    activeIssueSurface.projectId === selectedProject.project.id &&
    activeIssueSurface.host.trim().toLowerCase() === listHost.trim().toLowerCase() &&
    activeIssueSurface.repository.trim().toLowerCase() === listRepository.trim().toLowerCase()
      ? activeIssueSurface.number
      : undefined;
  const listError =
    listResult._tag === "Failure" ? issueError(listResult.cause, listQuery.error) : null;
  const capabilitiesKnown =
    environments.some((environment) => environment.serverConfig !== null) ||
    environmentsBootstrapped;
  const loadingInitial = selectedProject !== null && treeSnapshot === null && listQuery.isPending;

  const projectChooser =
    eligibleProjects.length > 0 ? (
      <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="sr-only">GitHub project</span>
        <select
          aria-label="GitHub project"
          className="min-w-0 max-w-full rounded-[var(--control-radius)] border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={listError?.scopeUnavailable ? "" : (selectedProjectRefKey ?? "")}
          onChange={(event) => {
            const target = eligibleProjects.find(
              (entry) =>
                `${entry.project.environmentId}:${entry.project.id}` === event.target.value,
            );
            if (target) selectProject(target);
          }}
        >
          <option value="" disabled>
            Choose a project
          </option>
          {eligibleProjects.map((target) => (
            <option
              key={`${target.project.environmentId}:${target.project.id}`}
              value={`${target.project.environmentId}:${target.project.id}`}
            >
              {target.project.title} ·{" "}
              {environmentLabels.get(target.project.environmentId) ?? target.project.environmentId}
            </option>
          ))}
        </select>
      </label>
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
  ) : explicitScopeMissing ? (
    <Empty className="min-h-56 flex-none py-12">
      <EmptyHeader>
        <EmptyTitle>Project unavailable</EmptyTitle>
        <EmptyDescription>
          The URL's environment and project are no longer available.
        </EmptyDescription>
      </EmptyHeader>
      {eligibleProjects.length > 0 ? projectChooser : null}
    </Empty>
  ) : selectedProject === null ? (
    <Empty className="min-h-56 flex-none py-12">
      <EmptyHeader>
        <EmptyTitle>Choose a GitHub project</EmptyTitle>
        <EmptyDescription>Issues are scoped to one registered GitHub project.</EmptyDescription>
      </EmptyHeader>
      {projectChooser}
    </Empty>
  ) : loadingInitial ? (
    <div className="flex min-h-56 items-center justify-center">
      <Spinner className="size-4" />
    </div>
  ) : treeSnapshot === null && listError !== null ? (
    <Empty className="min-h-56 flex-none py-12">
      <EmptyHeader>
        <EmptyTitle>{listError.title}</EmptyTitle>
        <EmptyDescription>{listError.description}</EmptyDescription>
        {listError.retryAt !== undefined ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Retry after {retryDeadline(listError.retryAt)}.
          </p>
        ) : null}
      </EmptyHeader>
      <Button onClick={refreshIssues} size="sm" variant="outline">
        <RefreshCwIcon aria-hidden />
        Retry
      </Button>
    </Empty>
  ) : (
    <>
      <IssueTree
        key={scopeKey ?? "no-issue-scope"}
        groups={groups}
        issuesComplete={treeSnapshot?.issuesComplete ?? false}
        onSelect={selectIssue}
        {...(selectedIssueNumber === undefined ? {} : { selectedIssueNumber })}
      />
      {listError !== null ? (
        <div className="mx-2 mb-2 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <div>
            <span>{listError.title}. Showing the last issues loaded.</span>
            {listError.retryAt !== undefined ? (
              <span className="mt-1 block text-muted-foreground">
                Retry after {retryDeadline(listError.retryAt)}.
              </span>
            ) : null}
          </div>
          <Button onClick={refreshIssues} size="xs" variant="outline">
            Retry
          </Button>
        </div>
      ) : null}
      {treeSnapshot?.nextCursor !== null && treeSnapshot?.nextCursor !== undefined ? (
        <div className="flex justify-center px-2 pb-3">
          <Button
            disabled={
              listQuery.isPending ||
              paging.refreshing ||
              paging.snapshot?.generation !== paging.generation
            }
            onClick={loadMore}
            size="sm"
            variant="outline"
          >
            {listQuery.isPending ? <Spinner className="size-3.5" /> : null}
            Load more issues
          </Button>
        </div>
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
            disabled={paging.refreshing}
            onClick={refreshIssues}
            size="icon-xs"
            variant="ghost"
          >
            <RefreshCwIcon aria-hidden className={cn(paging.refreshing && "animate-spin")} />
          </Button>
        </div>
        <div className="mt-2 flex min-w-0 items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {selectedProject?.project.title ?? "GitHub project"}
          </p>
          {projectChooser}
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
        agentsAvailable={false}
        browserAvailable={false}
        defaultWidth={typeof window === "undefined" ? 560 : Math.floor(window.innerWidth / 2)}
        desktopByTabId={{}}
        deviceAvailable={false}
        diffAvailable={false}
        environmentId={panelEnvironmentId}
        filesAvailable={false}
        liveAgentCount={0}
        mode="inline"
        onActivate={(surface) => {
          if (surface.kind === "issue") activateSurface(surface);
        }}
        onAddAgents={() => undefined}
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
            projectId: renderedIssueSurface.projectId as ProjectId,
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
            projectId: renderedIssueSurface.projectId as ProjectId,
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
