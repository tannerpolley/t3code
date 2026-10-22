import { cn } from "../../lib/utils";
import {
  SidebarCaretToggle,
  SidebarThreadColumns,
  sidebarThreadName,
} from "../sidebar/SidebarColumns";
import {
  deriveProviderSubagentStatus,
  formatModelSelectionEffort,
} from "@t3tools/client-runtime/state/thread-execution";
import { useAtomValue } from "@effect/atom-react";
import { pendingBackgroundWorkOfThread } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { ThreadLocationIcon } from "../ThreadLocationIcon";
import { ThreadRoleIcon } from "../ThreadRoleIcon";
import { BackgroundWorkTaskList } from "./BackgroundWorkTaskList";
import {
  childWorktreeLabel,
  describeSidebarBackgroundWork,
  sidebarThreadTitle,
} from "../sidebar/SidebarBackgroundWork.logic";
import { ThreadIssueBadge } from "../sidebar/SidebarProjectThreadTooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { CollapsibleSectionHeader, SectionHeaderStatus } from "../ui/collapsible-section-header";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveWorkflowGroups,
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
  isProviderNativeSubagentThread,
  NodeId,
  type EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CornerDownRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SquareIcon,
  UnplugIcon,
} from "lucide-react";
import { useRef, useState, type PointerEvent, type ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  useProjects,
  useThreadProjection,
  useThreadRelationshipShells,
} from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { AgentElapsed } from "./AgentElapsed";
import { useThreadContextPointerDrag } from "./threadContextDrag";
import { shortModelName } from "./providerIconUtils";
import {
  canStopLineageSubagent,
  groupThreadLineageRows,
  resolveLineageClearedAt,
  SHOW_ALL_CLEARED,
} from "./ThreadRelationshipsControl.logic";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import { lineageStatusMark, ThreadStatusMark } from "../ThreadStatusMark";
import { ThreadLineageWorkflowRow } from "./ThreadLineageWorkflowRow";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

const THREAD_LINEAGE_INITIAL_COUNT = 6;
const THREAD_LINEAGE_PAGE_COUNT = 12;

function resolveThreadLineageWindow<Row>(
  rows: ReadonlyArray<Row>,
  visibleCount: number,
): { readonly visibleRows: ReadonlyArray<Row>; readonly hiddenCount: number } {
  const visibleRows = rows.slice(0, visibleCount);
  return { visibleRows, hiddenCount: rows.length - visibleRows.length };
}

