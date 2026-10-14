import { environmentShell } from "../state/shell";
import { useEffect, useMemo, useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_SIDEBAR_LAYOUT,
  type EnvironmentId,
  type SidebarLayoutMutation,
  type SidebarLayout,
} from "@t3tools/contracts";
import { useProjects, useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useClientSettings } from "../hooks/useSettings";
import { selectProjectGroupingSettings } from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import {
  projectSidebarLayout,
  migrateSidebarLayout,
  sidebarSectionKey,
  sidebarProjectRefsForKeys,
} from "../sidebarLayoutProjection";
import {
  configureSidebarLayoutActions,
  legacySidebarLayout,
  useUiStateStore,
} from "../uiStateStore";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "./ui/toast";

/** Reuses the app's settings subscription, including while Settings unmounts the sidebar. */
export function SidebarLayoutSync() {
  const projects = useProjects();
  const configs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const groups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: grouping,
        groupScratchProjects: true,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }),
    [projects, grouping, primaryEnvironmentId],
  );
  const layouts = useMemo(
    () => new Map([...configs].map(([id, config]) => [id, config.settings?.sidebarLayout])),
    [configs],
  );
  const sectionTargets = useMemo(
    () =>
      new Map(
        [...layouts].flatMap(([environmentId, layout]) =>
          (layout?.sidebarProjectSections ?? []).map(
            (section) =>
              [
                sidebarSectionKey(environmentId, section.id),
                { environmentId, sectionId: section.id },
              ] as const,
          ),
        ),
      ),
    [layouts],
  );
  const update = useAtomCommand(serverEnvironment.updateSettings);

  useEffect(() => {
    const projected = projectSidebarLayout({ layouts, groups, primaryEnvironmentId });
    const current = useUiStateStore.getState();
    if (
      JSON.stringify(projected) !==
      JSON.stringify({
        sidebarProjectSections: current.sidebarProjectSections,
        projectExpandedById: current.projectExpandedById,
        projectOrder: current.projectOrder,
        sidebarOtherProjectsExpanded: current.sidebarOtherProjectsExpanded,
      })
    )
      useUiStateStore.setState(projected);
  }, [layouts, groups, primaryEnvironmentId]);

  useEffect(() => {
    const send = async (environmentId: EnvironmentId, mutation: SidebarLayoutMutation) =>
      (await update({ environmentId, input: { patch: { sidebarLayoutMutation: mutation } } }))
        ._tag === "Success";
    configureSidebarLayoutActions(async (mutation) => {
      const refs = (keys: readonly string[]) => sidebarProjectRefsForKeys(groups, keys);
      const ids = (keys: readonly string[], environmentId: EnvironmentId) => [
        ...new Set(
          refs(keys)
            .filter((ref) => ref.environmentId === environmentId)
            .map((ref) => ref.projectId),
        ),
      ];
      const target =
        "sectionId" in mutation && mutation.sectionId !== null
          ? sectionTargets.get(mutation.sectionId)
          : mutation.type === "add" && mutation.section.parentId
            ? sectionTargets.get(mutation.section.parentId)
            : undefined;
      const destination = target?.environmentId ?? primaryEnvironmentId;
      if (destination === null) return false;
      if ("sectionId" in mutation && mutation.sectionId !== null && !target) return false;
      switch (mutation.type) {
        case "add":
          send(destination, {
            ...mutation,
            section: { ...mutation.section, ...(target ? { parentId: target.sectionId } : {}) },
          });
          break;
        case "rename":
        case "color":
        case "folderIcons":
        case "delete":
        case "sectionExpanded":
          if (target) send(destination, { ...mutation, sectionId: target.sectionId });
          break;
        case "sectionProjectsOrder":
          if (target)
            send(destination, {
              ...mutation,
              sectionId: target.sectionId,
              projectKeys: ids(mutation.projectKeys, destination),
            });
          break;
        case "move":
        case "projectExpanded": {
          const destinations =
            mutation.type === "move" && target
              ? [destination]
              : [...new Set(refs(mutation.projectKeys).map((ref) => ref.environmentId))];
          for (const environmentId of destinations) {
            const projectKeys = ids(mutation.projectKeys, environmentId);
            if (projectKeys.length === 0) {
              toastManager.add({
                type: "error",
                title: "This section belongs to another environment",
                description: "Place the project in a section on its own environment.",
              });
              continue;
            }
            send(
              environmentId,
              mutation.type === "move"
                ? { ...mutation, projectKeys, sectionId: target?.sectionId ?? null }
                : { ...mutation, projectKeys },
            );
          }
          break;
        }
        case "sectionsOrder":
          for (const environmentId of layouts.keys())
            send(environmentId, {
              ...mutation,
              sectionIds: mutation.sectionIds.flatMap((key) =>
                sectionTargets.get(key)?.environmentId === environmentId
                  ? [sectionTargets.get(key)!.sectionId]
                  : [],
              ),
            });
          break;
        case "projectsOrder":
          for (const environmentId of layouts.keys())
            send(environmentId, {
              ...mutation,
              currentProjectOrder: ids(mutation.currentProjectOrder, environmentId),
              draggedProjectIds: ids(mutation.draggedProjectIds, environmentId),
              targetProjectIds: ids(mutation.targetProjectIds, environmentId),
            });
          break;
        case "organize": {
          const ownProjects = mutation.projects.flatMap((project) =>
            refs([project.projectKey])
              .filter((ref) => ref.environmentId === destination)
              .flatMap((ref) => {
                const member = projects.find(
                  (project) =>
                    project.environmentId === destination && project.id === ref.projectId,
                );
                return member
                  ? [{ projectKey: member.id, workspaceRoots: [member.workspaceRoot] }]
                  : [];
              }),
          );
          return await send(destination, { ...mutation, projects: ownProjects });
        }
        case "otherExpanded":
        case "migrate":
          send(destination, mutation);
          break;
      }
      return true;
    });
    return () => configureSidebarLayoutActions(async () => false);
  }, [groups, layouts, primaryEnvironmentId, projects, sectionTargets, update]);
  return (
    <>
      {[...configs].map(([environmentId, config]) => (
        <SidebarLayoutMigration
          key={environmentId}
          environmentId={environmentId}
          layout={config.settings?.sidebarLayout}
          settingsReady={config.settings !== undefined}
          projectsReady={projects
            .filter((project) => project.environmentId === environmentId)
            .every((project) => project.repositoryIdentityResolved === true)}
          groups={groups}
        />
      ))}
    </>
  );
}

function SidebarLayoutMigration(props: {
  environmentId: EnvironmentId;
  layout: SidebarLayout | undefined;
  settingsReady: boolean;
  projectsReady: boolean;
  groups: readonly SidebarProjectSnapshot[];
}) {
  const canWrite = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const pending = useRef(false);
  const shellReady =
    useAtomValue(environmentShell.stateValueAtom(props.environmentId)).status === "live";
  const update = useAtomCommand(serverEnvironment.updateSettings);
  useEffect(() => {
    if (
      !shellReady ||
      !props.settingsReady ||
      !props.projectsReady ||
      !canWrite ||
      props.layout !== undefined ||
      pending.current
    )
      return;
    const layout = migrateSidebarLayout(legacySidebarLayout, props.groups, props.environmentId);
    if (JSON.stringify(layout) === JSON.stringify(EMPTY_SIDEBAR_LAYOUT)) return;
    pending.current = true;
    void update({
      environmentId: props.environmentId,
      input: { patch: { sidebarLayoutMutation: { type: "migrate", layout } } },
    }).finally(() => {
      pending.current = false;
    });
  }, [canWrite, props, shellReady, update]);
  return null;
}
