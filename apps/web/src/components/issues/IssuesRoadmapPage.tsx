import { T } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type IssueTrackerKind,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, type RefObject } from "react";

import { IssueBrowser, useIssueRepositoryTargets } from "./IssueBrowser";
import { IssueDetailPanel } from "../issue/IssueDetailPanel";
import { issueTabTarget, repositoryIssueOf, type RepositoryIssueTarget } from "./issueTabs";
import { sameRepository } from "./issueWorkspace.logic";
import { RightPanelTabs } from "../RightPanelTabs";
import { Button } from "../ui/button";
import { roadmapSearchFromUrl, type RoadmapSearch } from "../issue/issuesSearch.logic";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import {
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  selectActiveRightPanelSurface,
  useRightPanelStore,
  ISSUES_PANEL_REF,
  issueSurface,
  type IssueSurface,
  type RightPanelSurface,
} from "../../rightPanelStore";
import { useProjects, useThreadShell } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";

const EMPTY_SURFACES: ReadonlyArray<RightPanelSurface> = [];
const EMPTY_PENDING_SURFACES = new Set<string>();

function getShortcutContext() {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

export function IssuesRoadmapPage({
  headingRef,
}: {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const search = useSearch({ from: "/_chat/issues" });
  const navigate = useNavigate({ from: "/issues" });
  const isNarrow = useMediaQuery("max-md");
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const repositories = useIssueRepositoryTargets(search.environmentId);
  const projects = useProjects();
  const { repositoryTargets } = repositories;
  const originThreadRef: ScopedThreadRef | null =
    search.environmentId !== undefined && search.originThreadId !== undefined
      ? scopeThreadRef(search.environmentId, search.originThreadId)
      : null;
  const originThread = useThreadShell(originThreadRef);
  const urlRepository =
    search.repository === undefined
      ? null
      : (repositoryTargets.find((target) =>
          sameRepository(target, {
            host: search.host ?? target.host,
            repository: search.repository!,
          }),
        ) ?? null);

  const updateSearch = (patch: { [Key in keyof RoadmapSearch]?: RoadmapSearch[Key] | undefined }) =>
    void navigate({
      replace: true,
      search: (previous) => ({ ...roadmapSearchFromUrl({ ...previous, ...patch }), view: "board" }),
    });

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
  // The panel is shared with upstream's Issues page, whose pull request tabs are not ours to show.
  const renderedSurfaces = (rightPanelPresence.value?.surfaces ?? EMPTY_SURFACES).filter(
    (surface) => surface.kind === "issue",
  );
  const resolveSurfaceEnvironmentId = (surface: IssueSurface): EnvironmentId | null => {
    if (surface.environmentId !== undefined) return surface.environmentId as EnvironmentId;
    const issue = repositoryIssueOf(surface);
    return (
      (issue && repositoryTargets.find((target) => sameRepository(target, issue))?.environmentId) ??
      null
    );
  };
  const panelEnvironmentId = renderedIssueSurface
    ? resolveSurfaceEnvironmentId(renderedIssueSurface)
    : null;
  const syncSelectedSurface = (surface: IssueSurface | null) => {
    const issue = surface === null ? null : repositoryIssueOf(surface);
    updateSearch(
      surface === null || issue === null
        ? {
            selectedEnvironmentId: undefined,
            selectedHost: undefined,
            selectedRepository: undefined,
            selectedNumber: undefined,
          }
        : {
            selectedEnvironmentId: surface.environmentId as EnvironmentId | undefined,
            selectedHost: issue.host,
            selectedRepository: issue.repository,
            selectedNumber: issue.number,
          },
    );
  };
  const activateSurface = (surface: IssueSurface) => {
    useRightPanelStore.getState().activateSurface(ISSUES_PANEL_REF, surface.id);
    syncSelectedSurface(surface);
  };
  const closeSurface = (surface: IssueSurface) => {
    useRightPanelStore.getState().closeSurface(ISSUES_PANEL_REF, surface.id);
    const next = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      ISSUES_PANEL_REF,
    );
    syncSelectedSurface(next?.kind === "issue" ? next : null);
  };
  const closeOtherSurfaces = (surface: IssueSurface) => {
    useRightPanelStore.getState().closeOtherSurfaces(ISSUES_PANEL_REF, surface.id);
    syncSelectedSurface(surface);
  };
  const closeSurfacesToRight = (surface: IssueSurface) => {
    useRightPanelStore.getState().closeSurfacesToRight(ISSUES_PANEL_REF, surface.id);
    syncSelectedSurface(surface);
  };
  const closeAllSurfaces = () => {
    useRightPanelStore.getState().closeAllSurfaces(ISSUES_PANEL_REF);
    syncSelectedSurface(null);
  };
  const selectIssue = (target: RepositoryIssueTarget) => {
    const environmentId = target.environmentId ?? search.environmentId;
    const tab =
      environmentId === undefined
        ? null
        : issueTabTarget(projects, { ...target, environmentId }, originThread?.projectId ?? null);
    if (tab === null) {
      if (target.url) window.open(target.url, "_blank", "noopener,noreferrer");
      return;
    }
    useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, tab);
    syncSelectedSurface(issueSurface(tab));
  };

  const selectedUrlTarget = (() => {
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
  })();
  const listUrlTarget =
    search.number === undefined || urlRepository === null
      ? null
      : {
          environmentId: urlRepository.environmentId,
          host: urlRepository.host,
          repository: urlRepository.repository,
          number: search.number,
        };
  const urlTarget = selectedUrlTarget ?? listUrlTarget;
  const openedUrlTargetKey = urlTarget
    ? `${urlTarget.environmentId}:${urlTarget.host}:${urlTarget.repository}:${urlTarget.number}`
    : null;
  const openedUrlTargetRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the URL's issue tab in the right-panel store once its project loads
  useEffect(() => {
    if (
      urlTarget === null ||
      openedUrlTargetKey === null ||
      openedUrlTargetRef.current === openedUrlTargetKey
    )
      return;
    const tab = issueTabTarget(projects, urlTarget);
    // Projects arrive after the first render; try again once they name this repository.
    if (tab === null) return;
    openedUrlTargetRef.current = openedUrlTargetKey;
    useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, tab);
  }, [openedUrlTargetKey, projects, urlTarget]);

  const originThreadForSurface =
    activeIssueSurface &&
    originThreadRef !== null &&
    originThread !== null &&
    originThread.environmentId ===
      (activeIssueSurface.environmentId ?? originThreadRef.environmentId)
      ? originThreadRef
      : null;
  const openBesideThread = () => {
    if (activeIssueSurface === null || originThreadForSurface === null) return;
    const { id: _id, kind: _kind, ...target } = activeIssueSurface;
    useRightPanelStore.getState().openIssue(originThreadForSurface, {
      ...target,
      environmentId: activeIssueSurface.environmentId ?? originThreadForSurface.environmentId,
    });
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: originThreadForSurface.environmentId,
        threadId: originThreadForSurface.threadId,
      },
    });
  };

  const showNarrowDetail =
    isNarrow &&
    rightPanelState.isOpen &&
    renderedIssueSurface !== null &&
    panelEnvironmentId !== null;
  const closeNarrowDetail = () => {
    useRightPanelStore.getState().close(ISSUES_PANEL_REF);
    syncSelectedSurface(null);
    window.requestAnimationFrame(() => headingRef.current?.focus());
  };

  const activeRepositoryIssue = activeIssueSurface ? repositoryIssueOf(activeIssueSurface) : null;
  const selectedRepositoryIssue =
    activeIssueSurface === null || activeRepositoryIssue === null
      ? null
      : {
          ...activeRepositoryIssue,
          ...(activeIssueSurface.environmentId === undefined
            ? {}
            : { environmentId: activeIssueSurface.environmentId }),
        };
  const listColumn = (
    <IssueBrowser
      variant="page"
      repositories={repositories}
      search={search}
      onSearchChange={updateSearch}
      selectedIssue={selectedRepositoryIssue}
      onSelectIssue={selectIssue}
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
        keybindings={keybindings}
        getShortcutContext={getShortcutContext}
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
        <RoadmapIssueDetail
          surface={renderedIssueSurface}
          environmentId={panelEnvironmentId}
          threadRef={originThreadForSurface}
          onOpenBesideThread={openBesideThread}
        />
      </RightPanelTabs>
    ) : null;

  const narrowDetail =
    showNarrowDetail && renderedIssueSurface !== null && panelEnvironmentId !== null ? (
      <div
        key={renderedIssueSurface.id}
        ref={focusOnMount}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none md:hidden"
      >
        <RoadmapIssueDetail
          surface={renderedIssueSurface}
          environmentId={panelEnvironmentId}
          threadRef={originThreadForSurface}
          onOpenBesideThread={openBesideThread}
          onBack={closeNarrowDetail}
        />
      </div>
    ) : null;

  return (
    <div className="relative flex min-h-0 flex-1">
      {listColumn}
      {rightPanel}
      {narrowDetail}
    </div>
  );
}

function focusOnMount(node: HTMLElement | null) {
  node?.focus();
}

function RoadmapIssueDetail(props: {
  readonly surface: IssueSurface;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly onOpenBesideThread: () => void;
  readonly onBack?: () => void;
}) {
  const { surface } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.onBack || props.threadRef !== null ? (
        <div className="flex shrink-0 items-center gap-2 px-4 pt-2">
          {props.onBack ? (
            <Button size="xs" variant="ghost" onClick={props.onBack}>
              <T>Back to issues</T>
            </Button>
          ) : null}
          {props.threadRef !== null ? (
            <Button size="xs" variant="outline" onClick={props.onOpenBesideThread}>
              <T>Open beside thread</T>
            </Button>
          ) : null}
        </div>
      ) : null}
      <IssueDetailPanel
        key={surface.id}
        environmentId={props.environmentId}
        reference={{
          projectId: surface.projectId as ProjectId,
          tracker: surface.tracker as IssueTrackerKind,
          ...(surface.host ? { host: surface.host } : {}),
          scope: surface.scope,
          key: surface.key,
        }}
        threadRef={props.threadRef}
      />
    </div>
  );
}
