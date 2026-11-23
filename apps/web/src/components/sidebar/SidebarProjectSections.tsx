import { useWorkerStatusLabels } from "../issues/IssueLiveWork";
import { useSidebarIssueWorkerStatus } from "../../state/repositoryIssues";
import { sidebarBadgeKind } from "./SidebarColumns.logic";
import { sidebarSectionChildOrder } from "@t3tools/shared/sidebarLayout";
import { useSidebarWorkExpansion } from "./useSidebarWorkExpansion";
import {
  collectDisplayedFamilyRows,
  resolveSidebarFamilySeparators,
  sidebarSeparatorStyle,
  type SidebarFamilySeparator,
} from "./SidebarFamilySeparators.logic";
import { ForkSidebarTextSizes } from "./ForkSidebarTextSizes";
import { useSidebarLayoutPermission } from "../../hooks/useSidebarLayoutPermission";
import { pendingBackgroundWorkOfThread } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import {
  closestCorners,
  DragOverlay,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import { useGT } from "gt-react";
import {
  CheckIcon,
  CornerDownRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FilterIcon,
  FolderIcon,
  FolderOpenIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  RotateCcwIcon,
  GripVerticalIcon,
  PaletteIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import {
  SidebarProjectThreadName,
  ThreadIssueBadge,
  ThreadPullRequestBadge,
} from "./SidebarProjectThreadTooltip";
import { SidebarThreadRow, type SidebarProviderEntry } from "./SidebarThreadRow";
import {
  sameSidebarThreadRowState,
  sidebarThreadRowProps,
  type SidebarThreadRowAssembly,
  type SidebarThreadRowState,
} from "./sidebarThreadRowAssembly";
import { sidebarProjectThreadAccessibleName } from "./SidebarProjectThread.logic";
import { SidebarThreadTime } from "./SidebarThreadTime";
import { SidebarBackgroundWorkRows, type NestedWork } from "./SidebarBackgroundWorkRows";
import {
  SidebarProcessGroupRows,
  useSidebarThreadProcesses,
  type SidebarProcessRows,
} from "./SidebarThreadProcesses";
import {
  sidebarSubagentRowStatus,
  resolveSidebarProjectStatusMark,
} from "./SidebarThreadProcesses.logic";
import {
  SidebarCaretSlot,
  SidebarCaretToggle,
  SidebarTrailingColumns,
  SidebarThreadColumns,
  SidebarThreadTitle,
  threadGroupHue,
  PROJECTS_WORK_ROW_HEIGHT,
} from "./SidebarColumns";
import { ThreadLocationIcon } from "../ThreadLocationIcon";
import { ThreadRoleIcon } from "../ThreadRoleIcon";
import { ThreadRelationshipIcon } from "../chat/ThreadRelationshipIcon";
import {
  describeSidebarBackgroundWork,
  type BackgroundWorkTaskRow,
  resolveSidebarThreadModelLabel,
  sidebarEffortGlyph,
  sameSidebarSubagentTree,
  sidebarRoleLabel,
  sidebarThreadProvider,
} from "./SidebarBackgroundWork.logic";
import { useThreadContextPointerDrag } from "../chat/threadContextDrag";
import {
  Fragment,
  memo,
  useState,
  type ComponentProps,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type ProjectIconColor,
  type ThreadId,
} from "@t3tools/contracts";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import {
  inheritedSectionFolderAppearance,
  useProjectFolderAppearance,
} from "../../projectFolderAppearance";
import { openCommandPalette } from "../../commandPaletteBus";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { type SidebarProjectSection, useUiStateStore } from "../../uiStateStore";
import { cn, newProjectId } from "~/lib/utils";
import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import { dispatchCommandPalette, useCommandPaletteStore } from "../../commandPaletteStore";
import {
  completeProjectSectionPlacement,
  sectionPlacementInput,
  sectionTarget,
  useProjectSectionPlacementReady,
} from "../../projectSectionPlacement";
import {
  folderSubsectionInput,
  sectionFolderPath,
  sectionProjectCandidates,
  suggestSectionFolder,
} from "../../sectionProjectPath";
import { sidebarSectionKey } from "../../sidebarLayoutProjection";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import {
  flattenRunningSubagents,
  resolveLocationLeads,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
  useSidebarRowSubscriptionLease,
  withChildNeeds,
} from "../Sidebar.logic";
import { ThreadStatusMark } from "../ThreadStatusMark";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { ProjectFavicon } from "../ProjectFavicon";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useRemoveSidebarProject } from "../../hooks/useRemoveSidebarProject";
import { NewSectionProjectDialog, type NewSectionProjectTarget } from "./NewSectionProjectDialog";
import { SidebarProjectFolderHeader, sidebarFolderRowId } from "./SidebarProjectFolderHeader";
import { attachSidebarTree } from "../../lib/sidebarTree";
import {
  resolveProjectDrop,
  resolveSubsectionDrop,
  type ProjectDrop,
  type ProjectDropOver,
} from "./SidebarProjectSections.logic";

const UNGROUPED_SECTION_ID = "__ungrouped__";
const NO_THREADS: readonly SidebarThreadSummary[] = [];

type SidebarProjectSectionRender = {
  readonly id: string;
  readonly name: string;
  readonly projectKeys: readonly string[];
  readonly collapsed: boolean;
  readonly custom: boolean;
  /** The folder tint its projects show: its own color, or its parent section's. */
  readonly color: ProjectIconColor | undefined;
  /** The color chosen on this section itself, as its Folder color menu shows it. */
  readonly ownColor: ProjectIconColor | undefined;
  /** Projects show the folder over custom icons: set here or on the parent section. */
  readonly folderIcons: boolean;
  /** Set on this section itself, as its menu shows it. */
  readonly ownFolderIcons: boolean;
  readonly parentId: string | undefined;
  readonly childOrder?: readonly string[] | undefined;
  readonly folderPath?: string | undefined;
};

type ProjectDragData = {
  readonly type: "project";
  readonly sectionId: string | null;
};

type SectionDragData = {
  readonly type: "section";
  readonly sectionId: string;
};

type SectionContainerDragData = {
  readonly type: "section-container";
  readonly sectionId: string | null;
};

type SidebarProjectDragData = ProjectDragData | SectionDragData | SectionContainerDragData;

function sectionContainerId(sectionId: string): string {
  return `sidebar-project-section-container:${sectionId}`;
}

type ProjectContextMenuHandler = ComponentProps<typeof SidebarProjectFolderHeader>["onContextMenu"];

/** A section header's tree row; its projects and subsections name it as their parent. */
function sidebarSectionRowId(sectionId: string): string {
  return `section:${sectionId}`;
}

function sectionDragId(sectionId: string): string {
  return `sidebar-project-section-header:${sectionId}`;
}

function sectionIdFromDragData(
  data: SidebarProjectDragData | undefined,
): string | null | undefined {
  if (!data) return undefined;
  return data.sectionId;
}

/** What the pointer is over, in the terms the drop logic reads. */
function projectDropOverOf(
  over: { readonly id: string | number; readonly data: { readonly current?: unknown } } | null,
): ProjectDropOver | null {
  const data = over?.data.current as SidebarProjectDragData | undefined;
  if (!over || !data) return null;
  if (data.type === "project") return { type: "project", projectKey: String(over.id) };
  return {
    type: data.type === "section" ? "section-header" : "section",
    sectionId: data.sectionId ?? UNGROUPED_SECTION_ID,
  };
}

function projectSectionName(section: SidebarProjectSectionRender): string {
  return section.custom ? section.name : "Other projects";
}

interface SidebarProjectSectionsProps {
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly sections: readonly SidebarProjectSection[];
  readonly selectedProjectKey: string | null;
  readonly onSelectProject: (projectKey: string | null) => void;
  readonly onAddProject: () => void;
  /** From `useProjectSectionDialog`, which the sidebar mounts so its header can create sections. */
  readonly onOpenSectionDialog: (target: ProjectSectionDialogTarget) => void;
  readonly onOpenProjectSettings: (project: SidebarProjectSnapshot) => void;
  readonly onNewThreadInProject: (project: SidebarProjectSnapshot) => void;
  /** The shared project context menu, as Activity folders open it. */
  readonly onProjectContextMenu: ProjectContextMenuHandler;
  readonly threadsByProjectKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
  /** Running subagent threads by parent thread key; see `groupRunningSubagentsByParent`. */
  readonly runningSubagentsByParentKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
  readonly isProjectExpanded: (projectKey: string) => boolean;
  readonly onToggleProject: (projectKey: string, expanded: boolean) => void;
  /** Thread rows share Activity's row and its handlers. */
  readonly threadRowAssembly: SidebarThreadRowAssembly;
  readonly threadRowState: SidebarThreadRowState;
}

function SidebarProjectSections(props: SidebarProjectSectionsProps) {
  const {
    isProjectExpanded,
    onAddProject,
    onOpenSectionDialog,
    onNewThreadInProject,
    onOpenProjectSettings,
    onProjectContextMenu,
    onSelectProject,
    onToggleProject,
    projects,
    sections,
    selectedProjectKey,
    runningSubagentsByParentKey,
    threadRowAssembly,
    threadRowState,
    threadsByProjectKey,
  } = props;
  // Off restores the original Projects view: heading, action row, All projects, chevrons and grips.
  const canWrite = useSidebarLayoutPermission();
  const codexStyle = useClientSettings((settings) => settings.codexStyleSidebar);
  const folderColors = useClientSettings((settings) => settings.sectionFolderColors);
  const deleteSection = useUiStateStore((store) => store.deleteSidebarProjectSection);
  const setCustomSectionExpanded = useUiStateStore(
    (store) => store.setSidebarProjectSectionExpanded,
  );
  const otherProjectsExpanded = useUiStateStore((store) => store.sidebarOtherProjectsExpanded);
  const setOtherProjectsExpanded = useUiStateStore(
    (store) => store.setSidebarOtherProjectsExpanded,
  );
  const moveProject = useUiStateStore((store) => store.moveProjectToSidebarProjectSection);
  const reorderSectionProjects = useUiStateStore(
    (store) => store.reorderSidebarProjectSectionProjects,
  );
  const reorderChildren = useUiStateStore((store) => store.reorderSidebarSectionChildren);
  const reorderSections = useUiStateStore((store) => store.reorderSidebarProjectSections);
  const removeProject = useRemoveSidebarProject();
  const [activeProjectKey, setActiveProjectKey] = useState<string | null>(null);
  const [projectDrop, setProjectDrop] = useState<ProjectDrop | null>(null);
  // `id` remounts the dialog per opening so its form starts empty.
  const [newProjectDialog, setNewProjectDialog] = useState<{
    readonly target: NewSectionProjectTarget;
    readonly open: boolean;
    readonly id: number;
  } | null>(null);
  const openNewProjectDialog = (section: {
    readonly id: string;
    readonly name: string;
    readonly parentId: string | undefined;
    readonly folderPath?: string | undefined;
  }) => {
    const parentName =
      section.parentId === undefined
        ? undefined
        : sections.find((candidate) => candidate.id === section.parentId)?.name;
    setNewProjectDialog((current) => ({
      target: {
        sectionId: section.id,
        sectionName: section.name,
        parentName,
        folderPath: section.folderPath,
      },
      open: true,
      id: (current?.id ?? 0) + 1,
    }));
  };
  const projectByKey = new Map(projects.map((project) => [project.projectKey, project] as const));
  const renderedSections = (() => {
    const claimed = new Set<string>();
    const next: SidebarProjectSectionRender[] = [];
    for (const section of sections) {
      const projectKeys = section.projectKeys.filter((projectKey) => {
        if (!projectByKey.has(projectKey) || claimed.has(projectKey)) return false;
        claimed.add(projectKey);
        return true;
      });
      const parent =
        section.parentId === undefined
          ? undefined
          : sections.find((candidate) => candidate.id === section.parentId);
      const { color, folderIcons } = inheritedSectionFolderAppearance(section, parent);
      next.push({
        id: section.id,
        name: section.name,
        projectKeys,
        collapsed: section.collapsed,
        custom: true,
        color,
        ownColor: section.color,
        folderIcons,
        ownFolderIcons: section.folderIcons === true,
        parentId: section.parentId,
        childOrder: section.childOrder,
        folderPath: section.folderPath,
      });
    }
    const ungroupedProjectKeys = projects
      .map((project) => project.projectKey)
      .filter((projectKey) => !claimed.has(projectKey));
    if (ungroupedProjectKeys.length > 0) {
      next.push({
        id: UNGROUPED_SECTION_ID,
        name: "Other projects",
        projectKeys: ungroupedProjectKeys,
        collapsed: !otherProjectsExpanded,
        custom: false,
        color: undefined,
        ownColor: undefined,
        folderIcons: false,
        ownFolderIcons: false,
        parentId: undefined,
      });
    }
    return next;
  })() satisfies SidebarProjectSectionRender[];

  // Clears custom icons the same way the icon picker's Automatic choice does, on every checkout
  // of every project in the section and its subsections.
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const resetSectionIcons = async (section: SidebarProjectSectionRender) => {
    if (!canWrite || useUiStateStore.getState().sidebarDisplaySnapshot !== null) return;
    const sectionIds = new Set([
      section.id,
      ...renderedSections.filter((s) => s.parentId === section.id).map((s) => s.id),
    ]);
    const members = renderedSections
      .filter((candidate) => sectionIds.has(candidate.id))
      .flatMap((candidate) => candidate.projectKeys)
      .flatMap((key) => projectByKey.get(key)?.memberProjects ?? [])
      .filter((member) => member.projectIcon != null || member.faviconPath != null);
    if (members.length === 0) {
      toastManager.add({ type: "info", title: "These projects already use automatic icons" });
      return;
    }
    if (
      !window.confirm(
        `Reset the icons of ${members.length} project checkout${members.length === 1 ? "" : "s"} in ${section.name} to automatic? Their custom icons will be cleared.`,
      )
    ) {
      return;
    }
    let failed = 0;
    for (const member of members) {
      const result = await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, faviconPath: null, projectIcon: null },
      });
      if (result._tag === "Failure") failed += 1;
    }
    toastManager.add(
      failed === 0
        ? { type: "success", title: `Reset ${members.length} project icons in ${section.name}` }
        : {
            type: "error",
            title: `Couldn't reset ${failed} of ${members.length} project icons`,
            description: "Connect the project's environment and try again.",
          },
    );
  };

  const setSectionExpanded = (sectionId: string, expanded: boolean) => {
    if (sectionId === UNGROUPED_SECTION_ID) {
      setOtherProjectsExpanded(expanded);
      return;
    }
    setCustomSectionExpanded(sectionId, expanded);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Codex style drags whole rows, so Space picks a row up and Enter stays the row's own expand
    // and collapse. Otherwise a grip button is the handle and takes the default Space or Enter.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      ...(codexStyle
        ? { keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] } }
        : {}),
    }),
  );
  // The pointer sits over a project and its section at once; the project is the precise target.
  const collisionDetection = ((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length === 0) return closestCorners(args);
    const typeOf = (collision: (typeof pointerCollisions)[number]) =>
      args.droppableContainers.find((container) => container.id === collision.id)?.data.current
        ?.type;
    // A subsection's body sits inside its section's, so the smallest container is the real one.
    const area = (collision: (typeof pointerCollisions)[number]) => {
      const rect = args.droppableRects.get(collision.id);
      return rect ? rect.width * rect.height : Number.POSITIVE_INFINITY;
    };
    const innermostContainer = pointerCollisions
      .filter((collision) => typeOf(collision) === "section-container")
      .toSorted((left, right) => area(left) - area(right))[0];
    const preferred =
      pointerCollisions.find((collision) => typeOf(collision) === "project") ??
      pointerCollisions.find((collision) => typeOf(collision) === "section") ??
      innermostContainer;
    return preferred ? [preferred] : pointerCollisions;
  }) satisfies CollisionDetection;

  const openRenameDialog = (section: SidebarProjectSectionRender) => {
    if (section.custom) onOpenSectionDialog({ kind: "rename", id: section.id, name: section.name });
  };
  const openSubsectionDialog = (parent: { readonly id: string; readonly name: string }) =>
    onOpenSectionDialog({ kind: "create", parent: { id: parent.id, name: parent.name } });

  const handleDragStart = (event: DragStartEvent) => {
    const activeData = event.active.data.current as SidebarProjectDragData | undefined;
    setActiveProjectKey(activeData?.type === "project" ? String(event.active.id) : null);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const activeData = event.active.data.current as SidebarProjectDragData | undefined;
    const over = projectDropOverOf(event.over);
    setProjectDrop(
      !over
        ? null
        : activeData?.type === "project"
          ? resolveProjectDrop({
              projectKey: String(event.active.id),
              over,
              sections: renderedSections,
            })
          : activeData?.type === "section"
            ? resolveSubsectionDrop(activeData.sectionId, over, renderedSections)
            : null,
    );
  };

  const handleDragCancel = (_event: DragCancelEvent) => {
    setActiveProjectKey(null);
    setProjectDrop(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveProjectKey(null);
    setProjectDrop(null);
    const activeData = event.active.data.current as SidebarProjectDragData | undefined;
    const overData = event.over?.data.current as SidebarProjectDragData | undefined;
    if (
      !canWrite ||
      useUiStateStore.getState().sidebarDisplaySnapshot !== null ||
      !activeData ||
      !event.over
    )
      return;

    if (activeData.type === "section") {
      const activeSection = sections.find((section) => section.id === activeData.sectionId);
      if (activeSection?.parentId !== undefined) {
        const over = projectDropOverOf(event.over);
        const drop = over
          ? resolveSubsectionDrop(activeData.sectionId, over, renderedSections)
          : null;
        if (drop?.childOrder) reorderChildren(drop.sectionId, drop.childOrder);
        return;
      }
      const targetSectionId = sectionIdFromDragData(overData);
      if (
        targetSectionId === null ||
        targetSectionId === undefined ||
        targetSectionId === activeData.sectionId
      ) {
        return;
      }
      const targetSection = sections.find((s) => s.id === targetSectionId);
      const topTargetId = targetSection?.parentId ?? targetSectionId;
      const currentIds = sections
        .filter((s) => s.parentId === undefined)
        .map((section) => section.id);
      const fromIndex = currentIds.indexOf(activeData.sectionId);
      const toIndex = currentIds.indexOf(topTargetId);
      if (fromIndex >= 0 && toIndex >= 0) {
        reorderSections(arrayMove(currentIds, fromIndex, toIndex));
      }
      return;
    }

    if (activeData.type !== "project") return;
    const projectKey = String(event.active.id);
    const over = projectDropOverOf(event.over);
    const drop = over ? resolveProjectDrop({ projectKey, over, sections: renderedSections }) : null;
    if (drop === null) return;
    if (drop.projectKeys === null) {
      moveProject(projectKey, null);
      return;
    }
    if (activeData.sectionId !== drop.sectionId) moveProject(projectKey, drop.sectionId);
    if (drop.childOrder) reorderChildren(drop.sectionId, drop.childOrder);
    else reorderSectionProjects(drop.sectionId, [...drop.projectKeys]);
  };

  return (
    <ForkSidebarTextSizes className="group-data-[collapsible=icon]:hidden px-1 py-1">
      {codexStyle ? null : (
        <div className="mb-1 px-2">
          <span className="text-xs font-medium text-sidebar-muted-foreground/80">Projects</span>
          <div className="mt-1 grid grid-cols-2 gap-1">
            <Button
              className="justify-start"
              onClick={onAddProject}
              size="xs"
              variant="ghost-muted"
            >
              <PlusIcon />
              Add project
            </Button>
            <Button
              className="justify-start"
              disabled={!canWrite}
              data-testid="sidebar-create-project-section"
              onClick={() => onOpenSectionDialog({ kind: "create" })}
              size="xs"
              variant="ghost-muted"
            >
              <FolderPlusIcon />
              New section
            </Button>
          </div>
        </div>
      )}
      <DndContext
        collisionDetection={collisionDetection}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        <ul ref={attachSidebarTree} className="flex min-w-0 flex-col gap-px">
          {codexStyle ? null : (
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={selectedProjectKey === null}
                onClick={() => onSelectProject(null)}
                size="sm"
              >
                <FolderIcon className="text-icon-muted" />
                <span>All projects</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SortableContext
            items={renderedSections
              .filter((section) => section.custom && section.parentId === undefined)
              .map((section) => sectionDragId(section.id))}
            strategy={verticalListSortingStrategy}
          >
            {renderedSections
              .filter((section) => section.parentId === undefined)
              .map((section) => (
                <ProjectSection
                  key={section.id}
                  codexStyle={codexStyle}
                  folderColors={folderColors}
                  projectDrop={projectDrop}
                  subsections={renderedSections.filter(
                    (candidate) => candidate.parentId === section.id,
                  )}
                  onNewSubsection={openSubsectionDialog}
                  onNewProjectInSection={openNewProjectDialog}
                  onResetIcons={resetSectionIcons}
                  onDelete={deleteSection}
                  onMoveProject={moveProject}
                  onNewThreadInProject={onNewThreadInProject}
                  onProjectContextMenu={onProjectContextMenu}
                  onOpenProjectSettings={onOpenProjectSettings}
                  onRemoveProject={removeProject}
                  onOpenRename={openRenameDialog}
                  onSelectProject={onSelectProject}
                  onSetExpanded={setSectionExpanded}
                  threadRowAssembly={threadRowAssembly}
                  threadRowState={threadRowState}
                  isProjectExpanded={isProjectExpanded}
                  onToggleProject={onToggleProject}
                  projectByKey={projectByKey}
                  section={section}
                  sections={renderedSections}
                  selectedProjectKey={selectedProjectKey}
                  threadsByProjectKey={threadsByProjectKey}
                  runningSubagentsByParentKey={runningSubagentsByParentKey}
                />
              ))}
          </SortableContext>
        </ul>
        <DragOverlay dropAnimation={null}>
          {activeProjectKey ? (
            <ProjectDragPreview project={projectByKey.get(activeProjectKey) ?? null} />
          ) : null}
        </DragOverlay>
      </DndContext>
      {newProjectDialog ? (
        <NewSectionProjectDialog
          key={newProjectDialog.id}
          target={newProjectDialog.target}
          open={newProjectDialog.open}
          onOpenChange={(open) =>
            setNewProjectDialog((current) => (current ? { ...current, open } : current))
          }
        />
      ) : null}
    </ForkSidebarTextSizes>
  );
}

const ProjectSection = memo(function ProjectSection(props: {
  readonly section: SidebarProjectSectionRender;
  readonly codexStyle: boolean;
  readonly folderColors: boolean;
  /** Where a dragged project would land; this section shows it when it is the target. */
  readonly projectDrop: ProjectDrop | null;
  /** Immediate subsections; empty for subsections themselves. */
  readonly subsections: readonly SidebarProjectSectionRender[];
  readonly onNewSubsection: (parent: { readonly id: string; readonly name: string }) => void;
  readonly onNewProjectInSection: (section: SidebarProjectSectionRender) => void;
  readonly onResetIcons: (section: SidebarProjectSectionRender) => void;
  readonly sections: readonly SidebarProjectSectionRender[];
  readonly projectByKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly selectedProjectKey: string | null;
  readonly onSelectProject: (projectKey: string | null) => void;
  readonly onOpenProjectSettings: (project: SidebarProjectSnapshot) => void;
  readonly onNewThreadInProject: (project: SidebarProjectSnapshot) => void;
  readonly onProjectContextMenu: ProjectContextMenuHandler;
  readonly onRemoveProject: (project: SidebarProjectSnapshot) => Promise<void>;
  readonly onOpenRename: (section: SidebarProjectSectionRender) => void;
  readonly onDelete: (sectionId: string) => void;
  readonly onSetExpanded: (sectionId: string, expanded: boolean) => void;
  readonly onMoveProject: (projectKey: string, sectionId: string | null) => void;
  readonly threadRowAssembly: SidebarThreadRowAssembly;
  readonly threadRowState: SidebarThreadRowState;
  readonly isProjectExpanded: (projectKey: string) => boolean;
  readonly onToggleProject: (projectKey: string, expanded: boolean) => void;
  readonly threadsByProjectKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
  /** Running subagent threads by parent thread key; see `groupRunningSubagentsByParent`. */
  readonly runningSubagentsByParentKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
}) {
  const canWrite = useSidebarLayoutPermission();
  const { setNodeRef: setDropRef } = useDroppable({
    disabled: !canWrite,
    data: {
      type: "section-container",
      sectionId: props.section.custom ? props.section.id : null,
    } satisfies SectionContainerDragData,
    id: sectionContainerId(props.section.id),
  });
  const expanded = !props.section.collapsed;
  const sectionProjectKeys = expanded ? props.section.projectKeys : [];
  const childOrder = expanded ? sidebarSectionChildOrder(props.section, props.subsections) : [];
  const drop = props.projectDrop?.sectionId === props.section.id ? props.projectDrop : null;
  // A line marks the landing spot; a section with no visible order highlights instead.
  const highlighted = drop !== null && (drop.beforeKey === undefined || !expanded);
  const isSubsection = props.section.parentId !== undefined;

  return (
    <li
      ref={setDropRef}
      className={cn(
        "group/section rounded-md",
        highlighted && "bg-sidebar-row-selected/60",
        // Codex style keeps every icon in one column: sections get a divider instead of an indent,
        // and a bracket in the gutter marks what a subsection holds.
        props.codexStyle &&
          (isSubsection
            ? "relative"
            : "not-first:mt-2 rounded-none not-first:border-sidebar-border/70 not-first:border-t not-first:pt-2"),
      )}
    >
      <SortableSectionHeader
        codexStyle={props.codexStyle}
        folderColors={props.folderColors}
        onNewSubsection={isSubsection ? undefined : props.onNewSubsection}
        onNewProjectInSection={props.onNewProjectInSection}
        onResetIcons={props.onResetIcons}
        onDelete={props.onDelete}
        onOpenRename={props.onOpenRename}
        onSetExpanded={props.onSetExpanded}
        section={props.section}
      />
      {props.codexStyle && isSubsection ? (
        <span
          aria-hidden
          className="pointer-events-none absolute start-0 top-3.5 bottom-1 w-1.5 rounded-ss-sm border-sidebar-foreground/30 border-s border-t"
        />
      ) : null}
      {expanded ? (
        <ul
          className={props.codexStyle ? undefined : "ms-3 border-sidebar-border/60 border-s ps-1"}
        >
          <SortableContext
            items={childOrder.map((key) =>
              key.startsWith("section:") ? sectionDragId(key.slice(8)) : key,
            )}
            strategy={verticalListSortingStrategy}
          >
            {childOrder.map((projectKey) => {
              const subsection = props.subsections.find((s) => `section:${s.id}` === projectKey);
              if (subsection)
                return (
                  <Fragment key={projectKey}>
                    {drop?.beforeKey === projectKey ? <ProjectDropLine /> : null}
                    <ProjectSection {...props} section={subsection} subsections={[]} />
                  </Fragment>
                );
              const project = props.projectByKey.get(projectKey);
              return project ? (
                <Fragment key={projectKey}>
                  {drop?.beforeKey === projectKey ? <ProjectDropLine /> : null}
                  <SortableProjectRow
                    codexStyle={props.codexStyle}
                    onMoveProject={props.onMoveProject}
                    onNewThreadInProject={props.onNewThreadInProject}
                    onProjectContextMenu={props.onProjectContextMenu}
                    onOpenProjectSettings={props.onOpenProjectSettings}
                    onRemoveProject={props.onRemoveProject}
                    onSelectProject={props.onSelectProject}
                    threadRowAssembly={props.threadRowAssembly}
                    threadRowState={props.threadRowState}
                    isProjectExpanded={props.isProjectExpanded(project.projectKey)}
                    onToggleProject={props.onToggleProject}
                    project={project}
                    sectionId={props.section.custom ? props.section.id : null}
                    sections={props.sections}
                    selected={props.selectedProjectKey === projectKey}
                    threads={props.threadsByProjectKey.get(project.projectKey) ?? []}
                    runningSubagentsByParentKey={props.runningSubagentsByParentKey}
                  />
                </Fragment>
              ) : null;
            })}
          </SortableContext>
          {drop?.beforeKey === null ? <ProjectDropLine /> : null}
          {sectionProjectKeys.length === 0 && props.subsections.length === 0 ? (
            <li className="px-2 py-1 text-2xs text-sidebar-muted-foreground/55">
              {props.section.custom ? "Drop projects here" : "No ungrouped projects"}
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
});

function SortableSectionHeader(props: {
  readonly section: SidebarProjectSectionRender;
  readonly codexStyle: boolean;
  readonly folderColors: boolean;
  /** Offered on top-level sections only; subsections nest one level deep. */
  readonly onNewSubsection:
    | ((parent: { readonly id: string; readonly name: string }) => void)
    | undefined;
  readonly onNewProjectInSection: (section: SidebarProjectSectionRender) => void;
  readonly onResetIcons: (section: SidebarProjectSectionRender) => void;
  readonly onOpenRename: (section: SidebarProjectSectionRender) => void;
  readonly onDelete: (sectionId: string) => void;
  readonly onSetExpanded: (sectionId: string, expanded: boolean) => void;
}) {
  const { section } = props;
  const canWrite = useSidebarLayoutPermission(section.custom ? section.id : null);
  const placementReady = useProjectSectionPlacementReady(
    sectionTarget(section.id)?.[0] ?? null,
    section.id,
  );
  const setSectionColor = useUiStateStore((store) => store.setSidebarProjectSectionColor);
  const setSectionFolderIcons = useUiStateStore(
    (store) => store.setSidebarProjectSectionFolderIcons,
  );
  const sortable = useSortable({
    data: {
      type: "section",
      sectionId: section.id,
    } satisfies SectionDragData,
    disabled: !canWrite || !section.custom,
    id: sectionDragId(section.id),
  });
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    isDragging,
    transform,
    transition,
  } = sortable;
  const { codexStyle } = props;
  const draggable = canWrite && section.custom;
  const expanded = !section.collapsed;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "fork-sidebar-section group/project-section relative flex h-7 items-center rounded-md px-1",
        isDragging && "z-10 opacity-70",
      )}
      data-testid={`sidebar-project-section-${section.id}`}
      style={
        section.parentId === undefined
          ? { transform: CSS.Translate.toString(transform), transition }
          : undefined
      }
    >
      {/* Codex style drags a custom section by its whole header and shows the caret on hover;
          otherwise a grip button drags it. */}
      <button
        ref={draggable && codexStyle ? setActivatorNodeRef : undefined}
        {...(draggable && codexStyle ? { ...attributes, ...listeners } : {})}
        disabled={!canWrite}
        data-sidebar-row={sidebarSectionRowId(section.id)}
        data-sidebar-parent={
          section.parentId === undefined ? undefined : sidebarSectionRowId(section.parentId)
        }
        aria-expanded={expanded}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center rounded-md px-1 text-left font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          // Codex style sets sections apart from the project rows under them: a small uppercase label.
          codexStyle ? "gap-2 text-2xs font-semibold uppercase tracking-wide" : "gap-1.5 text-xs",
          codexStyle &&
            section.parentId !== undefined &&
            "font-normal normal-case tracking-normal text-sidebar-muted-foreground/60",
          // Its actions menu overlays the row end, so the count moves aside while the menu shows.
          codexStyle &&
            section.custom &&
            "group-hover/project-section:pe-7 group-focus-within/project-section:pe-7",
        )}
        onClick={() => {
          if (canWrite) props.onSetExpanded(section.id, !expanded);
        }}
        type="button"
      >
        {codexStyle ? null : (
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")}
          />
        )}
        <span className="fork-sidebar-title min-w-0 truncate">{projectSectionName(section)}</span>
        {/* Codex style: the caret follows the name, so flat rows keep the left edge for names. */}
        {codexStyle ? (
          <SidebarCaretSlot
            open={expanded}
            className="opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100"
          />
        ) : null}
        {codexStyle ? (
          // Counts show only while collapsed: they stand in for the hidden rows.
          <SidebarTrailingColumns count={expanded ? undefined : section.projectKeys.length} />
        ) : (
          <span className="ms-auto shrink-0 text-2xs text-sidebar-muted-foreground/55">
            {section.projectKeys.length}
          </span>
        )}
      </button>
      {section.custom ? (
        <>
          {codexStyle || !draggable ? null : (
            <button
              aria-label={`Reorder ${section.name} section`}
              className="inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing group-hover/project-section:opacity-100 group-focus-within/project-section:opacity-100"
              ref={setActivatorNodeRef}
              type="button"
              {...attributes}
              {...listeners}
            >
              <GripVerticalIcon aria-hidden className="size-3.5" />
            </button>
          )}
          <Menu>
            <MenuTrigger
              render={
                <button
                  disabled={!canWrite}
                  aria-label={`Actions for ${section.name}`}
                  className={cn(
                    "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/project-section:opacity-100 group-focus-within/project-section:opacity-100",
                    // Codex style overlays the empty time and status slots, as on project rows.
                    codexStyle && "absolute end-1 top-0.5",
                  )}
                  type="button"
                />
              }
            >
              <EllipsisIcon aria-hidden className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-40">
              <MenuItem
                disabled={!canWrite || !placementReady}
                onClick={() => openCommandPalette({ open: "add-project", sectionId: section.id })}
              >
                <FolderPlusIcon />
                Add project
              </MenuItem>
              <MenuItem
                disabled={!canWrite || !placementReady}
                onClick={() => props.onNewProjectInSection(section)}
              >
                <FilePlusIcon />
                New project…
              </MenuItem>
              {props.onNewSubsection ? (
                <MenuItem
                  disabled={!canWrite || !placementReady}
                  onClick={() =>
                    openCommandPalette({
                      open: "add-project",
                      sectionId: section.id,
                      folderSubsection: true,
                    })
                  }
                >
                  <FolderTreeIcon />
                  Add folder as subsection…
                </MenuItem>
              ) : null}
              {props.onNewSubsection ? (
                <MenuItem disabled={!canWrite} onClick={() => props.onNewSubsection?.(section)}>
                  <FolderTreeIcon />
                  New subsection
                </MenuItem>
              ) : null}
              <MenuItem disabled={!canWrite} onClick={() => props.onOpenRename(section)}>
                <SettingsIcon />
                Rename section
              </MenuItem>
              {props.folderColors ? (
                <MenuSub>
                  <MenuSubTrigger>
                    <PaletteIcon />
                    Folder color
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuItem
                      disabled={!canWrite}
                      onClick={() => setSectionColor(section.id, null)}
                    >
                      <span aria-hidden className="size-3 rounded-full border border-border" />
                      None
                      {section.ownColor === undefined ? <CheckIcon className="ms-auto" /> : null}
                    </MenuItem>
                    {PROJECT_ICON_COLORS.map((color) => (
                      <MenuItem
                        disabled={!canWrite}
                        key={color.value}
                        onClick={() => setSectionColor(section.id, color.value)}
                      >
                        <span
                          aria-hidden
                          className={cn("size-3 rounded-full", color.swatchClassName)}
                        />
                        {color.label}
                        {section.ownColor === color.value ? (
                          <CheckIcon className="ms-auto" />
                        ) : null}
                      </MenuItem>
                    ))}
                  </MenuSubPopup>
                </MenuSub>
              ) : null}
              <MenuItem
                disabled={!canWrite}
                onClick={() => setSectionFolderIcons(section.id, !section.ownFolderIcons)}
              >
                <FolderIcon />
                Use folder icons
                {section.ownFolderIcons ? <CheckIcon className="ms-auto" /> : null}
              </MenuItem>
              <MenuItem disabled={!canWrite} onClick={() => props.onResetIcons(section)}>
                <RotateCcwIcon />
                Reset project icons…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!canWrite}
                onClick={() => props.onDelete(section.id)}
                variant="destructive"
              >
                <Trash2Icon />
                Delete section
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      ) : null}
    </div>
  );
}

