import { useWorkerStatusLabels } from "../issues/IssueLiveWork";
import { useSidebarIssueWorkerStatus } from "../../state/repositoryIssues";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import { SIDEBAR_WORKER_PAGE_SIZE, type EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { CornerDownRightIcon } from "lucide-react";
import { useEffect, useState, type ComponentProps, type MouseEvent } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSnapshotAtom } from "../../state/shell";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { environmentThreadShells, threadFamilies } from "../../state/threads";
import type { SidebarThreadSummary } from "../../types";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { resolveSidebarThreadStatus, useSidebarRowSubscriptionLease } from "../Sidebar.logic";
import { ThreadLocationIcon } from "../ThreadLocationIcon";
import { ThreadRoleIcon } from "../ThreadRoleIcon";
import { ThreadStatusMark } from "../ThreadStatusMark";
import { sidebarRoleLabel, sidebarThreadProvider } from "./SidebarBackgroundWork.logic";
import { SidebarChildThreadColumns } from "./SidebarBackgroundWorkRows";
import { PROJECTS_WORK_ROW_HEIGHT } from "./SidebarColumns";
import { sidebarProjectThreadAccessibleName } from "./SidebarProjectThread.logic";
import { SidebarProjectThreadTooltip } from "./SidebarProjectThreadTooltip";
import type { SidebarProviderEntry } from "./SidebarThreadRow";
import { indexSidebarWorkers, sidebarWorkerPage } from "./SidebarWorkers.logic";

const sidebarWorkers = Atom.map(environmentThreadShells.quietThreadShellsAtom, indexSidebarWorkers);
const omittedFamilies = Atom.family((environmentId: EnvironmentId) =>
  Atom.map(
    Atom.map(environmentSnapshotAtom(environmentId), (snapshot) => snapshot?.omittedWorkers),
    (omitted) => new Set(omitted?.map(({ parentThreadId }) => parentThreadId)),
  ),
);
const EMPTY: readonly SidebarThreadSummary[] = [];
const unpagedWorkers = Atom.make({ generation: 0, pages: [], waiting: false, failedQuery: null });
const childrenFor = Atom.family((key: string) =>
  Atom.map(sidebarWorkers, ({ children, running }) => {
    const siblings = children.get(key) ?? EMPTY;
    return {
      idle: siblings.filter(
        (child) => !running.has(scopedThreadKey(scopeThreadRef(child.environmentId, child.id))),
      ),
      running: siblings.filter((child) =>
        running.has(scopedThreadKey(scopeThreadRef(child.environmentId, child.id))),
      ),
    };
  }).pipe(
    Atom.withEquality<{ idle: SidebarThreadSummary[]; running: SidebarThreadSummary[] }>(
      (a, b) => arrayElementsEqual(a.idle, b.idle) && arrayElementsEqual(a.running, b.running),
    ),
  ),
);
type WorkerRowsProps = {
  readonly thread: SidebarThreadSummary;
  readonly includeRunning?: boolean;
  readonly columns?: boolean | undefined;
  readonly providerEntries?: ReadonlyMap<string, SidebarProviderEntry> | undefined;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>, thread: SidebarThreadSummary) => void;
  readonly onContextMenu: (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
  ) => void;
};

