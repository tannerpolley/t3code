import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  arrayElementsEqual,
  parseThreadKey,
  threadKey,
} from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { CornerDownRightIcon } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";

import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSnapshotAtom } from "../../state/shell";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { environmentThreadShells, threadFamilies } from "../../state/threads";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { ThreadRoleIcon } from "../ThreadRoleIcon";
import { ThreadStatusMark } from "../ThreadStatusMark";
import { indexSidebarWorkers, sidebarWorkerPage, WORKER_PAGE_SIZE } from "./SidebarWorkers.logic";

const sidebarWorkers = Atom.map(environmentThreadShells.quietThreadShellsAtom, indexSidebarWorkers);
const omittedFamilies = Atom.family((environmentId: EnvironmentId) =>
  Atom.map(environmentSnapshotAtom(environmentId), (snapshot) => snapshot?.omittedWorkers),
);
const EMPTY: readonly SidebarThreadSummary[] = [];
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
const routePathFor = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.map(
    environmentThreadShells.environmentThreadIndexAtom(ref.environmentId),
    (threads): ReadonlySet<string> => {
      const path = new Set<string>();
      let id: typeof ref.threadId | null = ref.threadId;
      while (id !== null && !path.has(id)) {
        path.add(id);
        id = threads.get(id)?.lineage.parentThreadId ?? null;
      }
      return path;
    },
  ).pipe(
    Atom.withEquality<ReadonlySet<string>>(
      (a, b) => a.size === b.size && [...a].every((id) => b.has(id)),
    ),
  );
});
const NO_ROUTE_PATH = Atom.make<ReadonlySet<string>>(new Set<string>());

type WorkerRowsProps = {
  readonly thread: SidebarThreadSummary;
  readonly includeRunning?: boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>, ref: ScopedThreadRef) => void;
  readonly onContextMenu: (ref: ScopedThreadRef, position: { x: number; y: number }) => void;
};

/** Visible sidebar parents lease their family; the socket keeps the idle rows out of its snapshot. */
export function SidebarWorkerFamily(props: WorkerRowsProps) {
  const { environmentId, id, lineage } = props.thread;
  const omitted = useAtomValue(omittedFamilies(environmentId));
  const shouldRead = omitted?.some((entry) => entry.rootThreadId === lineage.rootThreadId) === true;
  const rootId = lineage.rootThreadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leases on-demand family rows in the shared shell while their sidebar parent is visible
  useEffect(() => {
    if (shouldRead) return threadFamilies.mount(appAtomRegistry, environmentId, rootId);
  }, [shouldRead, environmentId, rootId]);
  return <SidebarWorkerRows key={id} {...props} />;
}

export function SidebarWorkerRows(props: WorkerRowsProps) {
  const gt = useGT();
  const { environmentId, id } = props.thread;
  const key = scopedThreadKey(scopeThreadRef(environmentId, id));
  const { idle, running } = useAtomValue(childrenFor(key));
  const route = useThreadRouteRef();
  const routePath = useAtomValue(
    route?.environmentId === environmentId ? routePathFor(threadKey(route)) : NO_ROUTE_PATH,
  );
  const [limit, setLimit] = useState(WORKER_PAGE_SIZE);
  const workers = [
    ...(props.includeRunning ? running : EMPTY),
    ...sidebarWorkerPage(idle, limit, routePath),
  ];
  if (workers.length === 0) return null;
  return (
    <ul
      className="ms-3 border-s border-sidebar-border/60 ps-1"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {workers.map((worker) => (
        <li
          key={worker.id}
          data-thread-item={scopedThreadKey(scopeThreadRef(worker.environmentId, worker.id))}
          className="list-none"
        >
          <SidebarWorkerButton
            thread={worker}
            parent={key}
            active={route?.environmentId === environmentId && route.threadId === worker.id}
            onClick={props.onClick}
            onContextMenu={props.onContextMenu}
          />
          <SidebarWorkerRows {...props} thread={worker} />
        </li>
      ))}
      {idle.length > limit ? (
        <li className="list-none">
          <button
            type="button"
            className="w-full cursor-pointer rounded-md px-2 py-0.5 text-start text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
            onClick={() => setLimit((current) => current + WORKER_PAGE_SIZE)}
          >
            {gt("Show more workers ({count})", { count: idle.length - limit })}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function SidebarWorkerButton(
  props: Pick<WorkerRowsProps, "thread" | "onClick" | "onContextMenu"> & {
    readonly active: boolean;
    readonly parent: string;
  },
) {
  const { active, thread } = props;
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const key = scopedThreadKey(ref);
  const selected = useThreadSelectionStore((store) => store.selectedThreadKeys.has(key));
  const status = resolveSidebarThreadStatus(thread);
  return (
    <button
      type="button"
      ref={active ? revealWorker : undefined}
      data-sidebar-row={key}
      data-sidebar-parent={props.parent}
      aria-current={active || undefined}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-start text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
        selected && "bg-sidebar-row-selected",
        active && "bg-sidebar-row-active text-sidebar-foreground",
      )}
      onClick={(event) => props.onClick(event, ref)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(ref, { x: event.clientX, y: event.clientY });
      }}
    >
      <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
      <ThreadRoleIcon thread={thread.source} />
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      {status !== "ready" ? <ThreadStatusMark status={status} /> : null}
    </button>
  );
}

function revealWorker(row: HTMLButtonElement | null) {
  if (row?.getClientRects().length && !row.matches(":hover")) {
    row.scrollIntoView({ block: "nearest" });
  }
}
