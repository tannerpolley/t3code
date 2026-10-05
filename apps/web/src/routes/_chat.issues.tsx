import { type EnvironmentId, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { IssueBrowser, useIssueRepositoryTargets } from "../components/issues/IssueBrowser";
import { IssueDetailPanel } from "../components/issues/IssueDetailPanel";
import { sameRepository } from "../components/issues/issueWorkspace.logic";
import { RightPanelTabs } from "../components/RightPanelTabs";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
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
import { useThreadShell } from "../state/entities";

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

const EMPTY_SURFACES: ReadonlyArray<RightPanelSurface> = [];
const EMPTY_PENDING_SURFACES = new Set<string>();

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
  const repositories = useIssueRepositoryTargets();
  const { repositoryTargets } = repositories;
  const originThreadRef = useMemo<ScopedThreadRef | null>(
    () =>
      search.environmentId !== undefined && search.originThreadId !== undefined
        ? scopeThreadRef(search.environmentId, search.originThreadId)
        : null,
    [search.environmentId, search.originThreadId],
  );
  const originThread = useThreadShell(originThreadRef);
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
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const refreshDetail = useCallback(() => setDetailRefreshToken((token) => token + 1), []);

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

  const showAllRepositories = useCallback(
    () =>
      updateSearch({
        host: undefined,
        repository: undefined,
        number: undefined,
        selectedEnvironmentId: undefined,
        selectedHost: undefined,
        selectedRepository: undefined,
        selectedNumber: undefined,
      }),
    [updateSearch],
  );
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
    (target: Omit<IssueSurface, "id" | "kind">) => {
      useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, target);
      syncSelectedSurface(issueSurface(target));
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

  const listColumn = (
    <IssueBrowser
      variant="page"
      repositories={repositories}
      search={search}
      onSearchChange={updateSearch}
      onShowAllRepositories={showAllRepositories}
      selectedIssue={activeIssueSurface}
      onSelectIssue={selectIssue}
      onRefresh={refreshDetail}
      headingRef={listHeadingRef}
      className={showNarrowDetail ? "hidden md:flex" : undefined}
    />
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
        onAddIssues={() => undefined}
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
        issuesAvailable={false}
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
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="relative flex min-h-0 flex-1">
        {listColumn}
        {rightPanel}
        {narrowDetail}
      </div>
    </SidebarInset>
  );
}