export function SidebarWorkerRows(props: WorkerRowsProps) {
  const gt = useGT();
  const { environmentId, id } = props.thread;
  const key = scopedThreadKey(scopeThreadRef(environmentId, id));
  const { idle, running } = useAtomValue(childrenFor(key));
  const omitted = useAtomValue(omittedFamilies(environmentId));
  const canPage = omitted.has(id);
  const { rowRef, leaseLiveStatus: nearViewport } = useSidebarRowSubscriptionLease(false);
  const listRef = useStableCallback(rowRef);
  const [paging, setPaging] = useState(false);
  if (!paging && canPage && nearViewport) setPaging(true);
  const pageKey = JSON.stringify([environmentId, id]);
  const { count: pageCount, state, rows } = threadFamilies.workerPages(pageKey);
  const [count, setCount] = useAtom(pageCount);
  const { pages, failedQuery } = useAtomValue(paging ? state : unpagedWorkers);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- merges the mounted pages with authoritative shell deltas
  useEffect(() => {
    if (paging) return threadFamilies.mountRows(appAtomRegistry, environmentId, pageKey, rows);
  }, [paging, environmentId, pageKey, rows]);
  const limit = count * SIDEBAR_WORKER_PAGE_SIZE;
  const selectedOutsidePage = useParams({
    strict: false,
    select: (params) => {
      const route = resolveThreadRouteRef(params);
      if (idle.length <= limit || route?.environmentId !== environmentId) return null;
      return idle.findIndex((worker) => worker.id === route.threadId) >= limit
        ? route.threadId
        : null;
    },
  });
  const workers = [
    ...(props.includeRunning ? running : EMPTY),
    ...sidebarWorkerPage(idle, limit, selectedOutsidePage),
  ];
  const remaining = Math.max(idle.length - limit, pages.at(-1)?.remainingWorkers ?? 0);
  if (workers.length === 0 && !canPage && failedQuery === null) return null;
  return (
    <ul
      ref={canPage && !paging ? listRef : undefined}
      className={cn(
        "min-h-px",
        props.columns
          ? props.thread.lineage.relationshipToParent === "subagent" && "ps-3"
          : "ms-3 border-s border-sidebar-border/60 ps-1",
      )}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {workers.map((worker) => (
        <li
          key={worker.id}
          data-thread-item={scopedThreadKey(scopeThreadRef(worker.environmentId, worker.id))}
          className={cn("list-none", props.columns && "fork-sidebar-agent-item")}
        >
          <SidebarWorkerButton
            thread={worker}
            parent={key}
            columns={props.columns}
            providerEntries={props.providerEntries}
            onClick={props.onClick}
            onContextMenu={props.onContextMenu}
          />
          <SidebarWorkerRows {...props} thread={worker} />
        </li>
      ))}
      {failedQuery !== null || remaining > 0 ? (
        <li className="list-none">
          <button
            type="button"
            className="w-full cursor-pointer rounded-md px-2 py-0.5 text-start text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
            onClick={() =>
              failedQuery === null
                ? setCount((current) => current + 1)
                : appAtomRegistry.refresh(failedQuery)
            }
          >
            {failedQuery === null
              ? gt("Show more workers ({count})", { count: remaining })
              : gt("Retry loading workers")}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function SidebarWorkerButton(
  props: Pick<
    WorkerRowsProps,
    "thread" | "columns" | "providerEntries" | "onClick" | "onContextMenu"
  > & {
    readonly parent: string;
  },
) {
  const { thread } = props;
  const active = useParams({
    strict: false,
    select: (params) =>
      params.environmentId === thread.environmentId && params.threadId === thread.id,
  });
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const key = scopedThreadKey(ref);
  const selected = useThreadSelectionStore((store) => store.selectedThreadKeys.has(key));
  const status = resolveSidebarThreadStatus(thread);
  const workerStatus = useSidebarIssueWorkerStatus(thread, status === "ready");
  const labels = useWorkerStatusLabels();
  const workerLabel = workerStatus == null ? workerStatus : labels[workerStatus];
  const provider = sidebarThreadProvider(props.providerEntries, thread.providerInstanceId);
  const button = (
    <button
      type="button"
      ref={active ? revealWorker : undefined}
      data-sidebar-row={key}
      data-sidebar-parent={props.parent}
      aria-current={active || undefined}
      aria-label={
        props.columns
          ? sidebarProjectThreadAccessibleName({
              role: sidebarRoleLabel(thread.source),
              title: thread.title,
              issueNumber: thread.source.linkedIssue?.number,
              status: workerLabel ?? status,
              links: thread.pullRequests,
            })
          : undefined
      }
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center rounded-md px-2 text-start hover:bg-sidebar-row-hover hover:text-foreground",
        props.columns
          ? cn(
              "fork-sidebar-agent gap-2 text-2xs text-foreground/85",
              PROJECTS_WORK_ROW_HEIGHT,
              !active && !selected && "opacity-70 hover:opacity-100 focus-visible:opacity-100",
            )
          : "gap-1.5 py-0.5 text-xs text-muted-foreground",
        selected && "bg-sidebar-row-selected",
        active && "bg-sidebar-row-active text-sidebar-foreground",
      )}
      onClick={(event) => props.onClick(event, thread)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(thread, { x: event.clientX, y: event.clientY });
      }}
    >
      {props.columns ? (
        <SidebarIdleWorkerColumns
          thread={thread}
          provider={provider}
          status={status}
          workerLabel={workerLabel}
        />
      ) : (
        <>
          <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
          <ThreadRoleIcon thread={thread.source} />
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          {workerLabel === undefined ? (
            status !== "ready" ? (
              <ThreadStatusMark status={status} />
            ) : null
          ) : workerLabel === null ? null : (
            <span className="shrink-0">{workerLabel}</span>
          )}
        </>
      )}
    </button>
  );
  return props.columns ? (
    <SidebarProjectThreadTooltip thread={thread} provider={provider} render={button} />
  ) : (
    button
  );
}

function SidebarIdleWorkerColumns(
  props: Pick<
    ComponentProps<typeof SidebarChildThreadColumns>,
    "thread" | "provider" | "status" | "workerLabel"
  >,
) {
  const shortModelNames = useClientSettings((settings) => settings.shortModelNames);
  const locationStyle = useClientSettings((settings) => settings.sidebarLocationIconStyle);
  return (
    <SidebarChildThreadColumns
      {...props}
      shortModelNames={shortModelNames}
      location={
        <ThreadLocationIcon thread={props.thread} tooltip={false} worktreeStyle={locationStyle} />
      }
    />
  );
}

function revealWorker(row: HTMLButtonElement | null) {
  if (row?.getClientRects().length && !row.matches(":hover")) {
    row.scrollIntoView({ block: "nearest" });
  }
}
