import { useSyncExternalStore } from "react";
import type { createSidebarLayoutClient } from "./sidebarLayoutClient";
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
let layoutController: ReturnType<typeof createSidebarLayoutClient> | null = null;
let unsubscribeLayout: (() => void) | undefined;
const readinessListeners = new Set<() => void>();
function subscribeReadiness(listener: () => void) {
  readinessListeners.add(listener);
  return () => {
    readinessListeners.delete(listener);
  };
}
/** Section-derived RPC input must come from a live server layout. */
export function canPlaceProjectInSection(environmentId: EnvironmentId, sectionId: string | null) {
  const target = sectionTarget(sectionId);
  if (target === null || target[0] !== environmentId) return true;
  if (
    !usesServerSidebar(
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.sidebarLayoutSync,
    )
  )
    return true;
  return (
    layoutController
      ?.record(environmentId)
      ?.layout.sidebarProjectSections.some((section) => section.id === target[1]) === true
  );
}
export function useProjectSectionPlacementReady(
  environmentId: EnvironmentId | null,
  sectionId: string | null,
) {
  return useSyncExternalStore(
    subscribeReadiness,
    () => environmentId !== null && canPlaceProjectInSection(environmentId, sectionId),
  );
}
let place: (ref: ScopedProjectRef, sectionId: string) => void = () => {};
export function configureProjectSectionPlacement(
  callback: typeof place,
  controller: ReturnType<typeof createSidebarLayoutClient> | null = null,
) {
  unsubscribeLayout?.();
  place = callback;
  layoutController = controller;
  const notify = () => {
    for (const listener of readinessListeners) listener();
  };
  unsubscribeLayout = controller?.subscribe(notify);
  notify();
}
export function sectionPlacementInput(environmentId: EnvironmentId, sectionId: string | null) {
  if (!canPlaceProjectInSection(environmentId, sectionId)) return null;
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
