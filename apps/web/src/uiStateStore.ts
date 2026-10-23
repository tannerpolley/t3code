export {
  setSidebarOtherProjectsExpanded,
  addSidebarProjectSection,
  renameSidebarProjectSection,
  setSidebarProjectSectionColor,
  setSidebarProjectSectionFolderIcons,
  deleteSidebarProjectSection,
  setSidebarProjectSectionExpanded,
  moveProjectToSidebarProjectSection,
  reorderSidebarProjectSectionProjects,
  reorderSidebarProjectSections,
  setProjectExpanded,
  reorderProjects,
} from "@t3tools/shared/sidebarLayout";
import { EnvironmentId, SidebarLayout, type SidebarLayoutMutation } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Debouncer } from "@tanstack/react-pacer";
import { ProjectIconColor, type PullRequestMergeMethod } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";
import { randomUUID } from "./lib/utils";
import { type FolderOrganizedProject } from "./sidebarSectionFolders";

export const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
const THREAD_CHANGED_FILES_EXPANSION_VERSION = 2;
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

export type SidebarProjectSection = Omit<
  import("@t3tools/contracts").SidebarProjectSection,
  "projectKeys"
> & { projectKeys: string[] };

const isProjectIconColor = Schema.is(ProjectIconColor);
export type SidebarMode = "projects" | "activity";
export type BranchPickerGroup = "current" | "local" | "remote";
const BRANCH_PICKER_GROUPS: readonly BranchPickerGroup[] = ["current", "local", "remote"];

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
  lineageDetailsExpandedById?: Record<string, boolean>;
  lineageAgentsClearedAtById?: Record<string, string>;
  issueMilestoneCollapsedById?: Record<string, boolean>;
  branchPickerCollapsedGroups?: string[];
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
  sidebarProjectSections: SidebarProjectSection[];
  sidebarOtherProjectsExpanded: boolean;
  sidebarMode: SidebarMode;

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
  /**
   * Issue sections collapsed by hand across issue surfaces, keyed by repository and section.
   * Groups without an entry default expanded.
   */
  issueMilestoneCollapsedById: Record<string, boolean>;
}

export interface UiLineageState {
  lineageDetailsExpandedById: Record<string, boolean>;
  lineageAgentsClearedAtById: Record<string, string>;
}

export interface UiBranchPickerState {
  branchPickerCollapsedGroups: BranchPickerGroup[];
}

export interface UiState
  extends
    UiProjectState,
    UiThreadState,
    UiEndpointState,
    UiPullRequestState,
    UiLineageState,
    UiBranchPickerState {}

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
  issueMilestoneCollapsedById: {},
  lineageDetailsExpandedById: {},
  lineageAgentsClearedAtById: {},
  branchPickerCollapsedGroups: [],
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

const MAX_SIDEBAR_PROJECT_SECTION_NAME_LENGTH = 80;

function normalizeSidebarProjectSectionName(name: string): string {
  return name.trim().slice(0, MAX_SIDEBAR_PROJECT_SECTION_NAME_LENGTH);
}

function sanitizeSidebarProjectSections(value: unknown): SidebarProjectSection[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const claimedProjectKeys = new Set<string>();
  const sections: SidebarProjectSection[] = value.flatMap((entry) => {
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
    return [
      {
        id,
        name,
        projectKeys,
        collapsed: candidate.collapsed === true,
        ...(isProjectIconColor(candidate.color) ? { color: candidate.color } : {}),
        ...(typeof candidate.parentId === "string" && candidate.parentId.length > 0
          ? { parentId: candidate.parentId }
          : {}),
        ...(candidate.folderIcons === true ? { folderIcons: true } : {}),
        ...(typeof candidate.folderPath === "string" && candidate.folderPath.trim()
          ? { folderPath: candidate.folderPath.trim() }
          : {}),
        ...(Array.isArray(candidate.childOrder)
          ? { childOrder: sanitizeStringArray(candidate.childOrder) }
          : {}),
      },
    ];
  });
  const topLevelIds = new Set(
    sections.filter((section) => !section.parentId).map((section) => section.id),
  );
  return sections.map((section) => {
    if (section.parentId === undefined || topLevelIds.has(section.parentId)) return section;
    const { parentId: _orphaned, ...rest } = section;
    return rest;
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

function sanitizeLineageAgentsClearedAtRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        (entry[1] === "show-all" || Number.isFinite(Date.parse(entry[1]))),
    ),
  );
}

function isPullRequestMergeMethod(value: unknown): value is PullRequestMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}

function isSidebarMode(value: unknown): value is SidebarMode {
  return value === "projects" || value === "activity";
}

