import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { projectEnvironment } from "./state/projects";
let addProjectSectionId: string | null = null;
export function setAddProjectSection(sectionId: string | null): void {
  addProjectSectionId = sectionId;
}
export function currentAddProjectSection(): string | null {
  return addProjectSectionId;
}
const decodeSectionTarget = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([EnvironmentId, TrimmedNonEmptyString])),
);
export function sectionTarget(sectionId: string | null) {
  return sectionId === null ? null : Option.getOrNull(decodeSectionTarget(sectionId));
}
export function sectionPlacementInput(environmentId: string, sectionId: string | null) {
  const target = sectionTarget(sectionId);
  return target === null || target[0] !== environmentId
    ? {}
    : { sectionId: target[1], sidebarExpanded: true };
}
export async function placeAddedProject(
  ref: ScopedProjectRef,
  sectionId = addProjectSectionId,
): Promise<void> {
  if (sectionId === addProjectSectionId) addProjectSectionId = null;
  if (sectionId === null) return;
  await runAtomCommand(appAtomRegistry, projectEnvironment.update, {
    environmentId: ref.environmentId,
    input: { projectId: ref.projectId, ...sectionPlacementInput(ref.environmentId, sectionId) },
  });
}
