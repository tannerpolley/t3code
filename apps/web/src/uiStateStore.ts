import { Debouncer } from "@tanstack/react-pacer";
import type { PullRequestMergeMethod } from "@t3tools/contracts";
import { create } from "zustand";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";
import { randomUUID } from "./lib/utils";

export const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
// Version 1 stored card visibility, not folder expansion.
const THREAD_CHANGED_FILES_EXPANSION_VERSION = 2;
const MAX_SIDEBAR_PROJECT_SECTION_NAME_LENGTH = 80;
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v8",
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

export interface SidebarProjectSection {
  id: string;
  name: string;
  projectKeys: string[];
  collapsed: boolean;
}

export type SidebarMode = "projects" | "activity";

export interface PersistedUiState {
  projectExpandedById?: Record<string, boolean>;
  projectOrder?: string[];
  sidebarProjectSections?: SidebarProjectSection[];
  sidebarOtherProjectsExpanded?: boolean;
  sidebarMode?: SidebarMode;
  threadLastVisitedAtById?: Record<string, string>;
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  sidebarProjectScopeKey?: string | null;
  threadChangedFilesExpansionVersion?: number;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
  pullRequestMergeMethod?: string;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
  sidebarProjectSections: SidebarProjectSection[];
  sidebarOtherProjectsExpanded: boolean;
  sidebarMode: SidebarMode;
  // Logical project key the sidebar list is scoped to, or null for "all
  // projects". Lives here so routes that unmount the sidebar (Settings)
  // cannot reset the filter.
  sidebarProjectScopeKey: string | null;
}

export interface UiThreadState {
  threadLastVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export interface UiPullRequestState {
  pullRequestMergeMethod: PullRequestMergeMethod;
}

export interface UiState
  extends UiProjectState, UiThreadState, UiEndpointState, UiPullRequestState {}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  sidebarProjectSections: [],
  sidebarOtherProjectsExpanded: true,
  sidebarMode: "activity",
  sidebarProjectScopeKey: null,
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
  defaultAdvertisedEndpointKey: null,
  pullRequestMergeMethod: "merge",
};

const LEGACY_PROJECT_CWD_PREFERENCE_PREFIX = "legacy-project-cwd:";
const LEGACY_PROJECT_EXPANSION_DEFAULT_KEY = "legacy-project-expansion-default";
let legacyKeysCleanedUp = false;

export function legacyProjectCwdPreferenceKey(cwd: string): string {
  return `${LEGACY_PROJECT_CWD_PREFERENCE_PREFIX}${normalizeProjectPathForComparison(cwd)}`;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

function normalizeSidebarProjectSectionName(name: string): string {
  return name.trim().slice(0, MAX_SIDEBAR_PROJECT_SECTION_NAME_LENGTH);
}

function sanitizeSidebarProjectSections(value: unknown): SidebarProjectSection[] {
  if (!Array.isArray(value)) return [];

  const seenIds = new Set<string>();
  const claimedProjectKeys = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name =
      typeof candidate.name === "string" ? normalizeSidebarProjectSectionName(candidate.name) : "";
    if (!id || !name || seenIds.has(id)) return [];
    seenIds.add(id);
    const projectKeys = sanitizeStringArray(candidate.projectKeys).filter((key) => {
      if (claimedProjectKeys.has(key)) return false;
      claimedProjectKeys.add(key);
      return true;
    });
    return [{ id, name, projectKeys, collapsed: candidate.collapsed === true }];
  });
}

function sanitizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => entry[0].length > 0 && typeof entry[1] === "boolean",
    ),
  );
}

function sanitizeOptionalKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sanitizeTimestampRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].length > 0 &&
        Number.isFinite(Date.parse(entry[1])),
    ),
  );
}

function isPullRequestMergeMethod(value: unknown): value is PullRequestMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}

function isSidebarMode(value: unknown): value is SidebarMode {
  return value === "projects" || value === "activity";
}

