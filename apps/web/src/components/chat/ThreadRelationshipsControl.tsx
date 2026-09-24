import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { CollapsibleSectionHeader, SectionHeaderStatus } from "../ui/collapsible-section-header";
import {
  resolveSubagentModelLabel,
  SubagentDetails,
  SubagentPreviewLine,
  SubagentTooltipContent,
  SubagentWorkspaceLines,
  subagentDetailPreview,
} from "./SubagentTooltipContent";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  isParentThreadRelationship,
  resolveSubagentActivation,
  resolveSubagentStatus,
  orderWebThreadLineageRows,
  resolveMergeBackTargetThreadId,
  type ThreadRelationshipEdge,
  type ThreadRelationshipWalkRow,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  canDetachThreadProviderSession,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import type {
  EnvironmentId,
  OrchestrationV2LatestVisibleMessageSummary,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { groupBy } from "effect/Array";
import * as DateTime from "effect/DateTime";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  UnplugIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  useProjects,
  useServerConfigs,
  useThreadProjection,
  useThreadShells,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentElapsed } from "./AgentElapsed";
import { BackgroundWorkTaskList } from "./BackgroundWorkTaskList";
import { describeSidebarBackgroundWork } from "./BackgroundWorkTaskList.logic";
import { lineageStatusMark, ThreadStatusMark } from "../ThreadStatusMark";
import { resolveThreadStatusMark } from "../Sidebar.logic";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
  THREAD_DETAILS_PANEL_LINK_ROW_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_MENU_POPUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

const FINISHED_AGENT_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "interrupted",
  "idle",
]);

/**
 * Splits Lineage rows into related threads (parent, forks, transfers), live agents, and finished
 * agents. Finished agents that settled by `clearedAt` are only counted, so each group lists exactly
 * the rows its header summarizes. Live agents are never cleared.
 */
export function groupThreadLineageRows(input: {
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly clearedAt: number | null;
  readonly finishedAt: (threadId: ThreadId) => number | null;
}) {
  const {
    related = [],
    active = [],
    finished = [],
  } = groupBy(input.rows, ({ edge }) => {
    if (edge.kind !== "subagent" || isParentThreadRelationship(edge, input.currentThreadId))
      return "related";
    return FINISHED_AGENT_STATUSES.has(edge.status ?? "") ? "finished" : "active";
  });
  const { clearedAt } = input;
  // An agent with no known finish time was listed before the clear, so it stays cleared.
  const previous =
    clearedAt === null
      ? finished
      : finished.filter(({ threadId }) => (input.finishedAt(threadId) ?? clearedAt) > clearedAt);
  return { related, active, previous, clearedCount: finished.length - previous.length };
}

