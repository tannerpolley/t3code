import { useUiStateStore } from "./uiStateStore";
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
let addingFolderSubsection = false;
export function isAddingFolderSubsection(): boolean {
  return addingFolderSubsection;
}
export function setAddProjectSection(sectionId: string | null, folderSubsection = false): void {
  addProjectSectionId = sectionId;
  addingFolderSubsection = folderSubsection;
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
  const unsubscribeUi = useUiStateStore.subscribe(listener);
  return () => {
    readinessListeners.delete(listener);
    unsubscribeUi();
  };
}
/** Section-derived RPC input must come from a live server layout. */
export function canPlaceProjectInSection(environmentId: EnvironmentId, sectionId: string | null) {
  if (sectionId !== null && useUiStateStore.getState().sidebarDisplaySnapshot !== null)
    return false;
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
/** A freshly added section first appears in the optimistic layout, before the server can place projects in it. */
export async function waitForNewSectionPlacement(environmentId: EnvironmentId, sectionId: string) {
  if (canPlaceProjectInSection(environmentId, sectionId)) return true;
  const controller = layoutController;
  const target = sectionTarget(sectionId);
  if (controller === null || target === null || controller.record(environmentId) === null)
    return false;
  return new Promise<boolean>((resolve) => {
    const check = () => {
      const ready = canPlaceProjectInSection(environmentId, sectionId);
      const pending = controller
        .getSnapshot()
        .get(environmentId)
        ?.sidebarProjectSections.some((section) => section.id === target[1]);
      if (!ready && pending && controller.hasPending(environmentId)) return;
      unsubscribe();
      resolve(ready);
    };
    const unsubscribe = subscribeReadiness(check);
    check();
  });
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
  if (
    sectionId !== null &&
    canPlaceProjectInSection(ref.environmentId, sectionId) &&
    !serverPlacement(ref.environmentId)
  )
    place(ref, sectionId);
}
export async function placeAddedProject(
  ref: ScopedProjectRef,
  sectionId = addProjectSectionId,
): Promise<void> {
  if (sectionId === addProjectSectionId) addProjectSectionId = null;
  if (sectionId !== null && canPlaceProjectInSection(ref.environmentId, sectionId))
    place(ref, sectionId);
}
