import { sidebarSectionChildOrder } from "@t3tools/shared/sidebarLayout";
import { useSidebarWorkExpansion } from "./useSidebarWorkExpansion";
import {
  collectDisplayedFamilyRows,
  resolveSidebarFamilySeparators,
  sidebarSeparatorStyle,
  type SidebarFamilySeparator,
} from "./SidebarFamilySeparators.logic";
import { useEnvironmentProviders } from "../../state/environments";
import { ForkSidebarTextSizes } from "./ForkSidebarTextSizes";
import { sectionTarget, useProjectSectionPlacementReady } from "../../projectSectionPlacement";
import { useSidebarLayoutPermission } from "../../hooks/useSidebarLayoutPermission";
import {
  formatModelSelectionEffort,
  shortModelSelectionEffort,
} from "@t3tools/client-runtime/state/thread-execution";
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
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
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
  SidebarProjectThreadTooltip,
} from "./SidebarProjectThreadTooltip";
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
  sameSidebarSubagentTree,
  sidebarThreadTitle,
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

import { type EnvironmentId, type ProjectIconColor, type ThreadId } from "@t3tools/contracts";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import {
  inheritedSectionFolderAppearance,
  useProjectFolderAppearance,
} from "../../projectFolderAppearance";
import { openCommandPalette } from "../../commandPaletteBus";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { type SidebarProjectSection, useUiStateStore } from "../../uiStateStore";
import { cn } from "~/lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import {
  flattenRunningSubagents,
  resolveLocationLeads,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
  withChildNeeds,
} from "../Sidebar.logic";
import { ThreadStatusMark } from "../ThreadStatusMark";
import { Button } from "../ui/button";
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
import { NewSectionProjectDialog, type NewSectionProjectTarget } from "./NewSectionProjectDialog";
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
  /** Opens the section name dialog, which the sidebar owns so its header can create sections. */
  readonly onNewSection: () => void;
  readonly onNewSubsection: (parent: { readonly id: string; readonly name: string }) => void;
  readonly onRenameSection: (section: { readonly id: string; readonly name: string }) => void;
  readonly onOpenProjectSettings: (project: SidebarProjectSnapshot) => void;
  readonly onNewThreadInProject: (project: SidebarProjectSnapshot) => void;
  readonly onRemoveProject: (project: SidebarProjectSnapshot) => void;
  readonly threadsByProjectKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
  /** Running subagent threads by parent thread key; see `groupRunningSubagentsByParent`. */
  readonly runningSubagentsByParentKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
  readonly isProjectExpanded: (projectKey: string) => boolean;
  readonly onToggleProject: (projectKey: string, expanded: boolean) => void;
  readonly activeThreadKey: string | null;
  readonly onThreadClick: (event: ReactMouseEvent, thread: SidebarThreadSummary) => void;
  readonly onThreadContextMenu: (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
  ) => void;
}