export function parsePersistedState(parsed: PersistedUiState): UiState {
  const projectExpandedById =
    parsed.projectExpandedById === undefined
      ? (() => {
          const migrated: Record<string, boolean> = {};
          const collapsedProjectCwds = sanitizeStringArray(parsed.collapsedProjectCwds);
          const expandedProjectCwds = sanitizeStringArray(parsed.expandedProjectCwds);
          for (const cwd of collapsedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = false;
          }
          for (const cwd of expandedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = true;
          }
          if (!Array.isArray(parsed.collapsedProjectCwds) && expandedProjectCwds.length > 0) {
            migrated[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] = false;
          }
          return migrated;
        })()
      : sanitizeBooleanRecord(parsed.projectExpandedById);
  const projectOrder =
    parsed.projectOrder === undefined
      ? sanitizeStringArray(parsed.projectOrderCwds).map(legacyProjectCwdPreferenceKey)
      : sanitizeStringArray(parsed.projectOrder);
  const sidebarProjectSections = sanitizeSidebarProjectSections(parsed.sidebarProjectSections);

  return {
    projectExpandedById,
    projectOrder,
    sidebarProjectSections,
    sidebarOtherProjectsExpanded:
      typeof parsed.sidebarOtherProjectsExpanded === "boolean"
        ? parsed.sidebarOtherProjectsExpanded
        : initialState.sidebarOtherProjectsExpanded,
    sidebarMode: isSidebarMode(parsed.sidebarMode)
      ? parsed.sidebarMode
      : sidebarProjectSections.length > 0
        ? "projects"
        : initialState.sidebarMode,
    threadLastVisitedAtById: sanitizeTimestampRecord(parsed.threadLastVisitedAtById),
    threadChangedFilesExpandedById:
      parsed.threadChangedFilesExpansionVersion === THREAD_CHANGED_FILES_EXPANSION_VERSION
        ? sanitizePersistedThreadChangedFilesExpanded(parsed.threadChangedFilesExpandedById)
        : {},
    defaultAdvertisedEndpointKey: sanitizeOptionalKey(parsed.defaultAdvertisedEndpointKey),
    sidebarProjectScopeKey: sanitizeOptionalKey(parsed.sidebarProjectScopeKey),
    pullRequestMergeMethod: isPullRequestMergeMethod(parsed.pullRequestMergeMethod)
      ? parsed.pullRequestMergeMethod
      : initialState.pullRequestMergeMethod,
  };
}

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        return parsePersistedState(JSON.parse(legacyRaw) as PersistedUiState);
      }
      return initialState;
    }
    return parsePersistedState(JSON.parse(raw) as PersistedUiState);
  } catch {
    return initialState;
  }
}

function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean") {
        nextTurns[turnId] = expanded;
      }
    }

    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }

  return nextState;
}

export function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const projectExpandedById = Object.fromEntries(
      Object.entries(state.projectExpandedById).filter(
        ([key]) => key !== LEGACY_PROJECT_EXPANSION_DEFAULT_KEY,
      ),
    );
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectExpandedById,
        projectOrder: state.projectOrder,
        sidebarProjectSections: state.sidebarProjectSections,
        sidebarOtherProjectsExpanded: state.sidebarOtherProjectsExpanded,
        sidebarMode: state.sidebarMode,
        threadLastVisitedAtById: state.threadLastVisitedAtById,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        sidebarProjectScopeKey: state.sidebarProjectScopeKey,
        threadChangedFilesExpansionVersion: THREAD_CHANGED_FILES_EXPANSION_VERSION,
        threadChangedFilesExpandedById: state.threadChangedFilesExpandedById,
        pullRequestMergeMethod: state.pullRequestMergeMethod,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

export function markThreadVisited(state: UiState, threadId: string, visitedAt: string): UiState {
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) {
    return state;
  }
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: visitedAt,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: string,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: string,
  turnId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  if (currentThreadState[turnId] === expanded) {
    return state;
  }

  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: {
        ...currentThreadState,
        [turnId]: expanded,
      },
    },
  };
}

export function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

export function setSidebarProjectScopeKey(state: UiState, projectKey: string | null): UiState {
  const nextKey = sanitizeOptionalKey(projectKey);
  if (state.sidebarProjectScopeKey === nextKey) {
    return state;
  }
  return {
    ...state,
    sidebarProjectScopeKey: nextKey,
  };
}

export function setSidebarOtherProjectsExpanded(state: UiState, expanded: boolean): UiState {
  return state.sidebarOtherProjectsExpanded === expanded
    ? state
    : { ...state, sidebarOtherProjectsExpanded: expanded };
}

export function setSidebarMode(state: UiState, mode: SidebarMode): UiState {
  return state.sidebarMode === mode ? state : { ...state, sidebarMode: mode };
}