function sanitizeBranchPickerCollapsedGroups(value: unknown): BranchPickerGroup[] {
  return Array.isArray(value)
    ? BRANCH_PICKER_GROUPS.filter((group) => value.includes(group))
    : initialState.branchPickerCollapsedGroups;
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
    lineageDetailsExpandedById: sanitizeBooleanRecord(parsed.lineageDetailsExpandedById),
    lineageAgentsClearedAtById: sanitizeLineageAgentsClearedAtRecord(
      parsed.lineageAgentsClearedAtById,
    ),
    issueMilestoneCollapsedById: sanitizeBooleanRecord(parsed.issueMilestoneCollapsedById),
    branchPickerCollapsedGroups: sanitizeBranchPickerCollapsedGroups(
      parsed.branchPickerCollapsedGroups,
    ),
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
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectExpandedById: legacySidebarLayout.projectExpandedById,
        projectOrder: legacySidebarLayout.projectOrder,
        sidebarProjectSections: legacySidebarLayout.sidebarProjectSections,
        sidebarOtherProjectsExpanded: legacySidebarLayout.sidebarOtherProjectsExpanded,
        sidebarMode: state.sidebarMode,
        threadLastVisitedAtById: state.threadLastVisitedAtById,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        sidebarProjectScopeKey: state.sidebarProjectScopeKey,
        threadChangedFilesExpansionVersion: THREAD_CHANGED_FILES_EXPANSION_VERSION,
        threadChangedFilesExpandedById: state.threadChangedFilesExpandedById,
        pullRequestMergeMethod: state.pullRequestMergeMethod,
        lineageDetailsExpandedById: state.lineageDetailsExpandedById,
        lineageAgentsClearedAtById: state.lineageAgentsClearedAtById,
        issueMilestoneCollapsedById: state.issueMilestoneCollapsedById,
        branchPickerCollapsedGroups: state.branchPickerCollapsedGroups,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {}
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

function setThreadChangedFilesExpanded(
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

function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

function setSidebarProjectScopeKey(state: UiState, projectKey: string | null): UiState {
  const nextKey = sanitizeOptionalKey(projectKey);
  if (state.sidebarProjectScopeKey === nextKey) {
    return state;
  }
  return {
    ...state,
    sidebarProjectScopeKey: nextKey,
  };
}

export function setSidebarMode(state: UiState, mode: SidebarMode): UiState {
  return state.sidebarMode === mode ? state : { ...state, sidebarMode: mode };
}

export function setLineageDetailsExpanded(
  state: UiState,
  keys: readonly string[],
  expanded: boolean,
): UiState {
  const changed = keys.filter((key) => state.lineageDetailsExpandedById[key] !== expanded);
  if (changed.length === 0) return state;
  const lineageDetailsExpandedById = { ...state.lineageDetailsExpandedById };
  for (const key of changed) lineageDetailsExpandedById[key] = expanded;
  return { ...state, lineageDetailsExpandedById };
}

export function setLineageAgentsClearedAt(
  state: UiState,
  key: string,
  clearedAt: string | null,
): UiState {
  if ((state.lineageAgentsClearedAtById[key] ?? null) === clearedAt) return state;
  const { [key]: _previous, ...lineageAgentsClearedAtById } = state.lineageAgentsClearedAtById;
  if (clearedAt !== null) lineageAgentsClearedAtById[key] = clearedAt;
  return { ...state, lineageAgentsClearedAtById };
}

/** Collapses or expands one issue section by hand; other sections keep their default. */
export function setIssueMilestoneCollapsed(
  state: UiState,
  key: string,
  collapsed: boolean,
): UiState {
  // An explicit false must override a legacy collapsed milestone.
  if (state.issueMilestoneCollapsedById[key] === collapsed) return state;
  return {
    ...state,
    issueMilestoneCollapsedById: { ...state.issueMilestoneCollapsedById, [key]: collapsed },
  };
}

function setPullRequestMergeMethod(state: UiState, method: PullRequestMergeMethod): UiState {
  return state.pullRequestMergeMethod === method
    ? state
    : { ...state, pullRequestMergeMethod: method };
}

export function setBranchPickerGroupCollapsed(
  state: UiState,
  group: BranchPickerGroup,
  collapsed: boolean,
): UiState {
  if (state.branchPickerCollapsedGroups.includes(group) === collapsed) return state;
  return {
    ...state,
    branchPickerCollapsedGroups: BRANCH_PICKER_GROUPS.filter((candidate) =>
      candidate === group ? collapsed : state.branchPickerCollapsedGroups.includes(candidate),
    ),
  };
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

let sidebarMutationSender: (mutation: SidebarLayoutMutation) => Promise<boolean> = async () =>
  false;
const sendSidebarMutation: typeof sidebarMutationSender = (mutation) =>
  useUiStateStore.getState().sidebarDisplaySnapshot === null
    ? sidebarMutationSender(mutation)
    : Promise.resolve(false);
export function configureSidebarLayoutActions(send: typeof sendSidebarMutation): void {
  sidebarMutationSender = send;
}
export let legacySidebarLayout = readPersistedState();
export function clearLegacySidebarLayout() {
  legacySidebarLayout = {
    ...legacySidebarLayout,
    sidebarProjectSections: [],
    projectExpandedById: {},
    projectOrder: [],
    sidebarOtherProjectsExpanded: true,
  };
  persistState(useUiStateStore.getState());
}

export const SIDEBAR_DISPLAY_KEY = "t3code:sidebar-display:v1";
export const SIDEBAR_DISPLAY_LIFETIME = 15_000;
const decodeSidebarDisplay = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ environmentIds: Schema.Array(EnvironmentId), layout: SidebarLayout }),
  ),
);
function readSidebarDisplay() {
  try {
    const saved = window.localStorage.getItem(SIDEBAR_DISPLAY_KEY);
    const display = saved === null ? null : Option.getOrNull(decodeSidebarDisplay(saved));
    return display === null
      ? null
      : {
          ...display,
          layout: {
            ...display.layout,
            projectOrder: [...display.layout.projectOrder],
            sidebarProjectSections: display.layout.sidebarProjectSections.map((section) => ({
              ...section,
              projectKeys: [...section.projectKeys],
            })),
          },
        };
  } catch {
    return null;
  }
}
const startupDisplay = readSidebarDisplay();
let savedSidebarDisplay: string | null = null;

