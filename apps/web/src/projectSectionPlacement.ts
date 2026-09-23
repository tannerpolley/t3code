import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Projects added from a sidebar section's Add project join that section once they appear.
 *
 * A project's sidebar key can change after it is created (a clone gains its repository identity
 * when git finishes), so a placement stays until the project has an identity or the window ends.
 * ponytail: in-memory with a fixed window; a clone slower than this, or an app restart mid-clone,
 * lands in Other projects. Persist placements if that ever matters.
 */
const PLACEMENT_WINDOW_MS = 5 * 60_000;

export interface ProjectSectionPlacement {
  readonly sectionId: string;
  readonly expiresAt: number;
}

interface ProjectSectionPlacementState {
  /** Keyed by scoped project key: `environmentId:projectId`. */
  readonly placements: Readonly<Record<string, ProjectSectionPlacement>>;
  readonly resolve: (projectRefKey: string) => void;
}

export const useProjectSectionPlacements = create<ProjectSectionPlacementState>()((set) => ({
  placements: {},
  resolve: (projectRefKey) =>
    set((state) => {
      if (!(projectRefKey in state.placements)) return state;
      const { [projectRefKey]: _resolved, ...placements } = state.placements;
      return { placements };
    }),
}));

/** The section the add-project flow now open was started from; null for a plain add. */
let addProjectSectionId: string | null = null;

export function setAddProjectSection(sectionId: string | null): void {
  addProjectSectionId = sectionId;
}

/** Called once the add-project flow creates or picks a project. */
export function placeAddedProject(ref: ScopedProjectRef): void {
  const sectionId = addProjectSectionId;
  addProjectSectionId = null;
  if (sectionId === null) return;
  useProjectSectionPlacements.setState((state) => ({
    placements: {
      ...state.placements,
      [scopedProjectKey(ref)]: { sectionId, expiresAt: Date.now() + PLACEMENT_WINDOW_MS },
    },
  }));
}

/**
 * Which pending placements to apply now and which are finished. A placement moves its project
 * only while the project sits in no section, so a later manual move is never undone.
 */
export function resolveProjectPlacements(input: {
  readonly placements: Readonly<Record<string, ProjectSectionPlacement>>;
  readonly projects: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjectRefs: readonly ScopedProjectRef[];
    readonly repositoryIdentity?: unknown;
  }>;
  readonly sections: ReadonlyArray<{
    readonly id: string;
    readonly projectKeys: readonly string[];
  }>;
  readonly now: number;
}): { moves: Array<{ projectKey: string; sectionId: string }>; resolved: string[] } {
  const moves: Array<{ projectKey: string; sectionId: string }> = [];
  const resolved: string[] = [];
  for (const [refKey, placement] of Object.entries(input.placements)) {
    if (
      placement.expiresAt < input.now ||
      !input.sections.some((section) => section.id === placement.sectionId)
    ) {
      resolved.push(refKey);
      continue;
    }
    const project = input.projects.find((candidate) =>
      candidate.memberProjectRefs.some((ref) => scopedProjectKey(ref) === refKey),
    );
    if (project === undefined) continue;
    if (!input.sections.some((section) => section.projectKeys.includes(project.projectKey))) {
      moves.push({ projectKey: project.projectKey, sectionId: placement.sectionId });
    }
    if (project.repositoryIdentity != null) resolved.push(refKey);
  }
  return { moves, resolved };
}
