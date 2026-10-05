import { pendingBackgroundWorkOfThread } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { ChildWorktreeIcon, SidebarBackgroundWorkRows } from "../sidebar/SidebarBackgroundWorkRows";
import {
  childWorktreeLabel,
  describeSidebarBackgroundWork,
} from "../sidebar/SidebarBackgroundWork.logic";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { CollapsibleSectionHeader, SectionHeaderStatus } from "../ui/collapsible-section-header";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import {
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentDisplayTitle,
  resolveSubagentMetadata,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  isParentThreadRelationship,
  threadRelationshipRowStatus,
  orderWebThreadLineageRows,
  resolveMergeBackTargetThreadId,
  type ThreadRelationshipEdge,
  type ThreadRelationshipWalkRow,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  canDetachThreadProviderSession,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CornerDownRightIcon,
  ChevronDownIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PlusIcon,
  UnplugIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  useProjects,
  useServerConfigs,
  useThreadProjection,
  useThreadShells,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { AgentElapsed } from "./AgentElapsed";
import { shortModelName } from "./providerIconUtils";
import {
  groupThreadLineageRows,
  resolveLineageClearedAt,
  SHOW_ALL_CLEARED,
} from "./ThreadRelationshipsControl.logic";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import { lineageStatusMark, ThreadStatusMark } from "../ThreadStatusMark";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

// Lineage paging: a busy thread can accumulate dozens of forks and subagents,
// and the panel it lives in already scrolls. Show a workable window, keep the
// rest behind Show more, and bound what is shown so the sections below Lineage
// stay reachable.
const THREAD_LINEAGE_INITIAL_COUNT = 6;
const THREAD_LINEAGE_PAGE_COUNT = 12;

export function resolveThreadLineageWindow<Row>(
  rows: ReadonlyArray<Row>,
  visibleCount: number,
): { readonly visibleRows: ReadonlyArray<Row>; readonly hiddenCount: number } {
  const visibleRows = rows.slice(0, visibleCount);
  return { visibleRows, hiddenCount: rows.length - visibleRows.length };
}

export function ThreadLineageRowList(props: {
  readonly hiddenCount: number;
  readonly onShowMore: () => void;
  readonly children: ReactNode;
}) {
  return (
    <>
      {/*
        Bounded rather than free-growing so Lineage cannot push the rest of the
        thread details panel out of view. Plain overflow, not a ScrollArea
        component: this sits inside an already scrolling panel, where a
        max-height-only virtual viewport measures badly. Every row is a focusable
        button, so keyboard users reach and scroll the region through the rows
        themselves and the container needs no extra tab stop of its own.
      */}
      <ul
        aria-label="Related threads"
        className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0"
      >
        {props.children}
      </ul>
      {props.hiddenCount > 0 ? (
        <button
          type="button"
          onClick={props.onShowMore}
          className={`flex h-8 w-full cursor-pointer items-center rounded-lg ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-sm font-medium text-muted-foreground/70 hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]`}
        >
          <PlusIcon aria-hidden className="size-4 shrink-0" />
          Show {Math.min(props.hiddenCount, THREAD_LINEAGE_PAGE_COUNT)} more
        </button>
      ) : null}
    </>
  );
}

function ThreadLineageGroup(props: {
  readonly label: string | null;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly expanded: boolean;
  readonly onToggle?: () => void;
  readonly footer?: ReactNode;
  readonly children: (rows: ReadonlyArray<ThreadRelationshipWalkRow>) => ReactNode;
}) {
  const [localExpanded, setLocalExpanded] = useState(props.expanded);
  const expanded = props.onToggle ? props.expanded : localExpanded;
  const [visibleCount, setVisibleCount] = useState(THREAD_LINEAGE_INITIAL_COUNT);
  const { visibleRows, hiddenCount } = resolveThreadLineageWindow(props.rows, visibleCount);
  const failedCount = props.rows.filter(
    ({ edge }) => edge.status === "failed" || edge.status === "error",
  ).length;
  if (props.rows.length === 0 && !props.footer) return null;
  return (
    <div>
      {props.label && props.rows.length > 0 ? (
        <CollapsibleSectionHeader
          expanded={expanded}
          onClick={props.onToggle ?? (() => setLocalExpanded(!localExpanded))}
          accessory={
            failedCount > 0 ? <SectionHeaderStatus>{failedCount} failed</SectionHeaderStatus> : null
          }
        >
          {props.label}
          {!expanded && ` (${props.rows.length})`}
        </CollapsibleSectionHeader>
      ) : null}
      {expanded ? (
        <ThreadLineageRowList
          hiddenCount={hiddenCount}
          onShowMore={() => setVisibleCount((count) => count + THREAD_LINEAGE_PAGE_COUNT)}
        >
          {props.children(visibleRows)}
        </ThreadLineageRowList>
      ) : null}
      {props.footer}
    </div>
  );
}

/** The same task controls as Projects, scoped to the displayed thread. */
function ThreadLineageBackgroundTasks(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}) {
  return (
    <SidebarBackgroundWorkRows
      environmentId={props.environmentId}
      threadId={props.threadId}
      rows={describeSidebarBackgroundWork(
        props.tasks.filter((task) => task.kind !== "subagent"),
        [],
      )}
    />
  );
}

