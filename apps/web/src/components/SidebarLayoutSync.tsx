import {
  readPendingSidebarImport,
  savePendingSidebarImport,
  sidebarImportMemberships,
  resolvePendingSidebarImport,
  type PendingSidebarImport,
} from "../sidebarLayoutMigration";
import { configureProjectSectionPlacement, sectionTarget } from "../projectSectionPlacement";
import { randomUUID } from "../lib/utils";
import { environmentShell } from "../state/shell";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
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
  clearLegacySidebarLayout,
  useUiStateStore,
} from "../uiStateStore";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { createSidebarLayoutClient, usesServerSidebar } from "../sidebarLayoutClient";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { toastManager } from "./ui/toast";

/** Dedicated layout streams remain mounted while Settings unmounts the sidebar. */
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
  const update = useAtomCommand(serverEnvironment.updateSidebarLayout);
  const [source] = useState(() => legacySidebarLayout);
  const [importEnvironments, setImportEnvironments] = useState<Set<EnvironmentId> | null>(null);
  const controller = useMemo(
    () =>
      createSidebarLayoutClient(
        async (environmentId, input) => {
          const result = await update({ environmentId, input });
          if (result._tag !== "Success") throw new Error("Could not save sidebar layout.");
          return result.value;
        },
        () => toastManager.add({ type: "error", title: "Could not save sidebar layout" }),
      ),
    [update],
  );
  useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);
  const layouts = controller.layouts(configs.keys());
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
    const refresh = () =>
      useUiStateStore.setState(
        projectSidebarLayout({
          layouts: controller.layouts(configs.keys()),
          groups,
          primaryEnvironmentId,
        }),
      );
    const send = async (environmentId: EnvironmentId, mutation: SidebarLayoutMutation) => {
      const accepted = controller.enqueue(environmentId, mutation);
      refresh();
      return accepted;
    };
    configureProjectSectionPlacement((ref, key) => {
      const target = sectionTarget(key);
      if (target?.[0] !== ref.environmentId) return;
      controller.enqueue(ref.environmentId, {
        type: "move",
        sectionId: target[1],
        projectKeys: [ref.projectId],
        expanded: true,
      });
      refresh();
    });
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
          for (const environmentId of new Set(
            mutation.sectionIds.flatMap((key) => sectionTargets.get(key)?.environmentId ?? []),
          ))
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
          for (const environmentId of new Set(
            refs(mutation.draggedProjectIds).map((ref) => ref.environmentId),
          ))
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
    return () => {
      configureSidebarLayoutActions(async () => false);
      configureProjectSectionPlacement(() => {});
    };
  }, [groups, primaryEnvironmentId, projects, sectionTargets, controller, configs]);
  return (
    <>
      {[...configs].map(([environmentId, config]) => (
        <SidebarLayoutEnvironment
          key={environmentId}
          environmentId={environmentId}
          capable={config.sidebarLayoutSync}
          groups={groups}
          controller={controller}
          legacy={source}
          allowImport={importEnvironments === null || importEnvironments.has(environmentId)}
          onImported={() => {
            setImportEnvironments((current) => current ?? new Set(configs.keys()));
            clearLegacySidebarLayout();
          }}
        />
      ))}
    </>
  );
}

function SidebarLayoutEnvironment(props: {
  environmentId: EnvironmentId;
  capable: boolean | undefined;
  groups: readonly SidebarProjectSnapshot[];
  controller: ReturnType<typeof createSidebarLayoutClient>;
  legacy: SidebarLayout;
  allowImport: boolean;
  onImported: () => void;
}) {
  const canWrite = useAtomValue(
    serverEnvironment.updateSidebarLayout.permissionAtom(props.environmentId),
  );
  const server = usesServerSidebar(props.capable, canWrite);
  const shellReady =
    useAtomValue(environmentShell.stateValueAtom(props.environmentId)).status === "live";
  const pendingImport = useMemo(
    () => readPendingSidebarImport(props.environmentId),
    [props.environmentId],
  );
  const legacy = pendingImport?.legacy ?? props.legacy;
  const candidate = useMemo(
    () => migrateSidebarLayout(legacy, props.groups, props.environmentId),
    [legacy, props.groups, props.environmentId],
  );
  useEffect(() => {
    props.controller.configure(props.environmentId, server, candidate);
  }, [props.controller, props.environmentId, server, candidate]);
  return server ? (
    <SidebarLayoutSubscription
      {...props}
      legacy={legacy}
      pendingImport={pendingImport}
      candidate={candidate}
      shellReady={shellReady}
    />
  ) : null;
}

