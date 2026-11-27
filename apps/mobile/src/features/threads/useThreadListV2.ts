import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { indexSidebarChildren } from "@t3tools/client-runtime/state/sidebar-families";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";
import type { ProjectThreadLayouts } from "@t3tools/client-runtime/state/thread-sort";

import { keepMarked } from "../../i18n/messages";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  threadListV2LayoutTime,
} from "./threadListV2";
import {
  sortHomeProjectScopes,
  type HomeProjectScope,
  type HomeProjectSortOrder,
} from "../home/homeThreadList";
import { computeThreadMoveAvailability } from "./threadOrder";

/**
 * Screens' select handlers read the content-only key set; a fresh one per list rebuild gave
 * every row a new handler whenever any thread shell changed. Keyed by a string, the set keeps
 * its identity until its keys change.
 */
function useKeySet(newlineSeparatedKeys: string): ReadonlySet<string> {
  return useMemo(
    () => new Set(newlineSeparatedKeys.length === 0 ? [] : newlineSeparatedKeys.split("\n")),
    [newlineSeparatedKeys],
  );
}

const expandedSidebarRowsAtom = Atom.make<ReadonlyMap<string, boolean>>(new Map()).pipe(
  Atom.keepAlive,
);

type LayoutInput = Parameters<typeof buildThreadListV2Items>[0];

/**
 * Shelf callbacks prevent compiler caching across the whole derivation, so each stage keeps
 * its own memo boundary to preserve the list's identity during unrelated navigation renders.
 */