function relationshipLabel(edge: ThreadRelationshipEdge, currentThreadId: ThreadId) {
  if (edge.kind === "transfer") return "Context transfer";
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId ? "Subagent" : "Parent agent";
  }
  return edge.sourceThreadId === currentThreadId ? "Fork" : "Parent thread";
}

function relationshipThreadTitle(input: {
  readonly title: string;
  readonly isSubagent: boolean;
}): string {
  if (!input.isSubagent) return input.title;
  return formatSubagentDisplayTitle(input.title);
}

/**
 * A delegated task settles with its first run, but the parent can keep sending
 * the child follow-ups. While the child thread has a live run, the row's timer
 * and hover card follow that run instead of the settled task.
 */
function liveSubagent<Agent extends RuntimeSubagent>(
  agent: Agent | undefined,
  childThread: OrchestrationV2ThreadShell | null | undefined,
): Agent | undefined {
  const liveStatus = childThread?.activityRunStatus;
  if (!agent || !liveStatus) return agent;
  const startedAt = childThread.activityRunStartedAt;
  return {
    ...agent,
    status: liveStatus === "running" || liveStatus === "waiting" ? liveStatus : "pending",
    startedAt: startedAt ? DateTime.formatIso(startedAt) : null,
    completedAt: null,
    // The settled task's output belongs to its first run, not this one.
    progress: null,
    result: null,
    error: null,
  };
}