function ThreadLineageRowList(props: {
  readonly hiddenCount: number;
  readonly onShowMore: () => void;
  readonly children: ReactNode;
}) {
  return (
    <>
      {/*
        Plain overflow, not a ScrollArea
        component: this sits inside an already scrolling panel, where a
        max-height-only virtual viewport measures badly.
      */}
      <ul
        aria-label="Related threads"
        className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0 has-data-workflow-expanded:max-h-[min(28rem,55dvh)]"
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
          variant="panel"
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
    <BackgroundWorkTaskList
      key={`${props.environmentId}:${props.threadId}`}
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

function currentSubagent<Agent extends RuntimeSubagent>(
  agent: Agent | undefined,
  childThread: OrchestrationV2ThreadShell | null | undefined,
): Agent | undefined {
  if (!agent || !childThread || isOrchestrationV2WorkActive(agent.status)) return agent;
  const liveStatus =
    childThread.activityRunStatus ?? (childThread.status === "queued" ? "queued" : null);
  const newerRun =
    childThread.latestRunRequestedAt &&
    DateTime.toEpochMillis(childThread.latestRunRequestedAt) >
      Date.parse(agent.completedAt ?? agent.startedAt ?? agent.updatedAt);
  if (!liveStatus && !newerRun) return agent;
  const status = liveStatus ?? childThread.status;
  const startedAt = liveStatus ? childThread.activityRunStartedAt : childThread.latestRunStartedAt;
  const completedAt = liveStatus ? null : childThread.latestRunCompletedAt;
  return {
    ...agent,
    status:
      status === "preparing" || status === "starting" || status === "queued"
        ? "pending"
        : status === "rolled_back"
          ? "interrupted"
          : status,
    startedAt: startedAt ? DateTime.formatIso(startedAt) : null,
    completedAt: completedAt ? DateTime.formatIso(completedAt) : null,
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
  const providersByEnvironment = useEnvironmentProviders();
  const relationshipShells = useThreadRelationshipShells(ref);
  const allProjects = useProjects();
  const archived = useArchivedThreadSnapshots([props.environmentId]);
  const archivedShells = archived.snapshots.find(
    (entry) => entry.environmentId === props.environmentId,
  )?.snapshot.threads;
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
  // Off restores the original rows: title, corner status badge, no details or clearing.
  const redesign = useClientSettings((settings) => settings.threadDetailsRedesign);
  const nowMinute = useNowMinute();
  const navigate = useNavigate();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const stopWorkflowCommand = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const canOperateWorkflow = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(props.environmentId),
  );
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  // Drag a row onto the composer to add its thread as context, as from Projects.
  const draggedRow = useRef<{ readonly threadId: ThreadId; readonly title: string } | null>(null);
  const rowDrag = useThreadContextPointerDrag(() => ({
    threads: draggedRow.current
      ? [scopeThreadRef(props.environmentId, draggedRow.current.threadId)]
      : [],
    title: draggedRow.current?.title ?? "Thread",
  }));
  const rowDragProps = (threadId: ThreadId, title: string) => ({
    onPointerDown: (event: PointerEvent) => {
      draggedRow.current = { threadId, title };
      rowDrag.onPointerDown(event);
    },
    onClickCapture: rowDrag.onClickCapture,
  });
  // These lookups and the graph walk every subagent and thread, so they sit below
  // the panel's hooks where the compiler can cache them.
  const providers = providersByEnvironment.get(props.environmentId);
  const projects = allProjects.filter((project) => project.environmentId === props.environmentId);
  const projected = projection?.subagents ?? [];
  const runtimeSubagents = projectedSubagentsToRuntime(projected);
  const byId = new Map(runtimeSubagents.map((agent) => [agent.id, agent]));
  const subagentsByThreadId = new Map(
    projected
      .filter((subagent) => subagent.childThreadId !== null)
      .map((subagent) => [
        subagent.childThreadId,
        {
          ...byId.get(subagent.id)!,
          id: subagent.id,
          threadId: subagent.threadId,
          runId: subagent.runId,
          nativeTaskRef: subagent.nativeTaskRef,
          nativeStatus: subagent.status,
          driver: subagent.driver,
          providerInstanceId: subagent.providerInstanceId,
          origin: subagent.origin,
          modelSelection: subagent.modelSelection,
        },
      ]),
  );
  const workflowGroupsById = new Map(
    deriveWorkflowGroups(runtimeSubagents).map((group) => [group.workflow.id, group]),
  );
  const shells: ReadonlyArray<OrchestrationV2ThreadShell> = [
    ...relationshipShells,
    ...(archivedShells ?? []),
  ];
  const graph = deriveThreadRelationshipGraph({ threads: shells, projection });
  const currentThread = projection?.thread ?? graph.nodes.get(props.threadId)?.thread;
  const currentThreadShell = graph.nodes.get(props.threadId)?.thread;
  const parentThreadId =
    currentThread?.forkedFrom?.type === "run"
      ? currentThread.forkedFrom.threadId
      : currentThread?.lineage.parentThreadId;
  const parentShell = parentThreadId ? graph.nodes.get(parentThreadId)?.thread : undefined;
  const parentRef =
    parentShell && isProviderNativeSubagentThread(parentShell)
      ? scopeThreadRef(props.environmentId, parentShell.id)
      : null;
  const parentProjection = useThreadProjection(parentRef)?.projection;
  const parentNativeStatus = parentProjection
    ? deriveProviderSubagentStatus(parentProjection)?.status
    : undefined;
  const currentProject = projects.find((project) => project.id === currentThread?.projectId);
  const latestMergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const relationshipRows = orderWebThreadLineageRows({
    graph,
    rows: immediateThreadRelationships(graph, props.threadId),
    currentThreadId: props.threadId,
    mergeTargetThreadId,
  }).map((row) => {
    const agent =
      row.edge.kind === "subagent" && !isParentThreadRelationship(row.edge, props.threadId)
        ? subagentsByThreadId.get(row.threadId)
        : undefined;
    const workflowGroup = agent === undefined ? undefined : workflowGroupsById.get(agent.id);
    return workflowGroup === undefined
      ? row
      : { ...row, edge: { ...row.edge, status: workflowGroup.workflow.status } };
  });
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
    clearedAt: redesign
      ? resolveLineageClearedAt({
          stored: lineageAgentsClearedAtById[threadKey],
          autoClearMinutes,
          now: Date.parse(`${nowMinute}:00.000Z`),
        })
      : null,
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
        redesign &&
        ((previousExpanded && previous.length > 0) ||
          (previous.length === 0 && clearedCount > 0)) ? (
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

  const stopSubagent = async (
    childThreadId: ThreadId,
    agent: Pick<OrchestrationV2Subagent, "id" | "threadId">,
  ) => {
    if (stoppingId !== null) return;
    setStoppingId(childThreadId);
    const result = await interruptTurn({
      environmentId: props.environmentId,
      input: { threadId: agent.threadId, subagentId: agent.id },
    });
    setStoppingId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not stop subagent" });
    }
  };

  const stopWorkflow = async (subagentId: string) => {
    if (stoppingId !== null) return;
    setStoppingId(subagentId);
    const result = await stopWorkflowCommand({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, subagentId: NodeId.make(subagentId) },
    });
    setStoppingId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not stop workflow" });
    }
  };

  const detailsKey = (threadId: ThreadId) =>
    scopedThreadKey(scopeThreadRef(props.environmentId, threadId));
  const detailsExpanded = (threadId: ThreadId) =>
    redesign && (lineageDetailsExpandedById[detailsKey(threadId)] ?? expandDetailsByDefault);
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
              {redesign && shownRows.length > 0 ? (
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
                  const rowStatus =
                    (isParent && threadId === parentRef?.threadId
                      ? (node?.thread?.activityRunStatus ?? parentNativeStatus)
                      : undefined) ?? threadRelationshipRowStatus(graph, { threadId, edge });
                  const RelationshipIcon = isParent
                    ? CornerLeftUpIcon
                    : isSubagent
                      ? CornerDownRightIcon
                      : GitForkIcon;
                  const relationship = relationshipLabel(edge, props.threadId);
                  const projectedAgent =
                    isSubagent && !isParent ? subagentsByThreadId.get(threadId) : undefined;
                  const workflowGroup =
                    projectedAgent === undefined
                      ? undefined
                      : workflowGroupsById.get(projectedAgent.id);
                  const agent = workflowGroup
                    ? projectedAgent
                    : currentSubagent(projectedAgent, node?.thread);
                  const failed = rowStatus === "failed" || rowStatus === "error";
                  const canStop = canStopLineageSubagent(agent);
                  const threadTitle = relationshipThreadTitle({
                    title:
                      workflowGroup?.workflow.workflowName ??
                      node?.thread?.title ??
                      agent?.title ??
                      threadId,
                    isSubagent,
                  });
                  const provider = providers?.find(
                    (entry) =>
                      entry.instanceId ===
                      (agent?.providerInstanceId ?? node?.thread?.providerInstanceId),
                  );
                  const providerDriver = agent?.driver ?? provider?.driver;
                  const canStopWorkflow =
                    canOperateWorkflow &&
                    workflowGroup?.workflow.status === "running" &&
                    agent?.origin === "provider_native" &&
                    providerDriver === "claudeAgent";
                  const trailingVisibilityClass = (workflowGroup ? canStopWorkflow : canStop)
                    ? "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0 [@media(hover:none)]:opacity-0"
                    : "";
                  const project = projects.find(
                    (project) => project.id === node?.thread?.projectId,
                  );
                  // As in the hover card: a provider-native child thread does not carry
                  // the agent's own selection.
                  const modelSelection = isSubagent
                    ? (agent?.modelSelection ??
                      (agent?.origin !== "provider_native" && node?.thread?.latestRunId
                        ? node.thread.modelSelection
                        : null))
                    : (node?.thread?.modelSelection ?? null);
                  const elapsedAgent =
                    agent && rowStatus === "waiting"
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
                      providerInstanceId={elapsedAgent.providerInstanceId}
                      origin={elapsedAgent.origin}
                      modelSelection={elapsedAgent.modelSelection}
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
                  const relationshipContent = redesign ? (
                    <SidebarThreadColumns
                      location={
                        node?.thread ? (
                          <ThreadLocationIcon
                            thread={{
                              ...node.thread,
                              source: node.thread,
                              environmentId: props.environmentId,
                            }}
                          />
                        ) : undefined
                      }
                      role={node?.thread ? <ThreadRoleIcon thread={node.thread} /> : undefined}
                      provider={
                        <ThreadRelationshipIcon
                          driver={isSubagent && !isParent ? providerDriver : undefined}
                          provider={provider}
                          fallbackIcon={RelationshipIcon}
                        />
                      }
                      model={model ? shortModelName(metadata.modelLabel) : undefined}
                      effort={effortLabel}
                      name={
                        <span className="flex min-w-0 items-center gap-1">
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate",
                              node?.thread && "sidebar-role-title",
                            )}
                          >
                            {node?.thread
                              ? sidebarThreadName(threadTitle, sidebarThreadTitle(node.thread))
                              : threadTitle}
                          </span>
                          <ThreadIssueBadge
                            environmentId={props.environmentId}
                            issue={node?.thread?.linkedIssue}
                          />
                          {!elapsedAgent ? (
                            <span className="shrink-0 text-2xs text-muted-foreground">
                              {threadRelationshipStatusLabel(rowStatus)}
                            </span>
                          ) : null}
                          <span className="sr-only">
                            Status: {threadRelationshipStatusLabel(rowStatus)}
                          </span>
                          {agent ? null : (
                            <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                          )}
                        </span>
                      }
                      trailingClassName={trailingVisibilityClass}
                      time={
                        elapsedAgent && !failed ? <AgentElapsed agent={elapsedAgent} /> : undefined
                      }
                      status={<ThreadStatusMark status={lineageStatusMark(rowStatus)} />}
                    />
                  ) : (
                    <>
                      {node?.thread ? (
                        <ThreadLocationIcon
                          thread={{
                            ...node.thread,
                            source: node.thread,
                            environmentId: props.environmentId,
                          }}
                        />
                      ) : null}
                      {node?.thread ? <ThreadRoleIcon thread={node.thread} /> : null}
                      <ThreadRelationshipIcon
                        driver={isSubagent && !isParent ? providerDriver : undefined}
                        provider={provider}
                        fallbackIcon={RelationshipIcon}
                        {...(redesign ? {} : { status: rowStatus })}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
                          {threadTitle}
                        </span>
                      </span>
                      {agent ? null : (
                        <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      )}
                      {elapsedAgent &&
                      !failed &&
                      (deriveSubagentElapsedMs(elapsedAgent, 0) !== null || canStopWorkflow) ? (
                        <span
                          className={`shrink-0 text-2xs font-normal tabular-nums text-muted-foreground ${canStopWorkflow ? "min-w-6 text-end" : ""} ${trailingVisibilityClass}`}
                        >
                          <AgentElapsed agent={elapsedAgent} compact />
                        </span>
                      ) : !isMergeTarget ? (
                        <span
                          className={
                            workflowGroup
                              ? "sr-only"
                              : `shrink-0 text-2xs ${failed ? "text-destructive" : "text-muted-foreground"} ${trailingVisibilityClass}`
                          }
                        >
                          {threadRelationshipStatusLabel(rowStatus)}
                        </span>
                      ) : null}
                    </>
                  );

                  const relationshipLink = (
                    <Tooltip>
                      <TooltipTrigger
                        delay={200}
                        render={
                          <ThreadDetailsControl
                            size="sm"
                            variant="ghost"
                            part={workflowGroup ? "primary" : "row"}
                            disabled={node?.missing === true}
                            onClick={() => openThread(threadId)}
                            {...rowDragProps(threadId, threadTitle)}
                          />
                        }
                      >
                        {relationshipContent}
                      </TooltipTrigger>
                      <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
                    </Tooltip>
                  );
                  if (workflowGroup && agent) {
                    return (
                      <ThreadLineageWorkflowRow
                        key={threadId}
                        group={workflowGroup}
                        environmentId={props.environmentId}
                        providerInstanceId={agent.providerInstanceId}
                        provider={provider}
                        providers={providers}
                        driver={providerDriver}
                        onOpenThread={(memberThreadId) => openThread(memberThreadId as ThreadId)}
                        isThreadAvailable={(memberThreadId) =>
                          graph.nodes.get(memberThreadId as ThreadId)?.missing === false
                        }
                        onStop={canStopWorkflow ? () => void stopWorkflow(agent.id) : undefined}
                        stopping={stoppingId === agent.id}
                        stopDisabled={stoppingId !== null}
                        header={relationshipLink}
                      />
                    );
                  }
                  const rowExpanded = !node?.missing && detailsExpanded(threadId);
                  const detailsToggle =
                    node?.missing || !redesign ? null : (
                      <SidebarCaretToggle
                        open={rowExpanded}
                        label={`${rowExpanded ? "Hide" : "Show"} details for ${threadTitle}`}
                        onToggle={() =>
                          setLineageDetailsExpanded([detailsKey(threadId)], !rowExpanded)
                        }
                        className="top-1 h-6 ms-0.5"
                      />
                    );
                  return (
                    <li
                      key={threadId}
                      className={cn(redesign && "sidebar-columns-container", "group rounded-lg")}
                    >
                      <div className="relative flex h-8 items-center">
                        <div className="relative flex min-w-0 flex-1 items-center">
                          {isMergeTarget ? (
                            <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
                              <Tooltip>
                                <TooltipTrigger
                                  delay={200}
                                  render={
                                    <ThreadDetailsControl
                                      size="sm"
                                      variant="ghost"
                                      part="primary"
                                      aria-label={`${threadTitle} ${threadRelationshipStatusLabel(rowStatus)}`}
                                      disabled={node?.missing === true}
                                      onClick={() => openThread(threadId)}
                                      {...rowDragProps(threadId, threadTitle)}
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
                                {threadRelationshipStatusLabel(rowStatus)}
                              </span>
                            </div>
                          ) : (
                            relationshipLink
                          )}
                          {canStop && agent ? (
                            <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <ThreadDetailsControl
                                      size="icon-xs"
                                      variant="ghost"
                                      part="icon"
                                      tone="destructive"
                                      aria-label={`Stop subagent ${threadTitle}`}
                                      disabled={stoppingId !== null}
                                      onClick={() => void stopSubagent(threadId, agent)}
                                    />
                                  }
                                >
                                  {stoppingId === threadId ? (
                                    <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                                  ) : (
                                    <SquareIcon aria-hidden className="size-3 fill-current" />
                                  )}
                                </TooltipTrigger>
                                <TooltipPopup side="left">Stop subagent</TooltipPopup>
                              </Tooltip>
                            </div>
                          ) : null}
                        </div>
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
