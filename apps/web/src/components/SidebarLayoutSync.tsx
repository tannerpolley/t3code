import {
  createLegacySidebarRetirement,
  readPendingSidebarImport,
  savePendingSidebarImport,
  sidebarImportMemberships,
  resolvePendingSidebarImport,
  type PendingSidebarImport,
} from "../sidebarLayoutMigration";
import { configureProjectSectionPlacement, sectionTarget } from "../projectSectionPlacement";
import { randomUUID } from "../lib/utils";
import { environmentCatalog } from "../connection/catalog";
import { environmentShell } from "../state/shell";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type SidebarLayoutMutation,
  type SidebarLayout,
} from "@t3tools/contracts";
import { useProjects, useServerConfigs } from "../state/entities";
import { useEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
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
  applySidebarLayoutProjection,
  configureSidebarLayoutActions,
  legacySidebarLayout,
  clearLegacySidebarLayout,
  useUiStateStore,
} from "../uiStateStore";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  createSidebarLayoutClient,
  readLocalSidebarLayout,
  usesServerSidebar,
} from "../sidebarLayoutClient";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { toastManager } from "./ui/toast";

/** Dedicated layout streams remain mounted while Settings unmounts the sidebar. */
export function SidebarLayoutSync() {
  const projects = useProjects();
  const configs = useServerConfigs();
  const environmentIds = useEnvironmentIds();
  const catalogReady = useAtomValue(environmentCatalog.catalogValueAtom).isReady;
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
  const retireLegacy = useMemo(() => createLegacySidebarRetirement(clearLegacySidebarLayout), []);
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
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);
  const layouts = useMemo(
    () => new Map([...configs.keys()].map((id) => [id, snapshot.get(id)])),
    [configs, snapshot],
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

  useEffect(() => {
    const projected = projectSidebarLayout({ layouts, groups, primaryEnvironmentId });
    const knownIds = catalogReady ? environmentIds : null;
    const complete =
      catalogReady &&
      environmentIds.every(
        (id) =>
          configs.has(id) &&
          snapshot.has(id) &&
          (!usesServerSidebar(configs.get(id)?.sidebarLayoutSync) ||
            controller.record(id) !== null),
      );
    applySidebarLayoutProjection(projected, knownIds, complete);
    const display = useUiStateStore.getState().sidebarDisplaySnapshot;
    if (display === null) return;
    const timer = setTimeout(
      () => applySidebarLayoutProjection(projected, knownIds, complete),
      Math.max(0, display.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [
    layouts,
    groups,
    primaryEnvironmentId,
    catalogReady,
    environmentIds,
    configs,
    snapshot,
    controller,
  ]);

  useEffect(() => {
    const refresh = () => {
      if (useUiStateStore.getState().sidebarDisplaySnapshot !== null) return;
      useUiStateStore.setState(
        projectSidebarLayout({
          layouts: controller.layouts(configs.keys()),
          groups,
          primaryEnvironmentId,
        }),
      );
    };
    const send = async (environmentId: EnvironmentId, mutation: SidebarLayoutMutation) => {
      const accepted = controller.enqueue(environmentId, mutation);
      refresh();
      return accepted;
    };
    configureProjectSectionPlacement((ref, key) => {
      if (useUiStateStore.getState().sidebarDisplaySnapshot !== null) return;
      const target = sectionTarget(key);
      if (target?.[0] !== ref.environmentId) return;
      controller.enqueue(ref.environmentId, {
        type: "move",
        sectionId: target[1],
        projectKeys: [ref.projectId],
        expanded: true,
      });
      refresh();
    }, controller);
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
          primary={environmentId === primaryEnvironmentId}
          allowImport={importEnvironments === null || importEnvironments.has(environmentId)}
          onLegacyStored={() => {
            setImportEnvironments((current) => current ?? new Set(environmentIds));
            retireLegacy(environmentId, environmentIds);
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
  primary: boolean;
  allowImport: boolean;
  onLegacyStored: () => void;
}) {
  const canWrite = useAtomValue(
    serverEnvironment.updateSidebarLayout.permissionAtom(props.environmentId),
  );
  const server = usesServerSidebar(props.capable);
  const shellReady =
    useAtomValue(environmentShell.stateValueAtom(props.environmentId)).status === "live";
  const pendingImport = useMemo(
    () => readPendingSidebarImport(props.environmentId),
    [props.environmentId],
  );
  const legacy = useMemo(
    () =>
      pendingImport?.legacy ??
      (server ? readLocalSidebarLayout(props.environmentId, props.legacy) : props.legacy),
    [pendingImport, server, props.environmentId, props.legacy],
  );
  const candidate = useMemo(
    () => migrateSidebarLayout(legacy, props.groups, props.environmentId, props.primary),
    [legacy, props.groups, props.environmentId, props.primary],
  );
  const fallbackReady =
    shellReady &&
    props.groups
      .flatMap((group) => group.memberProjects)
      .filter((project) => project.environmentId === props.environmentId)
      .every((project) => project.repositoryIdentityResolved !== false);
  const { controller, environmentId, onLegacyStored } = props;
  useEffect(() => {
    if (!server) {
      controller.configure(environmentId, false, candidate, { fallbackReady });
      if (fallbackReady) onLegacyStored();
    }
  }, [controller, environmentId, server, candidate, fallbackReady, onLegacyStored]);
  return server ? (
    <SidebarLayoutSubscription
      {...props}
      legacy={legacy}
      pendingImport={pendingImport}
      candidate={candidate}
      shellReady={shellReady}
      canWrite={canWrite}
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
  canWrite: boolean;
  allowImport: boolean;
  onLegacyStored: () => void;
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
    // Configure before applying a snapshot; child effects run before parent effects.
    props.controller.configure(props.environmentId, true, props.candidate, {
      canWrite: props.canWrite,
    });
    if (record) props.controller.receive(props.environmentId, record);
  }, [record, props.controller, props.environmentId, props.candidate, props.canWrite]);
  // Subscribed rather than read in render: the React Compiler memoizes a plain call on
  // its arguments, which would keep the pre-snapshot null forever.
  const current = useSyncExternalStore(props.controller.subscribe, () =>
    props.controller.record(props.environmentId),
  );
  useEffect(() => {
    if (
      !current ||
      !props.canWrite ||
      !props.shellReady ||
      (!props.allowImport && props.pendingImport === null)
    )
      return;
    const candidate = props.candidate;
    const ids = new Set([
      ...candidate.sidebarProjectSections.flatMap((section) => section.projectKeys),
      ...Object.keys(candidate.projectExpandedById),
      ...candidate.projectOrder,
    ]);
    if (current.legacyImportedAt === null) {
      if (sent.current) return;
      if (ids.size === 0 && candidate.sidebarProjectSections.length === 0) {
        if (
          props.groups
            .flatMap((group) => group.memberProjects)
            .filter((project) => project.environmentId === props.environmentId)
            .every((project) => project.repositoryIdentityResolved === true) &&
          !cleared.current
        ) {
          cleared.current = true;
          props.onLegacyStored();
        }
        return;
      }
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
    } else {
      if (!cleared.current) {
        cleared.current = true;
        props.onLegacyStored();
      }
      if (!sent.current && props.pendingImport === null) return;
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