function SidebarLayoutSubscription(props: {
  environmentId: EnvironmentId;
  groups: readonly SidebarProjectSnapshot[];
  controller: ReturnType<typeof createSidebarLayoutClient>;
  candidate: SidebarLayout;
  legacy: SidebarLayout;
  pendingImport: PendingSidebarImport | null;
  shellReady: boolean;
  allowImport: boolean;
  onImported: () => void;
}) {
  const result = useAtomValue(
    serverEnvironment.sidebarLayout({ environmentId: props.environmentId, input: {} }),
  );
  const record = Option.getOrNull(AsyncResult.value(result));
  const importId = useRef(props.pendingImport?.importId ?? randomUUID());
  const sent = useRef(false);
  const importedProjects = useRef(new Set(props.pendingImport?.memberships ?? []));
  const committedProjects = useRef(new Set(props.pendingImport?.memberships ?? []));
  const cleared = useRef(false);
  useEffect(() => {
    if (record) props.controller.receive(props.environmentId, record);
  }, [record, props.controller, props.environmentId]);
  const current = props.controller.record(props.environmentId);
  useEffect(() => {
    if (!current || !props.shellReady || (!props.allowImport && props.pendingImport === null))
      return;
    const candidate = props.candidate;
    const ids = new Set([
      ...candidate.sidebarProjectSections.flatMap((section) => section.projectKeys),
      ...Object.keys(candidate.projectExpandedById),
      ...candidate.projectOrder,
    ]);
    if (current.legacyImportedAt === null) {
      if (sent.current || ids.size === 0) return;
      sent.current = true;
      importedProjects.current = new Set(sidebarImportMemberships(candidate));
      committedProjects.current = new Set(importedProjects.current);
      savePendingSidebarImport(props.environmentId, {
        importId: importId.current,
        legacy: props.legacy,
        memberships: [...importedProjects.current],
      });
      props.controller.enqueue(props.environmentId, {
        type: "migrate",
        layout: candidate,
        importId: importId.current,
      });
    } else if (sent.current || props.pendingImport !== null) {
      if (!cleared.current) {
        cleared.current = true;
        props.onImported();
      }
      if (current.legacyImportId !== importId.current) {
        savePendingSidebarImport(props.environmentId, null);
        return;
      }
      for (const section of candidate.sidebarProjectSections)
        for (const id of section.projectKeys) {
          const membership = JSON.stringify([section.id, id]);
          if (
            importedProjects.current.has(membership) &&
            current.layout.sidebarProjectSections.some((saved) => saved.projectKeys.includes(id))
          )
            committedProjects.current.add(membership);
        }
      const operations = resolvePendingSidebarImport(
        candidate,
        current.layout,
        importedProjects.current,
      );
      for (const operation of operations) props.controller.enqueue(props.environmentId, operation);
      const ownProjects = props.groups
        .flatMap((group) => group.memberProjects)
        .filter((project) => project.environmentId === props.environmentId);
      savePendingSidebarImport(
        props.environmentId,
        !props.controller.hasPending(props.environmentId) &&
          [...importedProjects.current].every((membership) =>
            committedProjects.current.has(membership),
          ) &&
          ownProjects.every((project) => project.repositoryIdentityResolved === true)
          ? null
          : {
              importId: importId.current,
              legacy: props.legacy,
              memberships: [...committedProjects.current],
            },
      );
    }
  }, [current, props]);
  return null;
}