export function useThreadListV2(input: {
  readonly threads: LayoutInput["threads"];
  readonly agentThreads: LayoutInput["threads"];
  readonly projects: readonly HomeProjectScope[];
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly projectLayouts: ProjectThreadLayouts;
  readonly openThreadKey: string | null;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly searchQuery: string;
  /** Threads that match the search by content, keyed like `threadSearchMatchKey`. */
  readonly searchMatches: ReadonlyMap<string, unknown>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly pinReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly settledLimit: number;
  readonly now: string;
  readonly pendingOrder: LayoutInput["pendingOrder"];
  readonly selectedThreadKey: string | null;
}) {
  const { threads } = input;
  const [expanded, setExpanded] = useAtom(expandedSidebarRowsAtom);
  const children = useMemo(() => indexSidebarChildren(input.agentThreads), [input.agentThreads]);
  const projects = useMemo(() => {
    const projectKeys =
      input.projectRefs == null
        ? null
        : new Set(
            input.projectRefs.map(({ environmentId, projectId }) =>
              scopedProjectKey(environmentId, projectId),
            ),
          );
    const scopes = input.projects.filter(
      (project) =>
        projectKeys === null ||
        project.projectRefs.some(({ environmentId, projectId }) =>
          projectKeys.has(scopedProjectKey(environmentId, projectId)),
        ),
    );
    return [
      ...sortHomeProjectScopes({
        scopes,
        threads,
        pendingTasks: input.pendingTasks,
        projectSortOrder: input.projectSortOrder,
      }),
    ].sort(
      (a, b) => Number(a.archived) - Number(b.archived) || Number(b.pinned) - Number(a.pinned),
    );
  }, [input.projectRefs, input.projects, input.pendingTasks, input.projectSortOrder, threads]);
  const layoutTime = useMemo(
    () => threadListV2LayoutTime({ threads, now: input.now, searchQuery: input.searchQuery }),
    [threads, input.now, input.searchQuery],
  );
  const moveAvailability = useMemo(
    () =>
      computeThreadMoveAvailability({
        allThreads: threads,
        section: "pinned",
        pendingOrder: input.pendingOrder,
        reorderableEnvironmentIds: input.pinReorderEnvironmentIds,
        ordered: getThreadListV2OrderedSection({
          threads,
          section: "pinned",
          pendingOrder: input.pendingOrder,
          now: layoutTime,
          settlementEnvironmentIds: input.settlementEnvironmentIds,
          snoozeEnvironmentIds: input.snoozeEnvironmentIds,
          queuedThreadKeys: input.queuedThreadKeys,
        }),
      }),
    [
      threads,
      input.pendingOrder,
      input.pinReorderEnvironmentIds,
      layoutTime,
      input.settlementEnvironmentIds,
      input.snoozeEnvironmentIds,
      input.queuedThreadKeys,
    ],
  );
  // Older settled threads load in pages; the shelf lists them only as far as they are loaded.
  const scopes = useMemo(
    () =>
      olderSettledScopes({
        environmentId: input.environmentId,
        projectRefs: input.projectRefs,
        settlementEnvironmentIds: input.settlementEnvironmentIds,
      }),
    [input.environmentId, input.projectRefs, input.settlementEnvironmentIds],
  );
  const olderSettledShelf = useOlderSettledShelf({
    scopes,
    expanded: true,
    // A search lists only matches, so the shelf would page forever; loaded pages stay.
    visibleCount: input.searchQuery.trim().length === 0 ? input.settledLimit : 0,
  });
  const { isListed, unloadedCount } = olderSettledShelf;
  const layout = useMemo(
    () =>
      buildThreadListV2Items({
        pendingOrder: input.pendingOrder,
        threads: threads.filter((thread) => thread.archivedAt === null),
        environmentId: input.environmentId,
        projectRefs: input.projectRefs,
        searchQuery: input.searchQuery,
        matchedThreadKeys: new Set(input.searchMatches.keys()),
        settlementEnvironmentIds: input.settlementEnvironmentIds,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
        now: layoutTime,
        snoozedShelfExpanded: true,
        settledShelfExpanded: true,
        selectedThreadKey: input.selectedThreadKey,
        isListedSettled: isListed,
        unloadedSettledCount: unloadedCount(
          threads.filter(
            (thread) =>
              thread.archivedAt === null &&
              scopes.some(
                (scope) =>
                  scope.environmentId === thread.environmentId &&
                  (scope.projectIds === null || scope.projectIds.includes(thread.projectId)),
              ),
          ),
        ),
      }),
    [
      input.pendingOrder,
      threads,
      input.environmentId,
      input.projectRefs,
      input.searchQuery,
      input.searchMatches,
      input.settlementEnvironmentIds,
      input.snoozeEnvironmentIds,
      input.queuedThreadKeys,
      layoutTime,
      input.selectedThreadKey,
      isListed,
      unloadedCount,
      scopes,
    ],
  );
  useOlderSettledShelfGrowth(olderSettledShelf, layout.listedSettledThreads);
  const contentOnlyThreadKeys = useKeySet([...layout.contentOnlyThreadKeys].sort().join("\n"));
  const pendingTasks = useMemo(() => {
    const scopedProjectKeys =
      input.projectRefs == null
        ? null
        : new Set(
            input.projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)),
          );
    const searchQuery = input.searchQuery.trim().toLocaleLowerCase();
    return input.pendingTasks.filter(
      (pendingTask) =>
        (input.environmentId === null || pendingTask.environmentId === input.environmentId) &&
        (scopedProjectKeys === null ||
          scopedProjectKeys.has(
            scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
          )) &&
        (searchQuery.length === 0 || pendingTask.title.toLocaleLowerCase().includes(searchQuery)),
    );
  }, [input.projectRefs, input.searchQuery, input.pendingTasks, input.environmentId]);
  const items = useMemo(
    () =>
      buildThreadListV2ListItems({
        items: layout.items,
        ...(input.searchQuery.trim() === ""
          ? {
              folders: {
                children,
                projects,
                layouts: input.projectLayouts,
                expanded,
                scoped: input.projectRefs != null,
                routeKey: input.openThreadKey ?? input.selectedThreadKey,
                now: input.now,
              },
            }
          : {}),
        pendingTasks,
        snoozeLabelNow: `${input.now.slice(0, 16)}:00.000Z`,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
        moveAvailability,
        resolve: keepMarked,
      }),
    [
      layout,
      children,
      projects,
      input.projectLayouts,
      expanded,
      input.projectRefs,
      input.openThreadKey,
      input.selectedThreadKey,
      input.searchQuery,
      pendingTasks,
      input.now,
      input.snoozeEnvironmentIds,
      input.queuedThreadKeys,
      moveAvailability,
    ],
  );
  const toggleSidebarRow = useCallback(
    (key: string, expanded: boolean) =>
      setExpanded((current) => new Map(current).set(key, !expanded)),
    [setExpanded],
  );
  const selectedRowKey = items.some((row) => row.key === `v2-thread:${input.openThreadKey}`)
    ? input.openThreadKey
    : input.selectedThreadKey;
  return {
    layout,
    items,
    contentOnlyThreadKeys,
    olderSettledShelf,
    selectedRowKey,
    toggleSidebarRow,
  };
}

/** The list's scope per environment: its projects there, or every project. */
function olderSettledScopes(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<OlderSettledScope> {
  const environmentIds =
    input.environmentId === null ? [...input.settlementEnvironmentIds] : [input.environmentId];
  return environmentIds.flatMap((environmentId): ReadonlyArray<OlderSettledScope> => {
    if (input.projectRefs == null) return [{ environmentId, projectIds: null }];
    const projectIds = input.projectRefs.flatMap((ref) =>
      ref.environmentId === environmentId ? [ref.projectId] : [],
    );
    return projectIds.length === 0 ? [] : [{ environmentId, projectIds }];
  });
}