function SidebarProjectSections(props: SidebarProjectSectionsProps) {
  const {
    activeThreadKey,
    isProjectExpanded,
    onAddProject,
    onNewSection,
    onNewSubsection,
    onRenameSection,
    onNewThreadInProject,
    onOpenProjectSettings,
    onRemoveProject,
    onSelectProject,
    onThreadClick,
    onThreadContextMenu,
    onToggleProject,
    projects,
    sections,
    selectedProjectKey,
    runningSubagentsByParentKey,
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
    if (section.custom) onRenameSection(section);
  };

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
              onClick={onNewSection}
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
        <ul className="flex min-w-0 flex-col gap-px">
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
                  onNewSubsection={onNewSubsection}
                  onNewProjectInSection={openNewProjectDialog}
                  onResetIcons={resetSectionIcons}
                  onDelete={deleteSection}
                  onMoveProject={moveProject}
                  onNewThreadInProject={onNewThreadInProject}
                  onOpenProjectSettings={onOpenProjectSettings}
                  onRemoveProject={onRemoveProject}
                  onOpenRename={openRenameDialog}
                  onSelectProject={onSelectProject}
                  onSetExpanded={setSectionExpanded}
                  activeThreadKey={activeThreadKey}
                  isProjectExpanded={isProjectExpanded}
                  onThreadClick={onThreadClick}
                  onThreadContextMenu={onThreadContextMenu}
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
  readonly onRemoveProject: (project: SidebarProjectSnapshot) => void;
  readonly onOpenRename: (section: SidebarProjectSectionRender) => void;
  readonly onDelete: (sectionId: string) => void;
  readonly onSetExpanded: (sectionId: string, expanded: boolean) => void;
  readonly onMoveProject: (projectKey: string, sectionId: string | null) => void;
  readonly activeThreadKey: string | null;
  readonly isProjectExpanded: (projectKey: string) => boolean;
  readonly onToggleProject: (projectKey: string, expanded: boolean) => void;
  readonly onThreadClick: (event: ReactMouseEvent, thread: SidebarThreadSummary) => void;
  readonly onThreadContextMenu: (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
  ) => void;
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
      className={cn("group/section rounded-md", highlighted && "bg-sidebar-row-selected/60")}
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
                    onOpenProjectSettings={props.onOpenProjectSettings}
                    onRemoveProject={props.onRemoveProject}
                    onSelectProject={props.onSelectProject}
                    activeThreadKey={props.activeThreadKey}
                    isProjectExpanded={props.isProjectExpanded(project.projectKey)}
                    onThreadClick={props.onThreadClick}
                    onThreadContextMenu={props.onThreadContextMenu}
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
        aria-expanded={expanded}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center rounded-md px-1 text-left font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          // Codex style sets sections apart from the project rows under them: a small uppercase label.
          codexStyle ? "gap-2 text-2xs font-semibold uppercase tracking-wide" : "gap-1.5 text-xs",
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
  readonly onRemoveProject: (project: SidebarProjectSnapshot) => void;
  readonly onMoveProject: (projectKey: string, sectionId: string | null) => void;
  readonly isProjectExpanded: boolean;
  readonly onToggleProject: (projectKey: string, expanded: boolean) => void;
  readonly activeThreadKey: string | null;
  readonly onThreadClick: (event: ReactMouseEvent, thread: SidebarThreadSummary) => void;
  readonly onThreadContextMenu: (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
  ) => void;
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
  // Selecting this project's lines as text, not the whole expansion record, re-renders the
  // project and its rows only when its own lines change.
  const familySeparatorsText = useUiStateStore((state) =>
    codexStyle && familyStyle === "lines" && props.isProjectExpanded
      ? JSON.stringify([
          ...resolveSidebarFamilySeparators(
            collectDisplayedFamilyRows({
              ...props,
              expandedByKey: state.sidebarWorkExpandedById,
            }),
          ),
        ])
      : "",
  );
  const familySeparatorEntries: Array<[string, SidebarFamilySeparator]> =
    familySeparatorsText === "" ? [] : JSON.parse(familySeparatorsText);
  const familySeparators =
    familySeparatorsText === "" ? undefined : new Map(familySeparatorEntries);
  // Only the displayed lead keys subscribe this project to expansion changes.
  const leadKeyList = useUiStateStore((state) => {
    if (!codexStyle || !props.isProjectExpanded) return "";
    const rows = collectDisplayedFamilyRows({
      ...props,
      expandedByKey: state.sidebarWorkExpandedById,
    });
    return [
      ...resolveLocationLeads(
        rows.flatMap(({ thread, topLevel }) => (thread === null ? [] : [{ thread, topLevel }])),
      ).values(),
    ]
      .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
      .join("\n");
  });
  const locationLeadKeys = codexStyle ? new Set(leadKeyList.split("\n")) : undefined;

  return (
    // Rows stay put while dragging; the drop line shows where this one lands.
    <li ref={setNodeRef} className={cn("relative rounded-md", isDragging && "opacity-40")}>
      <div className="group/project-row relative">
        {/* Codex style drags the whole row; otherwise the grip button is the handle. */}
        <button
          type="button"
          {...(codexStyle ? { ...attributes, ...listeners } : {})}
          ref={codexStyle ? setActivatorNodeRef : undefined}
          disabled={!canWrite}
          aria-expanded={props.isProjectExpanded}
          className={cn(
            "fork-sidebar-project flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            // Codex style makes room for the actions menu only while it shows.
            codexStyle
              ? "group-hover/project-row:pe-8 group-focus-within/project-row:pe-8"
              : "pe-12",
            props.selected && "bg-sidebar-row-selected text-sidebar-foreground",
          )}
          onClick={() => {
            if (canWrite) props.onToggleProject(project.projectKey, !props.isProjectExpanded);
          }}
        >
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
          <span className={cn("fork-sidebar-title min-w-0 truncate", !codexStyle && "flex-1")}>
            {project.displayName}
          </span>
          {codexStyle ? (
            <SidebarCaretSlot open={props.isProjectExpanded} className="text-icon-muted" />
          ) : null}
          {codexStyle ? (
            <SidebarTrailingColumns
              count={
                props.isProjectExpanded
                  ? undefined
                  : props.threads.length > 0
                    ? props.threads.length
                    : project.groupedProjectCount > 1
                      ? project.groupedProjectCount
                      : undefined
              }
            />
          ) : props.threads.length > 0 ? (
            <span className="shrink-0 text-2xs text-sidebar-muted-foreground/55">
              {props.threads.length}
            </span>
          ) : project.groupedProjectCount > 1 ? (
            <span className="shrink-0 text-2xs text-sidebar-muted-foreground/55">
              {project.groupedProjectCount}
            </span>
          ) : null}
        </button>
        <div className="pointer-events-none absolute inset-y-0 end-1 flex items-center gap-px">
          {codexStyle ? null : (
            <button
              aria-label={`Reorder ${project.displayName}`}
              className="pointer-events-auto inline-flex size-6 cursor-grab items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100"
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
                  className="pointer-events-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-pointer group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100"
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
                onClick={() => props.onSelectProject(props.selected ? null : project.projectKey)}
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
              <MenuItem onClick={() => props.onRemoveProject(project)} variant="destructive">
                <Trash2Icon />
                Remove project
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
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
              activeThreadKey={props.activeThreadKey}
              onClick={props.onThreadClick}
              onContextMenu={props.onThreadContextMenu}
              thread={thread}
              runningSubagentsByParentKey={props.runningSubagentsByParentKey}
              locationLeadKeys={locationLeadKeys}
              familySeparators={familySeparators}
              familySeparatorsText={familySeparatorsText}
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
  approval: "bg-warning",
  failed: "bg-error",
  input: "bg-info",
  ready: "bg-success/70",
  waiting: "bg-info/60",
  limited: "bg-warning/60",
  working: "bg-info",
} as const;

const SidebarProjectThreadRow = memo(
  function SidebarProjectThreadRow(props: {
    readonly thread: SidebarThreadSummary;
    /** Codex style marks status on the right; otherwise a dot leads the row. */
    readonly codexStyle: boolean;
    readonly activeThreadKey: string | null;
    readonly onClick: (event: ReactMouseEvent, thread: SidebarThreadSummary) => void;
    readonly onContextMenu: (
      thread: SidebarThreadSummary,
      position: { x: number; y: number },
    ) => void;
    readonly runningSubagentsByParentKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
    /** Threads that carry their location's icon; see `resolveLocationLeads`. */
    readonly locationLeadKeys?: ReadonlySet<string> | undefined;
    readonly familySeparators?: ReadonlyMap<string, SidebarFamilySeparator> | undefined;
    /** The project's separators as JSON; equal text means an equal map. */
    readonly familySeparatorsText?: string | undefined;
  }) {
    const activeThreadKey = scopedThreadKey(
      scopeThreadRef(props.thread.environmentId, props.thread.id),
    );
    const runningSubagents = props.runningSubagentsByParentKey.get(activeThreadKey) ?? NO_THREADS;
    const threadStatus = withChildNeeds(resolveSidebarThreadStatus(props.thread), runningSubagents);
    const active = props.activeThreadKey === activeThreadKey;
    const selected = useThreadSelectionStore((store) =>
      store.selectedThreadKeys.has(activeThreadKey),
    );
    const localLastVisitedAt = useUiStateStore(
      (state) => state.threadLastVisitedAtById[activeThreadKey],
    );
    const {
      status: workStatus,
      watchRow,
      workRows,
      workCount,
      processRows,
    } = useSidebarThreadProcesses(
      props.thread,
      threadStatus,
      describeSidebarBackgroundWork(
        props.thread.pendingBackgroundTasks,
        props.codexStyle
          ? runningSubagents
          : flattenRunningSubagents(runningSubagents, props.runningSubagentsByParentKey),
        undefined,
      ),
    );
    // Finished while you were away and not opened since: a green dot where the spinner was.
    const status = props.codexStyle ? workStatus : threadStatus;
    const statusMark = resolveSidebarProjectStatusMark(
      props.thread,
      localLastVisitedAt,
      threadStatus,
      status,
    );
    // Spawned processes can outlive the rows that list their command (hidden while a run works).
    const hasWork = workCount > 0;
    const { open: workOpen, onToggle: toggleWork } = useSidebarWorkExpansion(
      activeThreadKey,
      props.codexStyle ? workRows.some((row) => row.kind === "subagent") : hasWork,
    );
    const familyStyle = useClientSettings((settings) => settings.sidebarFamilyStyle);
    const locationStyle = useClientSettings((settings) => settings.sidebarLocationIconStyle);
    const contextDrag = useThreadContextPointerDrag(() => ({
      threads: [scopeThreadRef(props.thread.environmentId, props.thread.id)],
      title: props.thread.title,
    }));
    const provider = useEnvironmentProviders()
      .get(props.thread.environmentId)
      ?.find((entry) => entry.instanceId === props.thread.providerInstanceId);
    return (
      <li
        className="fork-sidebar-thread-item relative list-none"
        data-family-separator={sidebarSeparatorStyle(props.familySeparators?.get(activeThreadKey))}
        data-separator-reason={props.familySeparators?.get(activeThreadKey)}
        // A family of threads shares one hue, from its root: a thread with listed descendants, and a
        // subagent listed with its own location away from its parent.
        style={
          props.codexStyle &&
          familyStyle !== "lines" &&
          (workRows.some((row) => row.kind === "subagent") ||
            props.thread.lineage.relationshipToParent === "subagent")
            ? ({
                "--sidebar-group-hue": threadGroupHue(props.thread.lineage.rootThreadId),
              } as CSSProperties)
            : undefined
        }
        data-thread-item={activeThreadKey}
        data-sidebar-thread-key={activeThreadKey}
        ref={watchRow}
      >
        <SidebarProjectThreadTooltip
          thread={props.thread}
          provider={provider}
          render={
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              aria-label={sidebarProjectThreadAccessibleName({
                role: props.codexStyle ? sidebarThreadTitle(props.thread.source) : undefined,
                title: props.thread.title,
                issueNumber: props.thread.source.linkedIssue?.number,
                status,
                links: props.thread.pullRequests,
              })}
              className={cn(
                "fork-sidebar-thread group/project-thread @container/thread-row flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none transition-colors",
                PROJECTS_WORK_ROW_HEIGHT,
                props.codexStyle ? "sidebar-thread-tint text-xs" : "text-sm",
                active
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : selected
                    ? "bg-sidebar-row-selected text-sidebar-foreground"
                    : cn(
                        // Codex style: the same white as subagent and shell rows, not only when selected.
                        props.codexStyle
                          ? "text-foreground/85"
                          : "text-sidebar-muted-foreground/80",
                        "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                      ),
              )}
              onClick={(event) => props.onClick(event, props.thread)}
              // Drag the row onto a chat composer to add the thread as context.
              onPointerDown={contextDrag.onPointerDown}
              onClickCapture={contextDrag.onClickCapture}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(props.thread, { x: event.clientX, y: event.clientY });
              }}
            >
              {props.codexStyle ? (
                <SidebarThreadColumns
                  location={
                    props.locationLeadKeys?.has(activeThreadKey) === false ? undefined : (
                      <ThreadLocationIcon
                        thread={props.thread}
                        tooltip={false}
                        worktreeStyle={locationStyle}
                      />
                    )
                  }
                  role={<ThreadRoleIcon thread={props.thread.source} />}
                  provider={
                    <ThreadRelationshipIcon
                      driver={provider?.driver}
                      provider={provider}
                      fallbackIcon={CornerDownRightIcon}
                    />
                  }
                  model={resolveSidebarThreadModelLabel(props.thread, provider, true, false)}
                  effort={shortModelSelectionEffort(
                    formatModelSelectionEffort(props.thread.modelSelection, provider?.models),
                  )}
                  name={
                    <SidebarProjectThreadName thread={props.thread} badges={false}>
                      <span className="sidebar-role-title">
                        {sidebarThreadTitle(props.thread.source)}
                      </span>
                    </SidebarProjectThreadName>
                  }
                  count={workCount > 0 && !workOpen ? workCount : undefined}
                  issue={
                    <ThreadIssueBadge
                      environmentId={props.thread.environmentId}
                      issue={props.thread.source.linkedIssue}
                    />
                  }
                  pr={<ThreadPullRequestBadge thread={props.thread} />}
                  time={<SidebarThreadTime thread={props.thread} status={status} />}
                  status={<ThreadStatusMark status={statusMark} />}
                />
              ) : (
                <>
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      THREAD_STATUS_DOT_CLASS[status],
                    )}
                  />
                  <ThreadLocationIcon thread={props.thread} tooltip={false} />
                  <ThreadRoleIcon thread={props.thread.source} />
                  <span className="min-w-0 flex-1">
                    <SidebarProjectThreadName thread={props.thread}>
                      {props.thread.title}
                    </SidebarProjectThreadName>
                  </span>
                  {workCount > 0 ? (
                    <span aria-hidden className="w-8 shrink-0" />
                  ) : (
                    <SidebarThreadTime thread={props.thread} status={status} />
                  )}
                </>
              )}
            </button>
          }
        />
        {hasWork && props.codexStyle ? (
          <SidebarCaretToggle
            open={workOpen}
            label={`${workOpen ? "Hide" : "Show"} running work`}
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
        {hasWork && workOpen && props.codexStyle ? (
          <div>
            <SidebarSubagentTree
              environmentId={props.thread.environmentId}
              threadId={props.thread.id}
              familySeparators={props.familySeparators}
              rows={workRows}
              processRows={processRows}
              parentTasks={props.thread.pendingBackgroundTasks}
              runningChildren={runningSubagents}
              onChildClick={props.onClick}
              onChildContextMenu={props.onContextMenu}
              runningSubagentsByParentKey={props.runningSubagentsByParentKey}
              locationLeadKeys={props.locationLeadKeys}
            />
          </div>
        ) : hasWork && workOpen ? (
          <div className="ms-3 border-s border-sidebar-border/60 ps-1">
            <SidebarBackgroundWorkRows
              compact
              environmentId={props.thread.environmentId}
              threadId={props.thread.id}
              rows={workRows}
              processCount={processRows.count}
              afterTasks={<SidebarProcessGroupRows columns={false} {...processRows} />}
              onChildClick={props.onClick}
              onChildContextMenu={props.onContextMenu}
            />
          </div>
        ) : null}
      </li>
    );
  },
  (previous, next) => {
    const key = scopedThreadKey(scopeThreadRef(previous.thread.environmentId, previous.thread.id));
    return (
      previous.thread === next.thread &&
      previous.codexStyle === next.codexStyle &&
      (previous.activeThreadKey === key) === (next.activeThreadKey === key) &&
      previous.onClick === next.onClick &&
      previous.onContextMenu === next.onContextMenu &&
      previous.locationLeadKeys === next.locationLeadKeys &&
      previous.familySeparatorsText === next.familySeparatorsText &&
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
 * queries, so its caret and count know all of it even while collapsed.
 */
function SidebarSubagentRow(
  props: Omit<ComponentProps<typeof SidebarSubagentTree>, "processRows"> & {
    readonly thread: SidebarThreadSummary;
    readonly status: SidebarThreadStatus;
    readonly render: (nested: NestedWork | null) => ReactNode;
  },
) {
  const { thread, status: rowStatus, rows, render, ...tree } = props;
  const { status, watchRow, workRows, workCount, processRows } = useSidebarThreadProcesses(
    thread,
    rowStatus,
    rows,
  );
  const { open, onToggle } = useSidebarWorkExpansion(
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    workRows.some((row) => row.kind === "subagent"),
  );
  return render({
    status,
    ref: watchRow,
    toggle: workCount > 0 ? { count: workCount, open, onToggle } : null,
    children:
      workCount > 0 ? (
        <SidebarSubagentTree {...tree} rows={workRows} processRows={processRows} />
      ) : null,
  });
}

/** What the section name dialog is doing: creating a section or renaming one. */
export type ProjectSectionDialogTarget =
  | { readonly kind: "create"; readonly parent?: { readonly id: string; readonly name: string } }
  | { readonly kind: "rename"; readonly id: string; readonly name: string };

/**
 * Creates or renames a sidebar section. Mount it with a fresh `key` for each opening so the name
 * field starts from the target's current name.
 */
export function ProjectSectionDialog(props: {
  readonly target: ProjectSectionDialogTarget;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { target } = props;
  const canWrite = useSidebarLayoutPermission(
    target.kind === "rename" ? target.id : (target.parent?.id ?? null),
  );
  const addSection = useUiStateStore((store) => store.addSidebarProjectSection);
  const renameSection = useUiStateStore((store) => store.renameSidebarProjectSection);
  const [name, setName] = useState(target.kind === "rename" ? target.name : "");
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !canWrite) return;
    if (target.kind === "create") addSection(trimmed, target.parent?.id);
    else renameSection(target.id, trimmed);
    props.onOpenChange(false);
  };
  return (
    <Dialog onOpenChange={props.onOpenChange} open={props.open}>
      <DialogPopup className="max-w-md">
        <form onSubmit={handleSubmit}>
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
            <Input
              aria-label="Project section name"
              autoFocus
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Work"
              value={name}
            />
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => props.onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!canWrite || name.trim().length === 0} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export { SidebarProjectSections };
