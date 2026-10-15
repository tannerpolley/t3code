import type { EnvironmentId } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useUiStateStore } from "../uiStateStore";
import { sectionTarget } from "../projectSectionPlacement";
/** A layout can be edited locally even when its environment cannot accept settings writes. */
export function useSidebarLayoutPermission(
  sectionId: string | null = null,
  environmentId?: EnvironmentId,
) {
  const primary = usePrimaryEnvironmentId();
  const destination = environmentId ?? sectionTarget(sectionId)?.[0] ?? primary;
  const displayingSnapshot = useUiStateStore((state) => state.sidebarDisplaySnapshot !== null);
  return !displayingSnapshot && destination !== null;
}
