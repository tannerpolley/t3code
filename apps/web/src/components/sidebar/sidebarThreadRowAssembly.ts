import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";
import type { SidebarProviderEntry, SidebarThreadRowProps } from "./SidebarThreadRow";

/**
 * What every sidebar thread row shares, Activity's and Projects': stable handlers and lookups.
 * Projects passes it to rows several components down, so each field must keep its identity
 * until its own data changes.
 */
export type SidebarThreadRowAssembly = Pick<
  SidebarThreadRowProps,
  | "onThreadClick"
  | "onThreadActivate"
  | "onStartRename"
  | "onRenameTitleChange"
  | "onCommitRename"
  | "onCancelRename"
  | "onContextMenu"
  | "onSettle"
  | "onActionSweepStart"
  | "onUnsettle"
  | "onSnooze"
  | "onUnsnooze"
  | "onUnpin"
  | "onAcknowledgeWoke"
  | "onFileDropThreads"
  | "readOpensPullRequestsInRightPanel"
  | "timestampFormat"
  | "currentEnvironmentId"
> & {
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly environmentMachineById: ReadonlyMap<string, EnvironmentMachineKind>;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly projectDisplayNameByKey: ReadonlyMap<string, string>;
  readonly logicalProjectKeyByScopedProjectRef: ReadonlyMap<string, string>;
  readonly providerEntriesByEnvironment: ReadonlyMap<
    string,
    ReadonlyMap<string, SidebarProviderEntry>
  >;
  /** Environments whose config has loaded, which can settle, snooze and pin. */
  readonly serverConfigs: ReadonlyMap<EnvironmentId, unknown>;
  readonly scratchMachineLabelFor: (
    thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">,
  ) => string | null;
};

/** The route and rename state rows read; each row compares only its own part. */
export type SidebarThreadRowState = {
  /** The row that shows the open thread: the thread itself or its listed ancestor. */
  readonly activeKey: string | null;
  readonly routeKey: string | null;
  readonly revealActiveRow: NonNullable<SidebarThreadRowProps["revealRef"]>;
  readonly renamingKey: string | null;
  readonly renamingTitle: string;
  /** Each sidebar render's clock; rows compare only the wake time it gives them. */
  readonly snoozeNow: string;
};

const NO_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();

export function sameSidebarThreadRowState(
  thread: SidebarThreadSummary,
  previous: SidebarThreadRowState,
  next: SidebarThreadRowState,
): boolean {
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const active = next.activeKey === threadKey;
  const renaming = next.renamingKey === threadKey;
  return (
    (previous.activeKey === threadKey) === active &&
    (previous.routeKey === threadKey) === (next.routeKey === threadKey) &&
    (previous.renamingKey === threadKey) === renaming &&
    (!renaming || previous.renamingTitle === next.renamingTitle) &&
    (!active || previous.revealActiveRow === next.revealActiveRow) &&
    threadWokeAt(thread, { now: previous.snoozeNow }) ===
      threadWokeAt(thread, { now: next.snoozeNow })
  );
}

/** The props every thread row takes from the shared assembly; views add their own. */
export function sidebarThreadRowProps(
  assembly: SidebarThreadRowAssembly,
  state: SidebarThreadRowState,
  thread: SidebarThreadSummary,
  childThreads: readonly SidebarThreadSummary[],
) {
  const {
    environmentLabelById,
    environmentMachineById,
    projectByKey,
    projectDisplayNameByKey,
    logicalProjectKeyByScopedProjectRef,
    providerEntriesByEnvironment,
    serverConfigs,
    scratchMachineLabelFor,
    ...shared
  } = assembly;
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const projectRef = `${thread.environmentId}:${thread.projectId}`;
  const supported = serverConfigs.has(thread.environmentId);
  const isActive = state.activeKey === threadKey;
  const isRenaming = state.renamingKey === threadKey;
  return {
    ...shared,
    thread,
    childThreads,
    projectKey: logicalProjectKeyByScopedProjectRef.get(projectRef) ?? null,
    settlementSupported: supported,
    snoozeSupported: supported,
    pinningSupported: supported,
    isPinned: thread.pinnedAt != null,
    wokeAt: threadWokeAt(thread, { now: state.snoozeNow }),
    isActive,
    revealRef: isActive ? state.revealActiveRow : undefined,
    isRouteThread: state.routeKey === threadKey,
    environmentLabel: environmentLabelById.get(thread.environmentId) ?? null,
    environmentMachine: environmentMachineById.get(thread.environmentId) ?? "server",
    scratchMachineLabel: scratchMachineLabelFor(thread),
    project: projectByKey.get(projectRef) ?? null,
    projectDisplayName: projectDisplayNameByKey.get(projectRef) ?? null,
    providerEntryByInstanceId:
      providerEntriesByEnvironment.get(thread.environmentId) ?? NO_PROVIDER_ENTRIES,
    isRenaming,
    renamingTitle: isRenaming ? state.renamingTitle : "",
  } satisfies Partial<SidebarThreadRowProps>;
}