const SortableProjectRow = memo(function SortableProjectRow(props: {
  readonly project: SidebarProjectSnapshot;
  readonly codexStyle: boolean;
  readonly sectionId: string | null;
  readonly sections: readonly SidebarProjectSectionRender[];
  readonly selected: boolean;
  readonly onSelectProject: (projectKey: string | null) => void;
  readonly onOpenProjectSettings: (project: SidebarProjectSnapshot) => void;
  readonly onNewThreadInProject: (project: SidebarProjectSnapshot) => void;
  readonly onProjectContextMenu: ProjectContextMenuHandler;
  readonly onRemoveProject: (project: SidebarProjectSnapshot) => Promise<void>;
  readonly onMoveProject: (projectKey: string, sectionId: string | null) => void;
  readonly isProjectExpanded: boolean;
  readonly onToggleProject: (projectKey: string, expanded: boolean) => void;
  readonly threadRowAssembly: SidebarThreadRowAssembly;
  readonly threadRowState: SidebarThreadRowState;
  readonly threads: readonly SidebarThreadSummary[];
  readonly runningSubagentsByParentKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
}) {
  const { project, codexStyle } = props;
  const canWrite = useSidebarLayoutPermission(null, project.environmentId);
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef } = useSortable({
    data: {
      type: "project",
      sectionId: props.sectionId,
    } satisfies ProjectDragData,
    id: project.projectKey,
    disabled: !canWrite,
  });
  const otherSections = props.sections.filter(
    (section) => section.custom && section.id !== props.sectionId,
  );
  const { folderColor, forceFolder } = useProjectFolderAppearance(project.projectKey);
  const familyStyle = useClientSettings((settings) => settings.sidebarFamilyStyle);
  // Each row's own block (its row and its displayed work) of separators and location leads, as
  // text: changing one row's work re-renders that row and only rows whose marks changed.
  const familyBlocksText = useUiStateStore((state) => {
    if (!codexStyle || !props.isProjectExpanded) return "";
    const rows = collectDisplayedFamilyRows({
      ...props,
      expandedByKey: state.sidebarWorkExpandedById,
    });
    const separators =
      familyStyle === "lines"
        ? resolveSidebarFamilySeparators(rows)
        : new Map<string, SidebarFamilySeparator>();
    const leads = new Set(
      [
        ...resolveLocationLeads(
          rows.flatMap(({ thread, topLevel }) => (thread === null ? [] : [{ thread, topLevel }])),
        ).values(),
      ].map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    );
    const blocks: Record<string, SidebarFamilyBlock> = {};
    let block: SidebarFamilyBlock = { separators: [], leads: [] };
    for (const row of rows) {
      if (row.topLevel) block = blocks[row.key] = { separators: [], leads: [] };
      const separator = separators.get(row.key);
      if (separator !== undefined) block.separators.push([row.key, separator]);
      if (leads.has(row.key)) block.leads.push(row.key);
    }
    return JSON.stringify(blocks);
  });
  const familyBlocks: Record<string, SidebarFamilyBlock> =
    familyBlocksText === "" ? {} : JSON.parse(familyBlocksText);
  const toggle = () => {
    if (canWrite) props.onToggleProject(project.projectKey, !props.isProjectExpanded);
  };
  const count =
    props.threads.length > 0
      ? props.threads.length
      : project.groupedProjectCount > 1
        ? project.groupedProjectCount
        : undefined;

  return (
    // Rows stay put while dragging; the drop line shows where this one lands.
    <li ref={setNodeRef} className={cn("relative rounded-md", isDragging && "opacity-40")}>
      <SidebarProjectFolderHeader
        group={project}
        collapsed={!props.isProjectExpanded}
        hiddenThreads={props.isProjectExpanded ? NO_THREADS : props.threads}
        onToggle={toggle}
        onNewThread={props.onNewThreadInProject}
        onContextMenu={props.onProjectContextMenu}
        placement={{
          parentRow: sidebarSectionRowId(props.sectionId ?? UNGROUPED_SECTION_ID),
          // Codex style drags the whole row; otherwise the grip button is the handle.
          button: {
            ...(codexStyle ? { ...attributes, ...listeners, ref: setActivatorNodeRef } : {}),
            disabled: !canWrite,
            className: cn(
              "fork-sidebar-project flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              // Codex style makes room for the actions menu only while it shows.
              codexStyle
                ? "group-hover/project-folder:pe-8 group-focus-within/project-folder:pe-8"
                : "pe-12",
              props.selected && "bg-sidebar-row-selected text-sidebar-foreground",
            ),
          },
          leading: (
            <>
              {codexStyle ? null : (
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "size-3 shrink-0 text-icon-muted transition-transform",
                    props.isProjectExpanded && "rotate-90",
                  )}
                />
              )}
              <ProjectFavicon
                className="size-4"
                folderColor={folderColor}
                forceFolder={forceFolder}
                project={project}
                {...(codexStyle && props.isProjectExpanded ? { fallbackIcon: FolderOpenIcon } : {})}
              />
            </>
          ),
          titleClassName: cn("fork-sidebar-title min-w-0 truncate", !codexStyle && "flex-1"),
          trailing: codexStyle ? (
            <>
              <SidebarCaretSlot open={props.isProjectExpanded} className="text-icon-muted" />
              {/* Counts show only while collapsed: they stand in for the hidden rows. */}
              <SidebarTrailingColumns count={props.isProjectExpanded ? undefined : count} />
            </>
          ) : count === undefined ? null : (
            <span className="shrink-0 text-2xs text-sidebar-muted-foreground/55">{count}</span>
          ),
          controls: (
            <div className="pointer-events-none absolute inset-y-0 end-1 flex items-center gap-px">
              {codexStyle ? null : (
                <button
                  aria-label={`Reorder ${project.displayName}`}
                  className="pointer-events-auto inline-flex size-6 cursor-grab items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing group-hover/project-folder:opacity-100 group-focus-within/project-folder:opacity-100"
                  ref={setActivatorNodeRef}
                  type="button"
                  {...attributes}
                  {...listeners}
                >
                  <GripVerticalIcon aria-hidden className="size-3.5" />
                </button>
              )}
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      aria-label={`Actions for ${project.displayName}`}
                      className="pointer-events-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-pointer group-hover/project-folder:opacity-100 group-focus-within/project-folder:opacity-100"
                      type="button"
                    />
                  }
                >
                  <EllipsisIcon aria-hidden className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-52">
                  <MenuItem onClick={() => props.onNewThreadInProject(project)}>
                    <SquarePenIcon />
                    New thread
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      props.onSelectProject(props.selected ? null : project.projectKey)
                    }
                  >
                    <FilterIcon />
                    {props.selected ? "Show all projects" : "Filter to this project"}
                  </MenuItem>
                  <MenuItem onClick={() => props.onOpenProjectSettings(project)}>
                    <SettingsIcon />
                    Project settings
                  </MenuItem>
                  {otherSections.length > 0 || props.sectionId !== null ? (
                    <MenuSub>
                      <MenuSubTrigger>
                        <FolderIcon />
                        Move project to section
                      </MenuSubTrigger>
                      <MenuSubPopup>
                        {otherSections.map((section) => (
                          <MenuItem
                            key={section.id}
                            disabled={!canWrite}
                            onClick={() => props.onMoveProject(project.projectKey, section.id)}
                          >
                            {section.parentId === undefined
                              ? section.name
                              : `${props.sections.find((parent) => parent.id === section.parentId)?.name ?? ""} / ${section.name}`}
                          </MenuItem>
                        ))}
                        {props.sectionId !== null ? (
                          <>
                            <MenuSeparator />
                            <MenuItem
                              disabled={!canWrite}
                              onClick={() => props.onMoveProject(project.projectKey, null)}
                            >
                              Other projects
                            </MenuItem>
                          </>
                        ) : null}
                      </MenuSubPopup>
                    </MenuSub>
                  ) : null}
                  <MenuSeparator />
                  <MenuItem
                    onClick={() => void props.onRemoveProject(project)}
                    variant="destructive"
                  >
                    <Trash2Icon />
                    Remove project
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          ),
        }}
      />
      {props.isProjectExpanded ? (
        <ul
          className={cn(
            codexStyle && "sidebar-columns-container",
            !codexStyle && "ms-5 border-sidebar-border/60 border-s ps-2",
          )}
        >
          {props.threads.map((thread) => (
            <SidebarProjectThreadRow
              key={`${thread.environmentId}:${thread.id}`}
              codexStyle={codexStyle}
              assembly={props.threadRowAssembly}
              rowState={props.threadRowState}
              thread={thread}
              navigationParent={sidebarFolderRowId(project.projectKey)}
              runningSubagentsByParentKey={props.runningSubagentsByParentKey}
              familyBlockText={
                codexStyle
                  ? JSON.stringify(
                      familyBlocks[
                        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                      ] ?? EMPTY_FAMILY_BLOCK,
                    )
                  : undefined
              }
            />
          ))}
          {props.threads.length === 0 ? (
            <li className="fork-sidebar-empty px-2 py-1 text-2xs text-sidebar-muted-foreground/55">
              No threads yet
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
});

function ProjectDragPreview(props: { readonly project: SidebarProjectSnapshot | null }) {
  const folderAppearance = useProjectFolderAppearance(props.project?.projectKey ?? null);
  if (props.project === null) return null;
  return (
    <div className="fork-sidebar-project-preview flex h-7 w-[min(20rem,calc(100vw-2rem))] min-w-0 items-center gap-2 rounded-md border border-sidebar-border bg-sidebar px-2 text-sm text-sidebar-foreground shadow-lg">
      <ProjectFavicon className="size-4 shrink-0" project={props.project} {...folderAppearance} />
      <span className="fork-sidebar-title min-w-0 flex-1 truncate font-medium">
        {props.project.displayName}
      </span>
    </div>
  );
}

/** A zero-height marker, so showing it never shifts the rows around it. */
function ProjectDropLine() {
  return (
    <li aria-hidden className="pointer-events-none relative z-10 h-0 list-none">
      <span className="absolute inset-x-2 -top-px h-0.5 rounded-full bg-primary" />
    </li>
  );
}

const THREAD_STATUS_DOT_CLASS = {
  preparing: "bg-info",
  paused: "bg-warning",
  request: "bg-info",
  approval: "bg-warning",
  failed: "bg-error",
  input: "bg-info",
  ready: "bg-success/70",
  waiting: "bg-info/60",
  limited: "bg-warning/60",
  working: "bg-info",
} as const;

type SidebarFamilyBlock = {
  separators: Array<[string, SidebarFamilySeparator]>;
  /** Keys of threads that carry their location's icon; see `resolveLocationLeads`. */
  leads: string[];
};
const EMPTY_FAMILY_BLOCK: SidebarFamilyBlock = { separators: [], leads: [] };

/**
 * A top-level Projects thread: the shared sidebar row, drawing the compact columns and the
 * thread's work under it. One lease gates the row's own reads and its process query.
 */
const SidebarProjectThreadRow = memo(
  function SidebarProjectThreadRow(props: {
    readonly thread: SidebarThreadSummary;
    /** The project header's tree row. */
    readonly navigationParent: string;
    /** Codex style marks status on the right; otherwise a dot leads the row. */
    readonly codexStyle: boolean;
    readonly assembly: SidebarThreadRowAssembly;
    readonly rowState: SidebarThreadRowState;
    readonly runningSubagentsByParentKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
    /** This row's `SidebarFamilyBlock` as JSON, in Codex style; equal text means equal marks. */
    readonly familyBlockText: string | undefined;
  }) {
    const gt = useGT();
    const { assembly, codexStyle, thread } = props;
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    const threadKey = scopedThreadKey(threadRef);
    const runningSubagents = props.runningSubagentsByParentKey.get(threadKey) ?? NO_THREADS;
    const threadStatus = withChildNeeds(resolveSidebarThreadStatus(thread), runningSubagents);
    const rowProps = sidebarThreadRowProps(assembly, props.rowState, thread, runningSubagents);
    const lease = useSidebarRowSubscriptionLease(rowProps.isActive);
    const {
      status: workStatus,
      workRows,
      workCount,
      processRows,
    } = useSidebarThreadProcesses(
      thread,
      threadStatus,
      describeSidebarBackgroundWork(
        thread.pendingBackgroundTasks,
        codexStyle
          ? runningSubagents
          : flattenRunningSubagents(runningSubagents, props.runningSubagentsByParentKey),
        undefined,
        thread.worktreePath,
      ),
      lease.leaseLiveStatus,
    );
    const status = codexStyle ? workStatus : threadStatus;
    const workerStatus = useSidebarIssueWorkerStatus(thread, status === "ready");
    const workerLabels = useWorkerStatusLabels();
    const workerLabel = workerStatus === null ? undefined : workerLabels[workerStatus];
    // Spawned processes can outlive the rows that list their command (hidden while a run works).
    const hasWork = workCount > 0;
    const { open: workOpen, onToggle: toggleWork } = useSidebarWorkExpansion(
      threadKey,
      codexStyle ? workRows.some((row) => row.kind === "subagent") : hasWork,
    );
    const familyStyle = useClientSettings((settings) => settings.sidebarFamilyStyle);
    const locationStyle = useClientSettings((settings) => settings.sidebarLocationIconStyle);
    const contextDrag = useThreadContextPointerDrag(() => ({
      threads: [threadRef],
      title: thread.title,
    }));
    const providerEntries = assembly.providerEntriesByEnvironment.get(thread.environmentId);
    const provider = sidebarThreadProvider(providerEntries, thread.providerInstanceId);
    const familyBlock: SidebarFamilyBlock | undefined =
      props.familyBlockText === undefined ? undefined : JSON.parse(props.familyBlockText);
    const familySeparators = familyBlock && new Map(familyBlock.separators);
    const locationLeadKeys = familyBlock && new Set(familyBlock.leads);
    const role = sidebarRoleLabel(thread.source);
    const onChildClick = (event: ReactMouseEvent, child: SidebarThreadSummary) =>
      assembly.onThreadClick(event, scopeThreadRef(child.environmentId, child.id));
    const onChildContextMenu = (
      child: SidebarThreadSummary,
      position: { readonly x: number; readonly y: number },
    ) => assembly.onContextMenu(scopeThreadRef(child.environmentId, child.id), position, "mouse");
    const renderColumns = (parts: {
      readonly pin: ReactNode;
      readonly lastVisitedAt: string | undefined;
    }) => {
      // Finished while you were away and not opened since: a green dot where the spinner was.
      const statusMark = resolveSidebarProjectStatusMark(
        thread,
        parts.lastVisitedAt,
        threadStatus,
        status,
      );
      if (!codexStyle) {
        return (
          <>
            {workerLabel === undefined &&
              (status === "paused" ? (
                <ThreadStatusMark status={status} />
              ) : (
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", THREAD_STATUS_DOT_CLASS[status])}
                />
              ))}
            <ThreadLocationIcon thread={thread} tooltip={false} />
            <ThreadRoleIcon thread={thread.source} />
            <span className="min-w-0 flex-1">
              <SidebarProjectThreadName thread={thread}>{thread.title}</SidebarProjectThreadName>
            </span>
            {parts.pin}
            {workerLabel && (
              <span className="shrink-0 text-xs text-muted-foreground">{workerLabel}</span>
            )}
            {workCount > 0 ? (
              <span aria-hidden className="w-8 shrink-0" />
            ) : (
              <SidebarThreadTime thread={thread} status={status} />
            )}
          </>
        );
      }
      const name = (
        <SidebarProjectThreadName thread={thread} badges={false}>
          <SidebarThreadTitle role={role} title={thread.title} />
        </SidebarProjectThreadName>
      );
      return (
        <SidebarThreadColumns
          location={
            locationLeadKeys?.has(threadKey) === false ? undefined : (
              <ThreadLocationIcon thread={thread} tooltip={false} worktreeStyle={locationStyle} />
            )
          }
          role={<ThreadRoleIcon thread={thread.source} />}
          provider={
            <ThreadRelationshipIcon
              driver={provider?.driver}
              provider={provider}
              fallbackIcon={CornerDownRightIcon}
            />
          }
          model={resolveSidebarThreadModelLabel(thread, provider, true, false)}
          effort={sidebarEffortGlyph(provider, thread.modelSelection)}
          name={
            parts.pin === null ? (
              name
            ) : (
              <span className="flex min-w-0 items-center gap-1">
                {name}
                {parts.pin}
              </span>
            )
          }
          badgeKind={sidebarBadgeKind(
            role,
            !!thread.source.linkedIssue,
            thread.pullRequests.length > 0,
          )}
          issue={
            <ThreadIssueBadge
              environmentId={thread.environmentId}
              issue={thread.source.linkedIssue}
            />
          }
          pr={<ThreadPullRequestBadge thread={thread} />}
          time={
            <>
              {workerLabel && <span className="me-1.5">{workerLabel}</span>}
              <SidebarThreadTime thread={thread} status={status} />
            </>
          }
          status={workerLabel === undefined ? <ThreadStatusMark status={statusMark} /> : null}
        />
      );
    };
    const after = (
      <>
        {hasWork && codexStyle ? (
          <SidebarCaretToggle
            open={workOpen}
            count={workCount}
            label={`${workOpen ? "Hide" : "Show"} ${workCount} running ${workCount === 1 ? "item" : "items"}`}
            onToggle={toggleWork}
            className="top-0.5 h-5"
          />
        ) : workCount > 0 ? (
          <button
            type="button"
            aria-expanded={workOpen}
            aria-label={`${workOpen ? "Hide" : "Show"} ${workCount} running background tasks`}
            className="fork-sidebar-work-toggle absolute top-0.5 right-2 flex h-5 w-8 cursor-pointer items-center justify-end gap-0.5 rounded px-0.5 text-3xs text-sidebar-muted-foreground/70 hover:bg-sidebar-row-hover"
            onClick={toggleWork}
          >
            {workCount}
            {workOpen ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
          </button>
        ) : null}
        {hasWork && workOpen && codexStyle ? (
          <div>
            <SidebarSubagentTree
              environmentId={thread.environmentId}
              threadId={thread.id}
              familySeparators={familySeparators}
              rows={workRows}
              processRows={processRows}
              parentTasks={thread.pendingBackgroundTasks}
              runningChildren={runningSubagents}
              providerEntries={providerEntries}
              onChildClick={onChildClick}
              onChildContextMenu={onChildContextMenu}
              runningSubagentsByParentKey={props.runningSubagentsByParentKey}
              locationLeadKeys={locationLeadKeys}
            />
          </div>
        ) : hasWork && workOpen ? (
          <div className="ms-3 border-s border-sidebar-border/60 ps-1">
            <SidebarBackgroundWorkRows
              compact
              environmentId={thread.environmentId}
              threadId={thread.id}
              rows={workRows}
              providerEntries={providerEntries}
              processCount={processRows.count}
              afterTasks={<SidebarProcessGroupRows columns={false} {...processRows} />}
              onChildClick={onChildClick}
              onChildContextMenu={onChildContextMenu}
            />
          </div>
        ) : null}
      </>
    );
    return (
      <SidebarThreadRow
        {...rowProps}
        variant="columns"
        liveLookups={false}
        navigationParent={props.navigationParent}
        variantAction="settle"
        dropVerb={null}
        dragOverPinned={false}
        sweepAction={null}
        snoozeWakeLabelText={null}
        jumpLabel={null}
        columns={{
          render: renderColumns,
          after,
          lease,
          label: sidebarProjectThreadAccessibleName({
            role: codexStyle ? role : undefined,
            title: thread.title,
            issueNumber: thread.source.linkedIssue?.number,
            status: workerLabel ?? (status === "paused" ? gt("Paused") : status),
            links: thread.pullRequests,
          }),
          className: cn(
            "fork-sidebar-thread sidebar-caret-row group/project-thread @container/thread-row flex min-w-0 items-center gap-2 px-2",
            PROJECTS_WORK_ROW_HEIGHT,
            codexStyle ? "sidebar-thread-tint text-xs" : "text-sm",
          ),
          // Codex style: the same white as subagent and shell rows.
          idleClassName: cn(
            codexStyle ? "text-foreground/85" : "text-sidebar-muted-foreground/80",
            "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          ),
          rowProps: {
            // Drag the row onto a chat composer to add the thread as context.
            onPointerDown: contextDrag.onPointerDown,
            onClickCapture: contextDrag.onClickCapture,
          },
          itemProps: {
            className: "fork-sidebar-thread-item relative list-none",
            "data-family-separator": sidebarSeparatorStyle(familySeparators?.get(threadKey)),
            "data-separator-reason": familySeparators?.get(threadKey),
            // A family of threads shares one hue, from its root: a thread with listed
            // descendants, and a subagent listed with its own location away from its parent.
            style:
              codexStyle &&
              familyStyle !== "lines" &&
              (workRows.some((row) => row.kind === "subagent") ||
                thread.lineage.relationshipToParent === "subagent")
                ? ({
                    "--sidebar-group-hue": threadGroupHue(thread.lineage.rootThreadId),
                  } as CSSProperties)
                : undefined,
          },
        }}
      />
    );
  },
  (previous, next) => {
    const key = scopedThreadKey(scopeThreadRef(previous.thread.environmentId, previous.thread.id));
    return (
      previous.thread === next.thread &&
      previous.navigationParent === next.navigationParent &&
      previous.codexStyle === next.codexStyle &&
      previous.assembly === next.assembly &&
      sameSidebarThreadRowState(next.thread, previous.rowState, next.rowState) &&
      previous.familyBlockText === next.familyBlockText &&
      sameSidebarSubagentTree(
        key,
        previous.runningSubagentsByParentKey,
        next.runningSubagentsByParentKey,
      )
    );
  },
);

/** A thread's work rows, each running subagent followed by its own subagents and processes. */
function SidebarSubagentTree(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<BackgroundWorkTaskRow>;
  readonly parentTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  /** The threads behind this level's subagent rows. */
  readonly runningChildren: readonly SidebarThreadSummary[];
  readonly onChildClick: (event: ReactMouseEvent, thread: SidebarThreadSummary) => void;
  readonly onChildContextMenu: (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
  ) => void;
  readonly runningSubagentsByParentKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
  readonly providerEntries: ReadonlyMap<string, SidebarProviderEntry> | undefined;
  readonly locationLeadKeys?: ReadonlySet<string> | undefined;
  readonly depth?: number;
  /** This level's process groups. */
  readonly processRows?: SidebarProcessRows;
  readonly familySeparators?: ReadonlyMap<string, SidebarFamilySeparator> | undefined;
}) {
  const childWork = (row: BackgroundWorkTaskRow) => {
    if (row.kind !== "subagent") return null;
    const child =
      row.child ?? props.runningChildren.find((thread) => thread.id === row.childThreadId);
    if (child === undefined) return null;
    const grandchildren =
      props.runningSubagentsByParentKey.get(
        scopedThreadKey(scopeThreadRef(props.environmentId, child.id)),
      ) ?? NO_THREADS;
    const rows = describeSidebarBackgroundWork(
      pendingBackgroundWorkOfThread(child.id, child.pendingBackgroundTasks, props.parentTasks),
      grandchildren,
      child.id,
      child.worktreePath,
    );
    return { child, grandchildren, rows };
  };
  return (
    <SidebarBackgroundWorkRows
      compact
      columns
      familySeparators={props.familySeparators}
      depth={props.depth ?? 1}
      processCount={props.processRows?.count}
      afterTasks={
        props.processRows ? (
          <SidebarProcessGroupRows columns depth={props.depth ?? 1} {...props.processRows} />
        ) : null
      }
      locationLeadKeys={props.locationLeadKeys}
      environmentId={props.environmentId}
      threadId={props.threadId}
      providerEntries={props.providerEntries}
      onChildClick={props.onChildClick}
      onChildContextMenu={props.onChildContextMenu}
      rows={props.rows}
      renderAgent={(row, render) => {
        const work = childWork(row);
        if (work === null) return render(null);
        const { child, grandchildren, rows } = work;
        return (
          <SidebarSubagentRow
            thread={child}
            status={sidebarSubagentRowStatus(row, grandchildren)}
            render={render}
            familySeparators={props.familySeparators}
            depth={(props.depth ?? 1) + 1}
            environmentId={props.environmentId}
            threadId={child.id}
            rows={rows}
            parentTasks={child.pendingBackgroundTasks}
            runningChildren={grandchildren}
            providerEntries={props.providerEntries}
            onChildClick={props.onChildClick}
            onChildContextMenu={props.onChildContextMenu}
            runningSubagentsByParentKey={props.runningSubagentsByParentKey}
            locationLeadKeys={props.locationLeadKeys}
          />
        );
      }}
    />
  );
}

/**
 * A subagent's row with its work: its tasks, the commands it is running and the processes they
 * spawned (see `useSidebarThreadProcesses`), and its own subagents. The row holds the work's
 * queries, so its caret and count know all of it even while collapsed; its lease runs them only
 * near the viewport.
 */
function SidebarSubagentRow(
  props: Omit<ComponentProps<typeof SidebarSubagentTree>, "processRows"> & {
    readonly thread: SidebarThreadSummary;
    readonly status: SidebarThreadStatus;
    readonly render: (nested: NestedWork | null) => ReactNode;
  },
) {
  const { thread, status: rowStatus, rows, render, ...tree } = props;
  const lease = useSidebarRowSubscriptionLease(false);
  const { status, workRows, workCount, processRows } = useSidebarThreadProcesses(
    thread,
    rowStatus,
    rows,
    lease.leaseLiveStatus,
  );
  const { open, onToggle } = useSidebarWorkExpansion(
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    workRows.some((row) => row.kind === "subagent"),
  );
  return render({
    status,
    ref: lease.rowRef,
    toggle: workCount > 0 ? { count: workCount, open, onToggle } : null,
    children:
      workCount > 0 ? (
        <SidebarSubagentTree {...tree} rows={workRows} processRows={processRows} />
      ) : null,
  });
}

/** What the section name dialog is doing: creating a section or renaming one. */
type ProjectSectionDialogTarget =
  | { readonly kind: "create"; readonly parent?: { readonly id: string; readonly name: string } }
  | { readonly kind: "rename"; readonly id: string; readonly name: string };

/** The section name dialog to mount, and its opener for the sidebar header and section menus. */
export function useProjectSectionDialog() {
  // `id` remounts the dialog per opening so its name field starts fresh; `open` stays separate so
  // the dialog keeps its content while it animates closed.
  const [state, setState] = useState<{
    readonly target: ProjectSectionDialogTarget;
    readonly open: boolean;
    readonly id: number;
  } | null>(null);
  const openSectionDialog = (target: ProjectSectionDialogTarget) => {
    if (useUiStateStore.getState().sidebarDisplaySnapshot !== null) return;
    setState((current) => ({ target, open: true, id: (current?.id ?? 0) + 1 }));
  };
  const sectionDialog = state ? (
    <ProjectSectionDialog
      key={state.id}
      target={state.target}
      open={state.open}
      onOpenChange={(open) => setState((current) => (current ? { ...current, open } : current))}
    />
  ) : null;
  return { sectionDialog, openSectionDialog };
}

/** Creates or renames a sidebar section; `useProjectSectionDialog` mounts it once per opening. */
function ProjectSectionDialog(props: {
  readonly target: ProjectSectionDialogTarget;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { target } = props;
  const gt = useGT();
  const parentId = target.kind === "create" ? (target.parent?.id ?? null) : null;
  const canWrite = useSidebarLayoutPermission(target.kind === "rename" ? target.id : parentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId =
    target.kind === "create" ? (sectionTarget(parentId)?.[0] ?? primaryEnvironmentId) : null;
  const parentFolder = useUiStateStore(
    (store) => store.sidebarProjectSections.find((section) => section.id === parentId)?.folderPath,
  );
  const root = useEnvironmentSettings(
    environmentId ?? EnvironmentId.make("unavailable"),
    (settings) => settings.projectFolderRoot || settings.addProjectBaseDirectory,
  );
  const parentPath =
    target.kind === "create" && target.parent
      ? sectionFolderPath(root, [target.parent.name], parentFolder)
      : root.trim() || null;
  const addSection = useUiStateStore((store) => store.addSidebarProjectSection);
  const renameSection = useUiStateStore((store) => store.renameSidebarProjectSection);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const canCreateProject = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const { canReadFiles, isPending: filesystemAccessPending } =
    useFilesystemReadAccess(environmentId);
  const projects = useProjects();
  const picking = useCommandPaletteStore((store) => store.openIntent?.kind === "pick-folder");
  const [name, setName] = useState(target.kind === "rename" ? target.name : "");
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [checkedPaths, setCheckedPaths] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const readFolders = (path: string | null) =>
    props.open && environmentId && canReadFiles && path
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: getAddProjectInitialQuery(path) },
        })
      : null;
  const parentFolders = useEnvironmentQuery(readFolders(pickedPath ? null : parentPath));
  const folderLookupPending =
    environmentId !== null &&
    !pickedPath &&
    parentPath !== null &&
    (filesystemAccessPending || parentFolders.isPending);
  const suggestion = suggestSectionFolder(
    name,
    parentFolders.data?.entries ?? [],
    folderLookupPending,
  );
  const canSubmit = canWrite && !busy && suggestion !== "pending" && name.trim().length > 0;
  const folderPath = pickedPath ?? (suggestion === "pending" ? undefined : suggestion?.fullPath);
  const subfolders = useEnvironmentQuery(readFolders(folderPath ?? null));
  const candidates = canCreateProject
    ? sectionProjectCandidates(
        subfolders.data?.entries ?? [],
        projects
          .filter((project) => project.environmentId === environmentId)
          .map((project) => project.workspaceRoot),
      )
    : [];

  const browse = () => {
    if (!environmentId) return;
    dispatchCommandPalette({
      _tag: "OpenFolderPicker",
      intent: {
        kind: "pick-folder",
        environmentId,
        query: getAddProjectInitialQuery(folderPath ?? parentPath),
        onPick: (path) => {
          setPickedPath(path);
          setCheckedPaths([]);
          setName((current) =>
            current.trim() ? current : (folderSubsectionInput(path)?.name ?? path.slice(0, 80)),
          );
        },
      },
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const trimmed = name.trim();
    if (target.kind === "rename") {
      renameSection(target.id, trimmed);
      props.onOpenChange(false);
      return;
    }
    if (environmentId === null) return;
    setBusy(true);
    const id = await addSection(trimmed, target.parent?.id, folderPath);
    if (id === null) {
      setBusy(false);
      toastManager.add({ type: "error", title: gt("Couldn't save the project section") });
      return;
    }
    const selected = candidates.filter((folder) => checkedPaths.includes(folder.fullPath));
    if (selected.length > 0) {
      const sectionId = sidebarSectionKey(environmentId, id);
      const failed: string[] = [];
      for (const folder of selected) {
        const placement = sectionPlacementInput(environmentId, sectionId);
        if (placement === null) {
          failed.push(folder.name);
          continue;
        }
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            ...placement,
            projectId,
            title: folder.name,
            workspaceRoot: folder.fullPath,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Success") {
          completeProjectSectionPlacement(scopeProjectRef(environmentId, projectId), sectionId);
        } else {
          failed.push(folder.name);
        }
      }
      if (failed.length > 0) {
        toastManager.add({
          type: "error",
          title: gt("Couldn't add these folders as projects"),
          description: failed.join(", "),
        });
      }
    }
    props.onOpenChange(false);
    setBusy(false);
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!busy && !picking) props.onOpenChange(open);
      }}
      open={props.open && !picking}
    >
      <DialogPopup className="max-w-md">
        <form className="flex min-h-0 flex-col" onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>
              {target.kind === "rename"
                ? "Rename project section"
                : target.parent
                  ? `New subsection in ${target.parent.name}`
                  : "Create project section"}
            </DialogTitle>
            <DialogDescription>
              Group projects in the sidebar without changing their T3 project settings.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  aria-label="Project section name"
                  autoFocus
                  disabled={busy}
                  maxLength={80}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (!pickedPath) setCheckedPaths([]);
                  }}
                  placeholder="e.g. Work"
                  value={name}
                />
              </div>
              {target.kind === "create" ? (
                <Button
                  disabled={!canWrite || !canReadFiles || busy}
                  onClick={browse}
                  type="button"
                  variant="outline"
                >
                  {gt("Browse")}
                </Button>
              ) : null}
            </div>
            {folderPath ? (
              <p className="break-all text-xs text-muted-foreground">
                {gt("Uses existing folder {path}", { path: folderPath })}
              </p>
            ) : null}
            {candidates.length > 0 ? (
              <fieldset
                disabled={busy}
                className="flex max-h-48 min-w-0 flex-col gap-2 overflow-y-auto"
              >
                <legend className="mb-2 text-sm font-medium">
                  {gt("Add subfolders as projects")}
                </legend>
                {candidates.map((folder) => (
                  <label key={folder.fullPath} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={checkedPaths.includes(folder.fullPath)}
                      onCheckedChange={(checked) =>
                        setCheckedPaths((paths) =>
                          checked
                            ? [...paths, folder.fullPath]
                            : paths.filter((path) => path !== folder.fullPath),
                        )
                      }
                    />
                    <span className="break-all">{folder.name}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={() => props.onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={!canSubmit} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export { SidebarProjectSections };