function ThreadLineageGroup(props: {
  readonly label: string | null;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly expanded: boolean;
  readonly onToggle?: () => void;
  readonly footer?: ReactNode;
  readonly children: (rows: ReadonlyArray<ThreadRelationshipWalkRow>) => ReactNode;
}) {
  const failedCount = props.rows.filter(
    ({ edge }) => edge.status === "failed" || edge.status === "error",
  ).length;
  if (props.rows.length === 0 && !props.footer) return null;
  return (
    <div>
      {props.label && props.rows.length > 0 ? (
        <CollapsibleSectionHeader
          expanded={props.expanded}
          onClick={props.onToggle}
          accessory={
            failedCount > 0 ? <SectionHeaderStatus>{failedCount} failed</SectionHeaderStatus> : null
          }
        >
          {props.label}
          {!props.expanded && ` (${props.rows.length})`}
        </CollapsibleSectionHeader>
      ) : null}
      {props.expanded && props.rows.length > 0 ? (
        // Bounded rather than free-growing so Lineage cannot push the rest of the thread details
        // panel out of view. Plain overflow, not a ScrollArea: this sits inside an already
        // scrolling panel, where a max-height-only virtual viewport measures badly. Every row is
        // a focusable button, so keyboard users reach and scroll the region through the rows.
        <ul
          aria-label="Related threads"
          className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0"
        >
          {props.children(props.rows)}
        </ul>
      ) : null}
      {props.footer}
    </div>
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
 * A subagent row's progress line. Claude subagents report progress, then a result; Codex ones
 * send neither while they run, so the child thread's latest assistant message (from its shell,
 * no projection subscription) stands in.
 */
export function resolveSubagentProgressText(input: {
  readonly status: string;
  readonly progress?: string | null | undefined;
  readonly result: string | null;
  readonly latestMessage: Pick<OrchestrationV2LatestVisibleMessageSummary, "role" | "text"> | null;
}): string {
  const reported = subagentDetailPreview(input);
  if (reported || input.latestMessage?.role !== "assistant") return reported;
  return subagentDetailPreview({ progress: input.latestMessage.text });
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
  // Live threads as the sidebar sees them, so a row's mark follows the sidebar's rules.
  const liveThreadsById = useMemo(
    () =>
      new Map(
        threadShells
          .filter((thread) => thread.environmentId === props.environmentId)
          .map((thread) => [thread.id, thread]),
      ),
    [props.environmentId, threadShells],
  );
  const threadLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const currentThread = projection?.thread ?? graph.nodes.get(props.threadId)?.thread;
  const currentProject = projects.find((project) => project.id === currentThread?.projectId);
  const navigate = useNavigate();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  // Rows opened or closed by hand are remembered; the rest follow the Customizations default.
  const lineageDetailsExpandedById = useUiStateStore((store) => store.lineageDetailsExpandedById);
  const setLineageDetailsExpanded = useUiStateStore((store) => store.setLineageDetailsExpanded);
  const threadKey = scopedThreadKey(ref);
  const clearedAtIso = useUiStateStore((store) => store.lineageAgentsClearedAtById[threadKey]);
  const setLineageAgentsClearedAt = useUiStateStore((store) => store.setLineageAgentsClearedAt);
  const [previousOpenFor, setPreviousOpenFor] = useState<string | null>(null);
  const previousExpanded = previousOpenFor === threadKey;
  const expandDetailsByDefault = useClientSettings((settings) => settings.lineageDetailsExpanded);
  // Off restores the original rows: title, corner status badge, no details.
  const redesign = useClientSettings((settings) => settings.threadDetailsRedesign);
  const shortModelNames = useClientSettings((settings) => settings.shortModelNames);
  const isRunning = (status: string | null) =>
    redesign ? lineageStatusMark(status) === "working" : status === "running";
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

  // When an agent last settled: its own record, or its child thread's latest run once steered again.
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
    // Clearing is part of the fork's Lineage redesign; off shows every agent.
    clearedAt: !redesign || clearedAtIso === undefined ? null : Date.parse(clearedAtIso),
    finishedAt,
  });
  const runningCount =
    projection?.subagents.filter((agent) =>
      isRunning(
        resolveSubagentStatus(
          agent,
          agent.childThreadId === null ? null : graph.nodes.get(agent.childThreadId)?.thread,
        ),
      ),
    ).length ?? active.filter(({ edge }) => isRunning(edge.status)).length;

  if (relationshipRows.length === 0 && runningCount === 0) {
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
    redesign && (lineageDetailsExpandedById[detailsKey(threadId)] ?? expandDetailsByDefault);
  // Expand/collapse all reads and sets only the rows on screen, so it always matches them.
  const shownRows = [...related, ...active, ...(previousExpanded ? previous : [])].filter(
    ({ threadId }) => !graph.nodes.get(threadId)?.missing,
  );
  const anyDetailsCollapsed = shownRows.some(({ threadId }) => !detailsExpanded(threadId));
  const toggleAllDetails = () =>
    setLineageDetailsExpanded(
      shownRows.map(({ threadId }) => detailsKey(threadId)),
      anyDetailsCollapsed,
    );

  // Clearing hides the finished agents listed now; the stamp covers the newest of them even if
  // the server's clock runs ahead of this one.
  const clearPrevious = () =>
    setLineageAgentsClearedAt(
      threadKey,
      new Date(
        Math.max(Date.now(), ...previous.map(({ threadId }) => finishedAt(threadId) ?? 0)),
      ).toISOString(),
    );
  const showCleared = () => {
    setLineageAgentsClearedAt(threadKey, null);
    setPreviousOpenFor(threadKey);
  };
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
          <div className="flex h-7 items-center gap-1 px-2 text-[11px] text-muted-foreground/70">
            {clearedCount > 0 ? (
              <>
                {clearedCount} cleared ·
                <button
                  type="button"
                  aria-label="Show cleared agents"
                  className="cursor-pointer hover:text-foreground/80"
                  onClick={showCleared}
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

  const parentTitle =
    mergeTargetThreadId === null
      ? null
      : (graph.nodes.get(mergeTargetThreadId)?.thread?.title ?? null);

  return (
    <ThreadDetailsSection
      headingId="thread-details-lineage-heading"
      title={runningCount > 0 ? `Lineage · ${runningCount} running` : "Lineage"}
      data-thread-relationships-panel
      actions={
        <>
          {redesign && shownRows.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className={THREAD_DETAILS_PANEL_ICON_ACTION_CLASS}
                    aria-label={anyDetailsCollapsed ? "Expand all details" : "Collapse all details"}
                    onClick={toggleAllDetails}
                  >
                    {anyDetailsCollapsed ? (
                      <ChevronsUpDownIcon className="size-3.5" />
                    ) : (
                      <ChevronsDownUpIcon className="size-3.5" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="left">
                {anyDetailsCollapsed ? "Expand all details" : "Collapse all details"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {canDetach ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className={THREAD_DETAILS_PANEL_ICON_ACTION_CLASS}
                    aria-label="More thread actions"
                    disabled={busyAction !== null}
                  />
                }
              >
                <MoreHorizontalIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end" className={THREAD_DETAILS_PANEL_MENU_POPUP_CLASS}>
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
        <ThreadLineageGroup key={group.id} {...group}>
          {(visibleRows) =>
            visibleRows.map(({ threadId, edge }) => {
              const node = graph.nodes.get(threadId);
              const isSubagent = edge.kind === "subagent";
              const isMergeTarget = threadId === mergeTargetThreadId;
              const isParent = isParentThreadRelationship(edge, props.threadId);
              const RelationshipIcon = isParent
                ? CornerLeftUpIcon
                : isSubagent
                  ? BotIcon
                  : GitForkIcon;
              const relationship = relationshipLabel(edge, props.threadId);
              const agent = isSubagent && !isParent ? subagentsByThreadId.get(threadId) : undefined;
              // Timer and model follow the same child state as the status, not the parent's record.
              const activation = agent && resolveSubagentActivation(agent, node?.thread);
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
              const project = projects.find((project) => project.id === node?.thread?.projectId);
              const relationshipHint = node?.missing
                ? "This related thread is unavailable"
                : `Open ${relationship.toLowerCase()} in this chat`;
              const RelationshipPopup = agent ? ThreadHoverCardPopup : TooltipPopup;
              const relationshipTooltip = agent ? (
                <SubagentTooltipContent
                  title={threadTitle}
                  model={activation?.model ?? null}
                  provider={provider}
                  driver={providerDriver}
                  elapsed={activation ? <AgentElapsed agent={activation} /> : null}
                  status={edge.status ?? agent.status}
                  result={agent.result}
                  progress={agent.progress}
                  parentThread={currentThread ?? undefined}
                  childThread={node?.thread ?? undefined}
                  parentProject={currentProject}
                  childProject={project}
                />
              ) : (
                relationshipHint
              );
              // Threads the sidebar knows share its mark; a transfer row shows the transfer. A
              // child you never opened counts as seen when created, so its finished run stays
              // green until you open it (the sidebar lists no settled children to compare).
              const liveThread =
                edge.kind === "transfer" ? undefined : liveThreadsById.get(threadId);
              const statusMark = (
                <ThreadStatusMark
                  status={
                    liveThread
                      ? resolveThreadStatusMark(
                          agent && liveThread.lastVisitedAt === null
                            ? { ...liveThread, lastVisitedAt: liveThread.createdAt }
                            : liveThread,
                          threadLastVisitedAtById[detailsKey(threadId)],
                        )
                      : lineageStatusMark(edge.status)
                  }
                />
              );
              // Agents lead with what runs them; their name moves into the details.
              const relationshipContent = !redesign ? (
                <>
                  <ThreadRelationshipIcon
                    driver={isSubagent && !isParent ? providerDriver : undefined}
                    provider={provider}
                    fallbackIcon={RelationshipIcon}
                    status={edge.status}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium leading-4 text-foreground/85">
                      {threadTitle}
                    </span>
                    {agent ? <span className="sr-only">{edge.status ?? agent.status}</span> : null}
                  </span>
                  {activation ? (
                    activation.startedAt ? (
                      <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
                        <AgentElapsed agent={activation} />
                      </span>
                    ) : null
                  ) : (
                    <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                </>
              ) : agent && activation ? (
                <>
                  <ThreadRelationshipIcon
                    driver={providerDriver}
                    provider={provider}
                    fallbackIcon={RelationshipIcon}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-4 text-foreground/85">
                    {resolveSubagentModelLabel(
                      { model: activation.model, provider, childThread: node?.thread ?? undefined },
                      { shortName: shortModelNames },
                    )}
                    <span className="sr-only">
                      , {threadTitle}, {edge.status ?? agent.status}
                    </span>
                  </span>
                  {activation.startedAt ? (
                    <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
                      <AgentElapsed agent={activation} />
                    </span>
                  ) : null}
                  {statusMark}
                </>
              ) : (
                <>
                  <ThreadRelationshipIcon
                    driver={isSubagent && !isParent ? providerDriver : undefined}
                    provider={provider}
                    fallbackIcon={RelationshipIcon}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-4 text-foreground/85">
                    {threadTitle}
                  </span>
                  {statusMark}
                  <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </>
              );
              const rowExpanded = !node?.missing && detailsExpanded(threadId);
              // The child's own pending background work, read from its shell rather than its projection.
              const processRows =
                agent && rowExpanded
                  ? describeSidebarBackgroundWork(node?.thread?.pendingBackgroundTasks ?? [], [])
                  : [];
              const detailsToggle =
                node?.missing || !redesign ? null : (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-expanded={rowExpanded}
                    aria-label={`${rowExpanded ? "Hide" : "Show"} details for ${threadTitle}`}
                    className="shrink-0 text-muted-foreground"
                    onClick={() => setLineageDetailsExpanded([detailsKey(threadId)], !rowExpanded)}
                  >
                    <ChevronDownIcon
                      className={cn("size-3.5 transition-transform", !rowExpanded && "-rotate-90")}
                    />
                  </Button>
                );
              return (
                <li key={threadId} className="group rounded-lg">
                  <div className="flex h-9 items-center">
                    {isMergeTarget ? (
                      <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
                        <Tooltip>
                          <TooltipTrigger
                            delay={200}
                            render={
                              <Button
                                size="sm"
                                variant="ghost"
                                className={THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS}
                                disabled={node?.missing === true}
                                onClick={() => openThread(threadId)}
                              />
                            }
                          >
                            {relationshipContent}
                          </TooltipTrigger>
                          <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
                        </Tooltip>
                        <span
                          aria-hidden="true"
                          className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS}
                        />
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="sm"
                                variant="ghost"
                                className={THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS}
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
                              </Button>
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
                      </div>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger
                          delay={200}
                          render={
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={node?.missing === true}
                              onClick={() => openThread(threadId)}
                              className={THREAD_DETAILS_PANEL_LINK_ROW_CLASS}
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
                      {agent ? (
                        // Name, what it is running now, where it works, and its progress; the
                        // model, time, and status are already on the row.
                        <>
                          <span className="truncate text-foreground/75">{threadTitle}</span>
                          {processRows.length > 0 ? (
                            <BackgroundWorkTaskList
                              compact
                              environmentId={props.environmentId}
                              threadId={threadId}
                              rows={processRows}
                            />
                          ) : null}
                          <SubagentWorkspaceLines
                            model={agent.model}
                            parentThread={currentThread ?? undefined}
                            childThread={node?.thread ?? undefined}
                            parentProject={currentProject}
                            childProject={project}
                          />
                          <SubagentPreviewLine
                            text={resolveSubagentProgressText({
                              ...agent,
                              latestMessage: node?.thread?.latestVisibleMessage ?? null,
                            })}
                          />
                        </>
                      ) : (
                        // The hover card's lines, kept open.
                        <SubagentDetails
                          model={null}
                          provider={provider}
                          driver={providerDriver}
                          parentThread={currentThread ?? undefined}
                          childThread={node?.thread ?? undefined}
                          parentProject={currentProject}
                          childProject={project}
                        />
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })
          }
        </ThreadLineageGroup>
      ))}
    </ThreadDetailsSection>
  );
}
