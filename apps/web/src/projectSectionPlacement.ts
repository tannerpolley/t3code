import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { serverEnvironment } from "./state/server";
import { usesServerSidebar } from "./sidebarLayoutClient";
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
function serverPlacement(environmentId: EnvironmentId) {
  return (
    usesServerSidebar(
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.sidebarLayoutSync,
    ) && appAtomRegistry.get(serverEnvironment.updateSidebarLayout.permissionAtom(environmentId))
  );
}
let place: (ref: ScopedProjectRef, sectionId: string) => void = () => {};
export function configureProjectSectionPlacement(callback: typeof place) {
  place = callback;
}
export function sectionPlacementInput(environmentId: EnvironmentId, sectionId: string | null) {
  const target = sectionTarget(sectionId);
  return target === null || target[0] !== environmentId || !serverPlacement(environmentId)
    ? {}
    : { sectionId: target[1], sidebarExpanded: true };
}
export function completeProjectSectionPlacement(ref: ScopedProjectRef, sectionId: string | null) {
  if (sectionId !== null && !serverPlacement(ref.environmentId)) place(ref, sectionId);
}
export async function placeAddedProject(
  ref: ScopedProjectRef,
  sectionId = addProjectSectionId,
): Promise<void> {
  if (sectionId === addProjectSectionId) addProjectSectionId = null;
  if (sectionId !== null) place(ref, sectionId);
}