export function ThreadRelationshipsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const providers = useServerConfigs().get(props.environmentId)?.providers;
  const subagentsByThreadId = useMemo(
    () =>
      new Map(
        (projection?.subagents ?? [])
          .filter((subagent) => subagent.childThreadId !== null)
          .map((subagent) => [
            subagent.childThreadId,
            {
              ...projectedSubagentsToRuntime([subagent])[0]!,
              driver: subagent.driver,
              providerInstanceId: subagent.providerInstanceId,
            },
          ]),
      ),
    [projection?.subagents],
  );
  const threadShells = useThreadShells();
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  const archived = useArchivedThreadSnapshots([props.environmentId]);
  const archivedShells = archived.snapshots.find(
    (entry) => entry.environmentId === props.environmentId,
  )?.snapshot.threads;
  const graph = useMemo(() => {
    const shells: ReadonlyArray<OrchestrationV2ThreadShell> = [
      ...threadShells
        .filter((thread) => thread.environmentId === props.environmentId)
        .map((thread) => thread.source),
      ...(archivedShells ?? []),
    ];
    return deriveThreadRelationshipGraph({ threads: shells, projection });
  }, [archivedShells, projection, props.environmentId, threadShells]);
  const currentThread = projection?.thread ?? graph.nodes.get(props.threadId)?.thread;
  const currentThreadShell = graph.nodes.get(props.threadId)?.thread;
  const currentProject = projects.find((project) => project.id === currentThread?.projectId);
  const lineageDetailsExpandedById = useUiStateStore((store) => store.lineageDetailsExpandedById);
  const setLineageDetailsExpanded = useUiStateStore((store) => store.setLineageDetailsExpanded);
  const lineageAgentsClearedAtById = useUiStateStore((store) => store.lineageAgentsClearedAtById);
  const setLineageAgentsClearedAt = useUiStateStore((store) => store.setLineageAgentsClearedAt);
  const threadKey = scopedThreadKey(ref);
  const [previousOpenFor, setPreviousOpenFor] = useState<string | null>(null);
  const previousExpanded = previousOpenFor === threadKey;
  const expandDetailsByDefault = useClientSettings((settings) => settings.lineageDetailsExpanded);
  const autoClearMinutes = useClientSettings((settings) => settings.lineageAutoClearMinutes);
  const shortModelNames = useClientSettings((settings) => settings.shortModelNames);
  const nowMinute = useNowMinute();
  const navigate = useNavigate();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  const latestMergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const relationshipRows = useMemo(
    () =>
      orderWebThreadLineageRows({
        graph,
        rows: immediateThreadRelationships(graph, props.threadId),
        currentThreadId: props.threadId,
        mergeTargetThreadId,
      }),
    [graph, mergeTargetThreadId, props.threadId],
  );
  const canMerge = mergeTargetThreadId !== null && latestMergeBackRun !== null;
  const canDetach = projection ? canDetachThreadProviderSession(projection) : false;

  const finishedAt = (threadId: ThreadId): number | null => {
    const agent = subagentsByThreadId.get(threadId);
    const runCompletedAt = graph.nodes.get(threadId)?.thread?.latestRunCompletedAt;
    const times = [
      Date.parse(agent?.completedAt ?? agent?.updatedAt ?? ""),
      DateTime.isDateTime(runCompletedAt) ? DateTime.toEpochMillis(runCompletedAt) : NaN,
    ].filter(Number.isFinite);
    return times.length > 0 ? Math.max(...times) : null;
  };
  const { related, active, previous, clearedCount } = groupThreadLineageRows({
    rows: relationshipRows,
    currentThreadId: props.threadId,
    clearedAt: resolveLineageClearedAt({
      stored: lineageAgentsClearedAtById[threadKey],
      autoClearMinutes,
      now: Date.parse(`${nowMinute}:00.000Z`),
    }),
    finishedAt,
  });
  const clearPrevious = () =>
    setLineageAgentsClearedAt(
      threadKey,
      new Date(
        Math.max(
          Date.parse(`${nowMinute}:00.000Z`),
          ...previous.map(({ threadId }) => finishedAt(threadId) ?? 0),
        ),
      ).toISOString(),
    );
  const groups = [
    { id: "related", label: null, rows: related, expanded: true },
    { id: "active", label: null, rows: active, expanded: true },
    {
      id: "previous",
      label: "Previous agents",
      rows: previous,
      expanded: previousExpanded,
      onToggle: () => setPreviousOpenFor(previousExpanded ? null : threadKey),
      footer:
        (previousExpanded && previous.length > 0) || (previous.length === 0 && clearedCount > 0) ? (
          <div className="flex h-7 items-center gap-1 px-2 text-2xs text-muted-foreground/70">
            {clearedCount > 0 ? (
              <>
                {clearedCount} cleared ·
                <button
                  type="button"
                  aria-label="Show cleared agents"
                  className="cursor-pointer hover:text-foreground/80"
                  onClick={() => {
                    setLineageAgentsClearedAt(threadKey, SHOW_ALL_CLEARED);
                    setPreviousOpenFor(threadKey);
                  }}
                >
                  Show
                </button>
              </>
            ) : null}
            {previousExpanded && previous.length > 0 ? (
              <button
                type="button"
                aria-label="Clear previous agents"
                className="ms-auto cursor-pointer hover:text-foreground/80"
                onClick={clearPrevious}
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : null,
    },
  ];
  // Subagents without a child thread yet have no row, so count them separately.
  const runningCount =
    (projection?.subagents.filter(
      (agent) => agent.childThreadId === null && isOrchestrationV2WorkActive(agent.status),
    ).length ?? 0) + active.length;
  const parentTasks =
    currentThreadShell?.lineage.parentThreadId == null
      ? []
      : (graph.nodes.get(currentThreadShell.lineage.parentThreadId)?.thread
          ?.pendingBackgroundTasks ?? []);
  const backgroundTasks = pendingBackgroundWorkOfThread(
    props.threadId,
    currentThreadShell?.pendingBackgroundTasks,
    parentTasks,
  );
  const hasBackgroundTasks = backgroundTasks.some((task) => task.kind !== "subagent");

  if (relationshipRows.length === 0 && runningCount === 0 && !hasBackgroundTasks) {
    return null;
  }

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };

  const merge = async () => {
    if (!latestMergeBackRun || mergeTargetThreadId === null || busyAction !== null) return;
    setBusyAction("merge");
    const result = await mergeBack({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: props.threadId,
        targetThreadId: mergeTargetThreadId,
        runId: latestMergeBackRun.id,
      },
    });
    setBusyAction(null);
    if (result._tag === "Success") openThread(mergeTargetThreadId);
  };

  const detach = async () => {
    if (!canDetach || busyAction !== null) return;
    setBusyAction("detach");
    await stopSession({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setBusyAction(null);
  };

  const detailsKey = (threadId: ThreadId) =>
    scopedThreadKey(scopeThreadRef(props.environmentId, threadId));
  const detailsExpanded = (threadId: ThreadId) =>
    lineageDetailsExpandedById[detailsKey(threadId)] ?? expandDetailsByDefault;
  const shownRows = [...related, ...active, ...(previousExpanded ? previous : [])].filter(
    ({ threadId }) => !graph.nodes.get(threadId)?.missing,
  );
  const anyDetailsCollapsed = shownRows.some(({ threadId }) => !detailsExpanded(threadId));
  const toggleAllDetails = () =>
    setLineageDetailsExpanded(
      shownRows.map(({ threadId }) => detailsKey(threadId)),
      anyDetailsCollapsed,
    );

  const parentTitle =
    mergeTargetThreadId === null
      ? null
      : (graph.nodes.get(mergeTargetThreadId)?.thread?.title ?? null);

  return (
    <>
      {relationshipRows.length > 0 || runningCount > 0 ? (
        <ThreadDetailsSection
          headingId="thread-details-lineage-heading"
          title={runningCount > 0 ? `Lineage · ${runningCount} running` : "Lineage"}
          data-thread-relationships-panel
          actions={
            <>
              {shownRows.length > 0 ? (
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label={anyDetailsCollapsed ? "Expand all details" : "Collapse all details"}
                  onClick={toggleAllDetails}
                >
                  {anyDetailsCollapsed ? (
                    <ChevronsUpDownIcon className="size-3.5" />
                  ) : (
                    <ChevronsDownUpIcon className="size-3.5" />
                  )}
                </ThreadDetailsControl>
              ) : null}
              {canDetach ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <ThreadDetailsControl
                        size="icon-xs"
                        variant="ghost"
                        part="icon"
                        aria-label="More thread actions"
                        disabled={busyAction !== null}
                      />
                    }
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" className="min-w-60 max-w-(--available-width)">
                    <MenuItem onClick={() => void detach()}>
                      <UnplugIcon className="size-3.5" />
                      Disconnect agent session
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
            </>
          }
        >
          {groups.map((group) => (
            <ThreadLineageGroup key={`${scopedThreadKey(ref)}:${group.id}`} {...group}>
              {(visibleRows) =>
                visibleRows.map(({ threadId, edge }) => {
                  const node = graph.nodes.get(threadId);
                  const isSubagent = edge.kind === "subagent";
                  const isMergeTarget = threadId === mergeTargetThreadId;
                  const isParent = isParentThreadRelationship(edge, props.threadId);
                  const status = threadRelationshipRowStatus(graph, { threadId, edge });
                  const RelationshipIcon = isParent
                    ? CornerLeftUpIcon
                    : isSubagent
                      ? CornerDownRightIcon
                      : GitForkIcon;
                  const relationship = relationshipLabel(edge, props.threadId);
                  const agent = liveSubagent(
                    isSubagent && !isParent ? subagentsByThreadId.get(threadId) : undefined,
                    node?.thread,
                  );
                  const threadTitle = relationshipThreadTitle({
                    title: node?.thread?.title ?? agent?.title ?? threadId,
                    isSubagent,
                  });
                  const provider = providers?.find(
                    (entry) =>
                      entry.instanceId ===
                      (agent?.providerInstanceId ?? node?.thread?.providerInstanceId),
                  );
                  const providerDriver = agent?.driver ?? provider?.driver;
                  const project = projects.find(
                    (project) => project.id === node?.thread?.projectId,
                  );
                  const modelSelection = isSubagent
                    ? node?.thread?.latestRunId
                      ? node.thread.modelSelection
                      : null
                    : (node?.thread?.modelSelection ?? null);
                  const elapsedAgent =
                    agent && status === "waiting"
                      ? { ...agent, status: "waiting" as const, completedAt: null }
                      : agent;
                  const reportedModel = agent?.model ?? null;
                  const model = reportedModel ?? modelSelection?.model ?? null;
                  const modelLabel = "Selected model";
                  const metadata = resolveSubagentMetadata({
                    model,
                    provider,
                    parentThread: currentThread,
                    childThread: node?.thread,
                    parentProject: currentProject,
                    childProject: project,
                  });
                  const shownModelLabel = shortModelNames
                    ? shortModelName(metadata.modelLabel)
                    : metadata.modelLabel;
                  const effortLabel =
                    agent?.effort ??
                    (modelSelection
                      ? formatModelSelectionEffort(
                          {
                            ...modelSelection,
                            model: provider
                              ? (resolveSelectableModel(
                                  provider.driver,
                                  modelSelection.model,
                                  provider.models,
                                ) ?? modelSelection.model)
                              : modelSelection.model,
                          },
                          provider?.models,
                        )
                      : null);
                  const effortHeading = "Selected effort";
                  const preview = agent
                    ? subagentDetailPreview({
                        status: agent.status,
                        progress: agent.progress,
                        result: agent.result,
                      })
                    : null;
                  const worktree =
                    isSubagent && !isParent && node?.thread
                      ? childWorktreeLabel(node.thread, currentThread)
                      : null;
                  const relationshipHint = node?.missing
                    ? "This related thread is unavailable"
                    : `Open ${relationship.toLowerCase()} in this chat`;
                  const RelationshipPopup = agent ? ThreadHoverCardPopup : TooltipPopup;
                  const relationshipTooltip = elapsedAgent ? (
                    <SubagentTooltipContent
                      title={threadTitle}
                      model={elapsedAgent.model}
                      provider={provider}
                      providers={providers}
                      driver={providerDriver}
                      elapsed={<AgentElapsed agent={elapsedAgent} />}
                      status={elapsedAgent.status}
                      result={elapsedAgent.result}
                      progress={elapsedAgent.progress}
                      parentThread={currentThread ?? undefined}
                      childThread={node?.thread ?? undefined}
                      parentProject={currentProject}
                      childProject={project}
                    />
                  ) : worktree ? (
                    <>
                      {relationshipHint}
                      <br />
                      Worktree: {worktree}
                    </>
                  ) : (
                    relationshipHint
                  );
                  const relationshipContent = (
                    <>
                      {worktree ? <ChildWorktreeIcon /> : null}
                      <ThreadRelationshipIcon
                        driver={isSubagent && !isParent ? providerDriver : undefined}
                        provider={provider}
                        fallbackIcon={RelationshipIcon}
                      />
                      {model ? (
                        <span className="max-w-32 shrink-0 truncate text-2xs font-normal text-foreground/75">
                          {shownModelLabel}
                          {effortLabel ? ` · ${effortLabel}` : ""}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
                          {threadTitle}
                        </span>
                      </span>
                      {elapsedAgent ? (
                        elapsedAgent.startedAt ? (
                          <span className="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">
                            <AgentElapsed agent={elapsedAgent} />
                          </span>
                        ) : null
                      ) : (
                        <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      )}
                      {!isMergeTarget ? (
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {threadRelationshipStatusLabel(status)}
                        </span>
                      ) : null}
                      <ThreadStatusMark status={lineageStatusMark(status)} />
                    </>
                  );
                  const rowExpanded = !node?.missing && detailsExpanded(threadId);
                  const detailsToggle = node?.missing ? null : (
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-expanded={rowExpanded}
                      aria-label={`${rowExpanded ? "Hide" : "Show"} details for ${threadTitle}`}
                      onClick={() =>
                        setLineageDetailsExpanded([detailsKey(threadId)], !rowExpanded)
                      }
                    >
                      <ChevronDownIcon
                        className={`size-3.5 transition-transform ${rowExpanded ? "" : "-rotate-90"}`}
                      />
                    </ThreadDetailsControl>
                  );
                  return (
                    <li key={threadId} className="group rounded-lg">
                      <div className="flex h-8 items-center">
                        {isMergeTarget ? (
                          <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
                            <Tooltip>
                              <TooltipTrigger
                                delay={200}
                                render={
                                  <ThreadDetailsControl
                                    size="sm"
                                    variant="ghost"
                                    part="link-primary"
                                    aria-label={`${threadTitle} ${threadRelationshipStatusLabel(status)}`}
                                    disabled={node?.missing === true}
                                    onClick={() => openThread(threadId)}
                                  />
                                }
                              >
                                {relationshipContent}
                              </TooltipTrigger>
                              <RelationshipPopup side="left">
                                {relationshipTooltip}
                              </RelationshipPopup>
                            </Tooltip>
                            <span
                              aria-hidden="true"
                              className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS}
                            />
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <ThreadDetailsControl
                                    size="sm"
                                    variant="ghost"
                                    part="secondary"
                                    aria-label={
                                      parentTitle
                                        ? `Merge back to ${parentTitle}`
                                        : "Merge back to source conversation"
                                    }
                                    disabled={!canMerge || busyAction !== null}
                                    onClick={() => void merge()}
                                  >
                                    {busyAction === "merge" ? (
                                      <LoaderCircleIcon className="size-3 animate-spin" />
                                    ) : (
                                      <PullRequestGlyph.merged className="size-3" />
                                    )}
                                  </ThreadDetailsControl>
                                }
                              />
                              <TooltipPopup side="left">
                                {latestMergeBackRun === null
                                  ? "Complete a run in this fork before merging it back"
                                  : parentTitle
                                    ? `Merge this conversation back into ${parentTitle}`
                                    : "Merge this conversation back into its source"}
                              </TooltipPopup>
                            </Tooltip>
                            <span className="shrink-0 border border-transparent ps-1 pe-2.5 text-2xs font-medium text-muted-foreground">
                              {threadRelationshipStatusLabel(status)}
                            </span>
                          </div>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger
                              delay={200}
                              render={
                                <ThreadDetailsControl
                                  size="sm"
                                  variant="ghost"
                                  disabled={node?.missing === true}
                                  onClick={() => openThread(threadId)}
                                  part="row"
                                />
                              }
                            >
                              {relationshipContent}
                            </TooltipTrigger>
                            <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
                          </Tooltip>
                        )}
                        {detailsToggle}
                      </div>
                      {rowExpanded ? (
                        <div className="grid gap-1.5 pb-2 ps-9 pe-2 text-xs text-muted-foreground">
                          <span className="truncate text-foreground/75">{threadTitle}</span>
                          {agent || model ? (
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0">{modelLabel}</span>
                              <span className="min-w-0 truncate text-foreground/75">
                                {shownModelLabel}
                              </span>
                            </div>
                          ) : null}
                          {effortLabel ? (
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0">{effortHeading}</span>
                              <span className="truncate text-foreground/75">{effortLabel}</span>
                            </div>
                          ) : null}
                          {metadata.workspace.map(({ label, value }) => (
                            <div key={label} className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0">{label}</span>
                              <span className="truncate text-foreground/75">{value}</span>
                            </div>
                          ))}
                          {preview ? <p className="m-0 line-clamp-2">{preview}</p> : null}
                          {node?.thread ? (
                            <ThreadLineageBackgroundTasks
                              environmentId={props.environmentId}
                              threadId={node.thread.id}
                              tasks={pendingBackgroundWorkOfThread(
                                node.thread.id,
                                node.thread.pendingBackgroundTasks,
                                currentThreadShell?.pendingBackgroundTasks,
                              )}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })
              }
            </ThreadLineageGroup>
          ))}
        </ThreadDetailsSection>
      ) : null}
      {hasBackgroundTasks ? (
        <ThreadDetailsSection
          headingId="thread-details-background-tasks-heading"
          title="Background tasks"
        >
          <ThreadLineageBackgroundTasks
            environmentId={props.environmentId}
            threadId={props.threadId}
            tasks={backgroundTasks}
          />
        </ThreadDetailsSection>
      ) : null}
    </>
  );
}