/** Only the UI store owns the display snapshot; it never becomes sync or import input. */
export function applySidebarLayoutProjection(
  projected: Pick<
    UiState,
    | "sidebarProjectSections"
    | "projectExpandedById"
    | "projectOrder"
    | "sidebarOtherProjectsExpanded"
  >,
  environmentIds: readonly EnvironmentId[] | null,
  complete: boolean,
) {
  const current = useUiStateStore.getState();
  const display = current.sidebarDisplaySnapshot;
  const ids = environmentIds === null ? null : [...environmentIds].sort();
  if (
    display !== null &&
    !complete &&
    display.expiresAt > Date.now() &&
    (ids === null || JSON.stringify(ids) === JSON.stringify(display.environmentIds))
  )
    return;
  try {
    if (complete && ids !== null) {
      const saved = JSON.stringify({ environmentIds: ids, layout: projected });
      if (savedSidebarDisplay !== saved) {
        window.localStorage.setItem(SIDEBAR_DISPLAY_KEY, saved);
        savedSidebarDisplay = saved;
      }
    } else if (display !== null) {
      window.localStorage.removeItem(SIDEBAR_DISPLAY_KEY);
      savedSidebarDisplay = null;
    }
  } catch {
    /* Storage may be unavailable. */
  }
  if (
    display !== null ||
    JSON.stringify(projected) !==
      JSON.stringify({
        sidebarProjectSections: current.sidebarProjectSections,
        projectExpandedById: current.projectExpandedById,
        projectOrder: current.projectOrder,
        sidebarOtherProjectsExpanded: current.sidebarOtherProjectsExpanded,
      })
  )
    useUiStateStore.setState({ ...projected, sidebarDisplaySnapshot: null });
}