export function addSidebarProjectSection(
  state: UiState,
  section: Pick<SidebarProjectSection, "id" | "name">,
): UiState {
  const id = section.id.trim();
  const name = normalizeSidebarProjectSectionName(section.name);
  if (!id || !name || state.sidebarProjectSections.some((candidate) => candidate.id === id)) {
    return state;
  }
  return {
    ...state,
    sidebarProjectSections: [
      ...state.sidebarProjectSections,
      { id, name, projectKeys: [], collapsed: false },
    ],
  };
}

export function renameSidebarProjectSection(
  state: UiState,
  sectionId: string,
  name: string,
): UiState {
  const nextName = normalizeSidebarProjectSectionName(name);
  const section = state.sidebarProjectSections.find((candidate) => candidate.id === sectionId);
  if (!nextName || !section || section.name === nextName) return state;
  return {
    ...state,
    sidebarProjectSections: state.sidebarProjectSections.map((candidate) =>
      candidate.id === sectionId ? { ...candidate, name: nextName } : candidate,
    ),
  };
}

export function deleteSidebarProjectSection(state: UiState, sectionId: string): UiState {
  const sidebarProjectSections = state.sidebarProjectSections.filter(
    (section) => section.id !== sectionId,
  );
  return sidebarProjectSections.length === state.sidebarProjectSections.length
    ? state
    : { ...state, sidebarProjectSections };
}

export function setSidebarProjectSectionExpanded(
  state: UiState,
  sectionId: string,
  expanded: boolean,
): UiState {
  const section = state.sidebarProjectSections.find((candidate) => candidate.id === sectionId);
  if (!section || section.collapsed === !expanded) return state;
  return {
    ...state,
    sidebarProjectSections: state.sidebarProjectSections.map((candidate) =>
      candidate.id === sectionId ? { ...candidate, collapsed: !expanded } : candidate,
    ),
  };
}

export function moveProjectToSidebarProjectSection(
  state: UiState,
  projectKey: string,
  sectionId: string | null,
): UiState {
  const currentSection = state.sidebarProjectSections.find((section) =>
    section.projectKeys.includes(projectKey),
  );
  if (
    currentSection?.id === sectionId ||
    (sectionId !== null &&
      !state.sidebarProjectSections.some((section) => section.id === sectionId))
  ) {
    return state;
  }
  if (!currentSection && sectionId === null) return state;
  return {
    ...state,
    sidebarProjectSections: state.sidebarProjectSections.map((section) => ({
      ...section,
      projectKeys:
        section.id === sectionId
          ? [...section.projectKeys.filter((key) => key !== projectKey), projectKey]
          : section.projectKeys.filter((key) => key !== projectKey),
    })),
  };
}

export function reorderSidebarProjectSectionProjects(
  state: UiState,
  sectionId: string,
  projectKeys: readonly string[],
): UiState {
  const section = state.sidebarProjectSections.find((candidate) => candidate.id === sectionId);
  if (!section) return state;
  const requested = new Set(projectKeys);
  const allowed = new Set(section.projectKeys);
  const nextProjectKeys = [
    ...new Set(projectKeys.filter((key) => allowed.has(key))),
    ...section.projectKeys.filter((key) => !requested.has(key)),
  ];
  if (nextProjectKeys.every((key, index) => key === section.projectKeys[index])) return state;
  return {
    ...state,
    sidebarProjectSections: state.sidebarProjectSections.map((candidate) =>
      candidate.id === sectionId ? { ...candidate, projectKeys: nextProjectKeys } : candidate,
    ),
  };
}

export function reorderSidebarProjectSections(
  state: UiState,
  sectionIds: readonly string[],
): UiState {
  const requested = new Set(sectionIds);
  const byId = new Map(state.sidebarProjectSections.map((section) => [section.id, section]));
  const nextIds = [
    ...new Set(sectionIds.filter((id) => byId.has(id))),
    ...state.sidebarProjectSections.map((section) => section.id).filter((id) => !requested.has(id)),
  ];
  if (nextIds.every((id, index) => id === state.sidebarProjectSections[index]?.id)) return state;
  return { ...state, sidebarProjectSections: nextIds.map((id) => byId.get(id)!) };
}

