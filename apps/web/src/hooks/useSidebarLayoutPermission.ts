import type { EnvironmentId } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "../state/environments";
import { sectionTarget } from "../projectSectionPlacement";
/** A layout can be edited locally even when its environment cannot accept settings writes. */
export function useSidebarLayoutPermission(
  sectionId: string | null = null,
  environmentId?: EnvironmentId,
) {
  const primary = usePrimaryEnvironmentId();
  const destination = environmentId ?? sectionTarget(sectionId)?.[0] ?? primary;
  return destination !== null;
}
