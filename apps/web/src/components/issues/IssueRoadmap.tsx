import { T, useGT } from "gt-react";
import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { IssueInboxSection, useIssueInbox } from "./IssueInbox";
import { IssueDoneDetails } from "./IssueDoneDetails";
import { useIssueQueue } from "./IssueQueueAction";
import {
  GITHUB_ISSUE_STATUSES,
  IssueTrackerKind,
  type GitHubIssueStatus,
  type EnvironmentId,
  type IssueRepositoryRef,
  type RepositoryIssueSummary,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ArrowRightLeftIcon, GripVerticalIcon } from "lucide-react";
import { useProjects } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { findIssueProject } from "./issueWorktree.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { IssueSection } from "./IssueSection";
import { IssueRow } from "./IssueRow";
import { issueRoadmap, createIssueRoadmapClock, issueBoardColumns } from "./issueRoadmap.logic";
import { useIssueStageLabels } from "./IssueStateIcon";

const boardDragType = "application/x-t3-issue-board";
const stackedStatuses = [
  "Todo",
  "In progress",
  "In review",
  "Backlog",
  "Done",
  "Not planned",
  "Duplicate",
] as const satisfies readonly GitHubIssueStatus[];

export function IssueKanban({
  scope,
  environmentId,
  issues,
  visibleNumbers,
  onSelect,
  selectedIssueNumber,
  inbox,
}: Parameters<typeof IssueRoadmap>[0]) {
  const gt = useGT();
  const projects = useProjects();
  const project = findIssueProject(projects, { ...scope, environmentId }, null);
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const allowed = useAtomValue(issueEnvironment.setState.permissionAtom(environmentId));
  const [moving, setMoving] = useState<number | null>(null);
  const [dropStatus, setDropStatus] = useState<GitHubIssueStatus | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const boardId = useId();
  const [stacked, setStacked] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the board container to choose accessible columns or disclosures
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (board === null) return;
    const measure = () => setStacked(board.clientWidth < 768);
    measure();
    let frame = 0;
    const stop = observeResize(board, () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, []);
  const columns = issueBoardColumns(
    visibleNumbers === undefined
      ? issues
      : issues.filter(({ number }) => visibleNumbers.has(number)),
  );
  const sections = stacked
    ? columns.toSorted(
        (a, b) => stackedStatuses.indexOf(a.status) - stackedStatuses.indexOf(b.status),
      )
    : columns;
  const canMove = allowed && project !== null && scope.host === "github.com";
  const move = async (issue: RepositoryIssueSummary, state: GitHubIssueStatus) => {
    if (!canMove || moving !== null) return;
    setMoving(issue.number);
    const result = await setState({
      environmentId,
      input: {
        tracker: IssueTrackerKind.make("github"),
        projectId: project.id,
        host: scope.host,
        scope: scope.repository,
        key: String(issue.number),
        state,
      },
    });
    setMoving(null);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: gt("The state could not be changed"),
        description: formatEnvironmentQueryError(result.cause),
      });
  };
  return (
    <div ref={boardRef} className="min-w-0">
      {inbox}
      <div
        role="group"
        aria-label={gt("Issue board for {repository}", { repository: scope.repository })}
        className={cn("flex gap-3 px-3 pb-3", stacked ? "flex-col gap-2" : "overflow-x-auto")}
      >
        {sections.map(({ status, issues: cards }, index) => (
          <IssueSection
            key={status}
            scope={{ ...scope, environmentId }}
            section={`board:${status}`}
          >
            {(collapsed, toggleCollapsed) => (
              <section
                aria-label={status}
                className={cn(
                  "min-w-0 rounded-lg border border-border/60 bg-muted/25 p-2",
                  !stacked && "min-h-32 w-72 shrink-0",
                  dropStatus === status && "border-ring bg-accent/60",
                )}
                onDragOver={(event) => {
                  if (!canMove || !event.dataTransfer.types.includes(boardDragType)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropStatus(status);
                }}
                onDragLeave={(event) => {
                  if (
                    event.relatedTarget instanceof Node &&
                    event.currentTarget.contains(event.relatedTarget)
                  )
                    return;
                  setDropStatus(null);
                }}
                onDrop={(event) => {
                  setDropStatus(null);
                  if (!event.dataTransfer.types.includes(boardDragType)) return;
                  event.preventDefault();
                  const issue = issues.find(
                    ({ url }) => url === event.dataTransfer.getData(boardDragType),
                  );
                  if (issue !== undefined && !cards.includes(issue)) void move(issue, status);
                }}
              >
                {stacked ? (
                  <h3>
                    <CollapsibleSectionHeader
                      expanded={!collapsed}
                      variant="panel"
                      tone="emphasized"
                      aria-controls={`${boardId}-${index}`}
                      onClick={toggleCollapsed}
                      accessory={<span className="text-xs tabular-nums">{cards.length}</span>}
                    >
                      {status}
                    </CollapsibleSectionHeader>
                  </h3>
                ) : (
                  <h3 className="flex items-center justify-between px-1 pb-2 text-sm font-medium">
                    {status}
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {cards.length}
                    </span>
                  </h3>
                )}
                <ul id={`${boardId}-${index}`} hidden={stacked && collapsed} className="space-y-2">
                  {stacked && collapsed
                    ? null
                    : cards.map((issue) => (
                        <li
                          key={issue.number}
                          className="rounded-md border border-border/60 bg-background px-1"
                        >
                          <div className="flex items-start gap-1">
                            <IssueRow
                              issue={issue}
                              environmentId={environmentId}
                              selected={selectedIssueNumber === issue.number}
                              onSelect={() => onSelect(issue)}
                              className="flex-1"
                              layout="card"
                            />
                            {canMove ? (
                              <Menu>
                                <MenuTrigger
                                  render={
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-xs"
                                      className="mt-1"
                                      draggable={!stacked}
                                      disabled={moving !== null}
                                      aria-label={gt("Move issue #{number}", {
                                        number: issue.number,
                                      })}
                                      onDragStart={(event) => {
                                        event.dataTransfer.setData(boardDragType, issue.url);
                                        event.dataTransfer.effectAllowed = "move";
                                      }}
                                      onDragEnd={() => setDropStatus(null)}
                                    >
                                      {stacked ? <ArrowRightLeftIcon /> : <GripVerticalIcon />}
                                    </Button>
                                  }
                                />
                                <MenuPopup>
                                  {GITHUB_ISSUE_STATUSES.filter(
                                    (candidate) => candidate !== status,
                                  ).map((candidate) => (
                                    <MenuItem
                                      key={candidate}
                                      onClick={() => void move(issue, candidate)}
                                    >
                                      {candidate}
                                    </MenuItem>
                                  ))}
                                </MenuPopup>
                              </Menu>
                            ) : null}
                          </div>
                          {issue.labels.length > 0 ? (
                            <ul className="flex flex-wrap gap-1 px-2 pb-2">
                              {issue.labels.map(({ name }) => {
                                const label = name.toLowerCase();
                                return (
                                  <li key={name}>
                                    <Badge
                                      variant={
                                        label === "needs you"
                                          ? "warning"
                                          : label === "needs orchestrator"
                                            ? "info"
                                            : "secondary"
                                      }
                                      size="sm"
                                    >
                                      {name}
                                    </Badge>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                </ul>
              </section>
            )}
          </IssueSection>
        ))}
      </div>
    </div>
  );
}

/** The same roadmap is used in the Issues pane, browser and thread details. */
export function IssueRoadmap({
  scope,
  environmentId,
  issues,
  visibleNumbers,
  onSelect,
  selectedIssueNumber,
  limit = Infinity,
  inbox,
}: {
  scope: IssueRepositoryRef;
  environmentId: EnvironmentId;
  issues: readonly RepositoryIssueSummary[];
  visibleNumbers?: ReadonlySet<number>;
  onSelect: (issue: RepositoryIssueSummary) => void;
  selectedIssueNumber?: number;
  limit?: number;
  /** Rendered above Backlog, where the owner triages new activity. */
  inbox?: ReactNode;
}) {
  const gt = useGT();
  const stageLabels = useIssueStageLabels();
  const clock = createIssueRoadmapClock(issues);
  const now = useSyncExternalStore(clock.subscribe, clock.snapshot, clock.snapshot);
  const queue = useIssueQueue(environmentId, scope);
  const pendingInbox = useIssueInbox(environmentId, scope);
  const sections = issueRoadmap(
    { host: scope.host, repository: scope.repository },
    issues,
    queue.data?.queue?.map((entry) => entry.issue.number),
    now,
    pendingInbox.data?.pendingIssueNumbers ??
      pendingInbox.data?.events
        .filter((event) => event.kind === "issue_opened")
        .map((event) => event.issueNumber),
  );
  const shown = new Set(
    sections
      .flatMap((section) => section.rows)
      .filter((row) => visibleNumbers === undefined || visibleNumbers.has(row.issue.number))
      .slice(0, limit)
      .map((row) => row.issue.number),
  );
  return (
    <div aria-label={gt("Roadmap for {repository}", { repository: scope.repository })}>
      {queue.supported &&
      queue.data?.rootThreadId === null &&
      (queue.data.queue?.length ?? 0) > 0 ? (
        <p className="px-3 py-1 text-xs text-muted-foreground" role="status">
          <T>
            Waiting for a repository orchestrator. Right-click a thread and choose Make repository
            orchestrator to hand off queued issues.
          </T>
        </p>
      ) : null}
      {sections
        .filter((section) => section.id !== "queued" || queue.supported)
        .map((section) => {
          const title = stageLabels[section.stage];
          const rows = section.rows.filter((row) => shown.has(row.issue.number));
          return (
            <Fragment key={section.id}>
              {section.id === "backlog"
                ? (inbox ?? (
                    <IssueInboxSection
                      environmentId={environmentId}
                      reference={scope}
                      issues={issues}
                    />
                  ))
                : null}
              <IssueSection scope={{ ...scope, environmentId }} section={`roadmap:${section.id}`}>
                {(collapsed, toggleCollapsed) => (
                  <section aria-label={title}>
                    <CollapsibleSectionHeader
                      expanded={!collapsed}
                      onClick={toggleCollapsed}
                      accessory={<span className="tabular-nums">{rows.length}</span>}
                    >
                      {title}
                    </CollapsibleSectionHeader>
                    {!collapsed ? (
                      <ul>
                        {rows.map(({ issue, cycle }) => (
                          <li key={issue.number} className="px-2 py-1">
                            <IssueRow
                              issue={issue}
                              environmentId={environmentId}
                              selected={selectedIssueNumber === issue.number}
                              onSelect={() => onSelect(issue)}
                              className="flex-1 px-1"
                              cycle={cycle}
                            />
                            {issue.state === "closed" ? (
                              <IssueDoneDetails
                                issue={issue}
                                scope={scope}
                                environmentId={environmentId}
                              />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                )}
              </IssueSection>
            </Fragment>
          );
        })}
    </div>
  );
}