function setPullRequestMergeMethod(state: UiState, method: PullRequestMergeMethod): UiState {
  return state.pullRequestMergeMethod === method
    ? state
    : { ...state, pullRequestMergeMethod: method };
}

export function resolveProjectExpanded(
  projectExpandedById: Readonly<Record<string, boolean>>,
  preferenceKeys: readonly string[],
): boolean {
  for (const key of preferenceKeys) {
    const expanded = projectExpandedById[key];
    if (expanded !== undefined) {
      return expanded;
    }
  }
  return projectExpandedById[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] ?? true;
}

export function setProjectExpanded(
  state: UiState,
  projectIds: string | readonly string[],
  expanded: boolean,
): UiState {
  const ids = typeof projectIds === "string" ? [projectIds] : projectIds;
  const nextEntries = ids.filter((projectId) => state.projectExpandedById[projectId] !== expanded);
  if (nextEntries.length === 0) {
    return state;
  }
  const projectExpandedById = { ...state.projectExpandedById };
  for (const projectId of nextEntries) {
    projectExpandedById[projectId] = expanded;
  }
  return {
    ...state,
    projectExpandedById,
  };
}

export function reorderProjects(
  state: UiState,
  currentProjectOrder: readonly string[],
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = currentProjectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...currentProjectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

interface UiStateStore extends UiState {
  markThreadVisited: (threadId: string, visitedAt: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  setSidebarProjectScopeKey: (projectKey: string | null) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  setSidebarOtherProjectsExpanded: (expanded: boolean) => void;
  addSidebarProjectSection: (name: string) => void;
  renameSidebarProjectSection: (sectionId: string, name: string) => void;
  deleteSidebarProjectSection: (sectionId: string) => void;
  setSidebarProjectSectionExpanded: (sectionId: string, expanded: boolean) => void;
  moveProjectToSidebarProjectSection: (projectKey: string, sectionId: string | null) => void;
  reorderSidebarProjectSectionProjects: (sectionId: string, projectKeys: readonly string[]) => void;
  reorderSidebarProjectSections: (sectionIds: readonly string[]) => void;
  setPullRequestMergeMethod: (method: PullRequestMergeMethod) => void;
  setProjectExpanded: (projectIds: string | readonly string[], expanded: boolean) => void;
  reorderProjects: (
    currentProjectOrder: readonly string[],
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded) =>
    set((state) => setThreadChangedFilesExpanded(state, threadId, turnId, expanded)),
  setDefaultAdvertisedEndpointKey: (key) =>
    set((state) => setDefaultAdvertisedEndpointKey(state, key)),
  setSidebarProjectScopeKey: (projectKey) =>
    set((state) => setSidebarProjectScopeKey(state, projectKey)),
  setSidebarMode: (mode) => set((state) => setSidebarMode(state, mode)),
  setSidebarOtherProjectsExpanded: (expanded) =>
    set((state) => setSidebarOtherProjectsExpanded(state, expanded)),
  addSidebarProjectSection: (name) =>
    set((state) => addSidebarProjectSection(state, { id: randomUUID(), name })),
  renameSidebarProjectSection: (sectionId, name) =>
    set((state) => renameSidebarProjectSection(state, sectionId, name)),
  deleteSidebarProjectSection: (sectionId) =>
    set((state) => deleteSidebarProjectSection(state, sectionId)),
  setSidebarProjectSectionExpanded: (sectionId, expanded) =>
    set((state) => setSidebarProjectSectionExpanded(state, sectionId, expanded)),
  moveProjectToSidebarProjectSection: (projectKey, sectionId) =>
    set((state) => moveProjectToSidebarProjectSection(state, projectKey, sectionId)),
  reorderSidebarProjectSectionProjects: (sectionId, projectKeys) =>
    set((state) => reorderSidebarProjectSectionProjects(state, sectionId, projectKeys)),
  reorderSidebarProjectSections: (sectionIds) =>
    set((state) => reorderSidebarProjectSections(state, sectionIds)),
  setPullRequestMergeMethod: (method) => set((state) => setPullRequestMergeMethod(state, method)),
  setProjectExpanded: (projectIds, expanded) =>
    set((state) => setProjectExpanded(state, projectIds, expanded)),
  reorderProjects: (currentProjectOrder, draggedProjectIds, targetProjectIds) =>
    set((state) =>
      reorderProjects(state, currentProjectOrder, draggedProjectIds, targetProjectIds),
    ),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