interface UiStateStore extends UiState {
  /** Memory only: row remounts retain choices without accumulating stored thread keys. */
  sidebarWorkExpandedById: Record<string, boolean>;
  setSidebarWorkExpanded: (key: string, expanded: boolean) => void;
  sidebarDisplaySnapshot: { environmentIds: readonly EnvironmentId[]; expiresAt: number } | null;
  markThreadVisited: (threadId: string, visitedAt: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  setSidebarProjectScopeKey: (projectKey: string | null) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  setSidebarOtherProjectsExpanded: (expanded: boolean) => void;
  addSidebarProjectSection: (
    name: string,
    parentId?: string,
    folderPath?: string,
  ) => Promise<boolean>;
  organizeSidebarSectionsByFolder: (
    projects: readonly FolderOrganizedProject[],
    root: string,
    onlyUnsorted?: boolean,
  ) => Promise<boolean>;
  renameSidebarProjectSection: (sectionId: string, name: string) => void;
  setSidebarProjectSectionColor: (sectionId: string, color: ProjectIconColor | null) => void;
  setSidebarProjectSectionFolderIcons: (sectionId: string, folderIcons: boolean) => void;
  deleteSidebarProjectSection: (sectionId: string) => void;
  setSidebarProjectSectionExpanded: (sectionId: string, expanded: boolean) => void;
  moveProjectToSidebarProjectSection: (projectKey: string, sectionId: string | null) => void;
  reorderSidebarProjectSectionProjects: (sectionId: string, projectKeys: readonly string[]) => void;
  reorderSidebarSectionChildren: (sectionId: string, childOrder: readonly string[]) => void;
  reorderSidebarProjectSections: (sectionIds: readonly string[]) => void;
  setLineageDetailsExpanded: (keys: readonly string[], expanded: boolean) => void;
  setLineageAgentsClearedAt: (key: string, clearedAt: string | null) => void;
  setIssueMilestoneCollapsed: (key: string, collapsed: boolean) => void;
  setPullRequestMergeMethod: (method: PullRequestMergeMethod) => void;
  setBranchPickerGroupCollapsed: (group: BranchPickerGroup, collapsed: boolean) => void;
  setProjectExpanded: (projectIds: string | readonly string[], expanded: boolean) => void;
  reorderProjects: (
    currentProjectOrder: readonly string[],
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  ...startupDisplay?.layout,
  sidebarWorkExpandedById: {},
  setSidebarWorkExpanded: (key, expanded) =>
    set((state) => {
      const choices = Object.entries(state.sidebarWorkExpandedById).filter(([id]) => id !== key);
      // Keep the most recent 2,000 choices; abandoned threads cannot grow this session forever.
      return {
        sidebarWorkExpandedById: Object.fromEntries([...choices.slice(-1999), [key, expanded]]),
      };
    }),
  sidebarDisplaySnapshot:
    startupDisplay === null
      ? null
      : {
          environmentIds: startupDisplay.environmentIds,
          expiresAt: Date.now() + SIDEBAR_DISPLAY_LIFETIME,
        },
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
    sendSidebarMutation({ type: "otherExpanded", expanded }),
  addSidebarProjectSection: (name, parentId, folderPath) =>
    sendSidebarMutation({
      type: "add",
      section: {
        id: randomUUID(),
        name: name.trim().slice(0, 80),
        ...(parentId === undefined ? {} : { parentId }),
        ...(folderPath === undefined ? {} : { folderPath }),
      },
    }),
  organizeSidebarSectionsByFolder: (projects, root, onlyUnsorted = false) =>
    sendSidebarMutation({ type: "organize", projects, root, onlyUnsorted }),
  renameSidebarProjectSection: (sectionId, name) =>
    sendSidebarMutation({ type: "rename", sectionId, name: name.trim().slice(0, 80) }),
  setSidebarProjectSectionColor: (sectionId, color) =>
    sendSidebarMutation({ type: "color", sectionId, color }),
  setSidebarProjectSectionFolderIcons: (sectionId, folderIcons) =>
    sendSidebarMutation({ type: "folderIcons", sectionId, folderIcons }),
  deleteSidebarProjectSection: (sectionId) => sendSidebarMutation({ type: "delete", sectionId }),
  setSidebarProjectSectionExpanded: (sectionId, expanded) =>
    sendSidebarMutation({ type: "sectionExpanded", sectionId, expanded }),
  moveProjectToSidebarProjectSection: (projectKey, sectionId) =>
    sendSidebarMutation({ type: "move", projectKeys: [projectKey], sectionId }),
  reorderSidebarProjectSectionProjects: (sectionId, projectKeys) =>
    sendSidebarMutation({ type: "sectionProjectsOrder", sectionId, projectKeys }),
  reorderSidebarSectionChildren: (sectionId, childOrder) =>
    sendSidebarMutation({ type: "sectionChildrenOrder", sectionId, childOrder }),
  reorderSidebarProjectSections: (sectionIds) =>
    sendSidebarMutation({ type: "sectionsOrder", sectionIds }),
  setLineageDetailsExpanded: (keys, expanded) =>
    set((state) => setLineageDetailsExpanded(state, keys, expanded)),
  setLineageAgentsClearedAt: (key, clearedAt) =>
    set((state) => setLineageAgentsClearedAt(state, key, clearedAt)),
  setIssueMilestoneCollapsed: (key, collapsed) =>
    set((state) => setIssueMilestoneCollapsed(state, key, collapsed)),
  setPullRequestMergeMethod: (method) => set((state) => setPullRequestMergeMethod(state, method)),
  setBranchPickerGroupCollapsed: (group, collapsed) =>
    set((state) => setBranchPickerGroupCollapsed(state, group, collapsed)),
  setProjectExpanded: (projectIds, expanded) =>
    sendSidebarMutation({
      type: "projectExpanded",
      projectKeys: typeof projectIds === "string" ? [projectIds] : projectIds,
      expanded,
    }),
  reorderProjects: (currentProjectOrder, draggedProjectIds, targetProjectIds) =>
    sendSidebarMutation({
      type: "projectsOrder",
      currentProjectOrder,
      draggedProjectIds,
      targetProjectIds,
    }),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
