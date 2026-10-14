import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { serverEnvironment } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";
import { sectionTarget } from "../projectSectionPlacement";
/** Availability comes from the command that authorizes the destination at execution. */
export function useSidebarLayoutPermission(
  sectionId: string | null = null,
  environmentId?: EnvironmentId,
) {
  const primary = usePrimaryEnvironmentId();
  return useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(
      environmentId ?? sectionTarget(sectionId)?.[0] ?? primary,
    ),
  );
}
