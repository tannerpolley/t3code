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
import { BackgroundWorkTaskList } from "../chat/BackgroundWorkTaskList";
import { describeSidebarBackgroundWork } from "../chat/BackgroundWorkTaskList.logic";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import type { ProjectIconColor } from "@t3tools/contracts";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import { openCommandPalette } from "../../commandPaletteBus";
import {
  resolveProjectPlacements,
  useProjectSectionPlacements,
} from "../../projectSectionPlacement";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { type SidebarProjectSection, useUiStateStore } from "../../uiStateStore";
import { cn } from "~/lib/utils";
import { useClientSettings, usePrimarySettings } from "../../hooks/useSettings";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  withChildNeeds,
  resolveThreadLastVisitedAt,
  type SidebarThreadStatus,
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
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { ProjectFavicon } from "../ProjectFavicon";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { NewSectionProjectDialog, type NewSectionProjectTarget } from "./NewSectionProjectDialog";
import {
  resolveProjectDrop,
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
  return { type: "section", sectionId: data.sectionId ?? UNGROUPED_SECTION_ID };
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
  const reorderSections = useUiStateStore((store) => store.reorderSidebarProjectSections);
  const [activeProjectKey, setActiveProjectKey] = useState<string | null>(null);
  const [projectDrop, setProjectDrop] = useState<ProjectDrop | null>(null);
  // `id` remounts the dialog per opening so its form starts empty.
  const [newProjectDialog, setNewProjectDialog] = useState<{
    readonly target: NewSectionProjectTarget;
    readonly open: boolean;
    readonly id: number;
  } | null>(null);
  const openNewProjectDialog = useCallback(
    (section: {
      readonly id: string;
      readonly name: string;
      readonly parentId: string | undefined;
    }) => {
      const parentName =
        section.parentId === undefined
          ? undefined
          : sections.find((candidate) => candidate.id === section.parentId)?.name;
      setNewProjectDialog((current) => ({
        target: { sectionId: section.id, sectionName: section.name, parentName },
        open: true,
        id: (current?.id ?? 0) + 1,
      }));
    },
    [sections],
  );
  // Unsorted projects under the folder root join their folder's section on their own. The store
  // leaves state untouched when nothing moves, so this settles after one pass.
  const autoOrganize = useClientSettings((settings) => settings.autoOrganizeByFolder);
  const folderRoot = usePrimarySettings(
    (settings) => settings.projectFolderRoot || settings.addProjectBaseDirectory,
  );
  const organizeByFolder = useUiStateStore((store) => store.organizeSidebarSectionsByFolder);
  useEffect(() => {
    if (!autoOrganize || !folderRoot.startsWith("/")) return;
    organizeByFolder(
      projects.map((project) => ({
        projectKey: project.projectKey,
        workspaceRoots: project.memberProjects.map((member) => member.workspaceRoot),
      })),
      folderRoot,
      true,
    );
  }, [autoOrganize, folderRoot, organizeByFolder, projects]);
  const placements = useProjectSectionPlacements((store) => store.placements);
  const resolvePlacement = useProjectSectionPlacements((store) => store.resolve);

  // A project added from a section's Add project joins it as soon as it appears, and again if
  // its key changes before its repository identity settles.
  useEffect(() => {
    const { moves, resolved } = resolveProjectPlacements({
      placements,
      projects,
      sections,
      now: Date.now(),
    });
    for (const move of moves) moveProject(move.projectKey, move.sectionId);
    for (const refKey of resolved) resolvePlacement(refKey);
  }, [moveProject, placements, projects, resolvePlacement, sections]);

  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [project.projectKey, project] as const)),
    [projects],
  );
  const renderedSections = useMemo<SidebarProjectSectionRender[]>(() => {
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
      next.push({
        id: section.id,
        name: section.name,
        projectKeys,
        collapsed: section.collapsed,
        custom: true,
        color: section.color ?? parent?.color,
        ownColor: section.color,
        folderIcons: section.folderIcons === true || parent?.folderIcons === true,
        ownFolderIcons: section.folderIcons === true,
        parentId: section.parentId,
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
  }, [otherProjectsExpanded, projectByKey, projects, sections]);

  // Clears custom icons the same way the icon picker's Automatic choice does, on every checkout
  // of every project in the section and its subsections.
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const resetSectionIcons = useCallback(
    async (section: SidebarProjectSectionRender) => {
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
    },
    [projectByKey, renderedSections, updateProject],
  );

  const setSectionExpanded = useCallback(
    (sectionId: string, expanded: boolean) => {
      if (sectionId === UNGROUPED_SECTION_ID) {
        setOtherProjectsExpanded(expanded);
        return;
      }
      setCustomSectionExpanded(sectionId, expanded);
    },
    [setCustomSectionExpanded, setOtherProjectsExpanded],
  );

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
  const collisionDetection = useCallback<CollisionDetection>((args) => {
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
  }, []);

  const openRenameDialog = useCallback(
    (section: SidebarProjectSectionRender) => {
      if (section.custom) onRenameSection(section);
    },
    [onRenameSection],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const activeData = event.active.data.current as SidebarProjectDragData | undefined;
    setActiveProjectKey(activeData?.type === "project" ? String(event.active.id) : null);
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const activeData = event.active.data.current as SidebarProjectDragData | undefined;
      const over = projectDropOverOf(event.over);
      setProjectDrop(
        activeData?.type === "project" && over
          ? resolveProjectDrop({
              projectKey: String(event.active.id),
              over,
              sections: renderedSections,
            })
          : null,
      );
    },
    [renderedSections],
  );

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    setActiveProjectKey(null);
    setProjectDrop(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveProjectKey(null);
      setProjectDrop(null);
      const activeData = event.active.data.current as SidebarProjectDragData | undefined;
      const overData = event.over?.data.current as SidebarProjectDragData | undefined;
      if (!activeData || !event.over) return;

      if (activeData.type === "section") {
        const targetSectionId = sectionIdFromDragData(overData);
        if (
          targetSectionId === null ||
          targetSectionId === undefined ||
          targetSectionId === activeData.sectionId
        ) {
          return;
        }
        const currentIds = sections.map((section) => section.id);
        const fromIndex = currentIds.indexOf(activeData.sectionId);
        const toIndex = currentIds.indexOf(targetSectionId);
        if (fromIndex >= 0 && toIndex >= 0) {
          reorderSections(arrayMove(currentIds, fromIndex, toIndex));
        }
        return;
      }

      if (activeData.type !== "project") return;
      const projectKey = String(event.active.id);
      const over = projectDropOverOf(event.over);
      const drop = over
        ? resolveProjectDrop({ projectKey, over, sections: renderedSections })
        : null;
      if (drop === null) return;
      if (drop.projectKeys === null) {
        moveProject(projectKey, null);
        return;
      }
      if (activeData.sectionId !== drop.sectionId) moveProject(projectKey, drop.sectionId);
      reorderSectionProjects(drop.sectionId, [...drop.projectKeys]);
    },
    [moveProject, reorderSectionProjects, reorderSections, renderedSections, sections],
  );

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden px-1 py-1">
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
        <SidebarMenu className="gap-px">
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
        </SidebarMenu>
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
    </SidebarGroup>
  );
}

const ProjectSection = memo(function ProjectSection(props: {
  readonly section: SidebarProjectSectionRender;
  readonly codexStyle: boolean;
  readonly folderColors: boolean;
  /** Where a dragged project would land; this section shows it when it is the target. */
  readonly projectDrop: ProjectDrop | null;
  /** Rendered inside this section, before its projects; empty for subsections themselves. */
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
  const { setNodeRef: setDropRef } = useDroppable({
    data: {
      type: "section-container",
      sectionId: props.section.custom ? props.section.id : null,
    } satisfies SectionContainerDragData,
    id: sectionContainerId(props.section.id),
  });
  const expanded = !props.section.collapsed;
  const sectionProjectKeys = expanded ? props.section.projectKeys : [];
  const drop = props.projectDrop?.sectionId === props.section.id ? props.projectDrop : null;
  // A line marks the landing spot; a section with no visible order highlights instead.
  const highlighted = drop !== null && (drop.beforeKey === undefined || !expanded);
  const isSubsection = props.section.parentId !== undefined;

  return (
    <li
      ref={setDropRef}
      className={cn(
        "group/section rounded-md",
        // The original look already indents under a guide line; Codex style indents subsections.
        isSubsection && props.codexStyle && "ms-3",
        highlighted && "bg-sidebar-row-selected/60",
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
      {expanded ? (
        <ul
          className={props.codexStyle ? undefined : "ms-3 border-sidebar-border/60 border-s ps-1"}
        >
          {props.subsections.map((subsection) => (
            <ProjectSection key={subsection.id} {...props} section={subsection} subsections={[]} />
          ))}
          <SortableContext items={[...sectionProjectKeys]} strategy={verticalListSortingStrategy}>
            {sectionProjectKeys.map((projectKey) => {
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
                    folderColor={props.folderColors ? props.section.color : undefined}
                    forceFolder={props.section.folderIcons}
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
            <li className="px-2 py-1 text-[11px] text-sidebar-muted-foreground/55">
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
  const setSectionColor = useUiStateStore((store) => store.setSidebarProjectSectionColor);
  const setSectionFolderIcons = useUiStateStore(
    (store) => store.setSidebarProjectSectionFolderIcons,
  );
  const sortable = useSortable({
    data: {
      type: "section",
      sectionId: section.id,
    } satisfies SectionDragData,
    // Only top-level sections reorder; subsections keep the order they were made in.
    disabled: !section.custom || section.parentId !== undefined,
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
  const draggable = section.custom && section.parentId === undefined;
  const expanded = !section.collapsed;
  const chevron = (
    <ChevronDownIcon
      aria-hidden
      className={cn(
        "size-3 shrink-0 transition-transform",
        codexStyle &&
          "opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100",
        !expanded && "-rotate-90",
      )}
    />
  );

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group/project-section flex h-7 items-center rounded-md px-1",
        isDragging && "z-10 opacity-70",
      )}
      data-testid={`sidebar-project-section-${section.id}`}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
    >
      {/* Codex style drags a custom section by its whole header and shows the chevron on hover;
          otherwise a grip button drags it. */}
      <button
        {...(draggable && codexStyle ? { ...attributes, ...listeners } : {})}
        aria-expanded={expanded}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center rounded-md px-1 text-left text-[13px] font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          codexStyle ? "gap-1" : "gap-1.5",
        )}
        onClick={() => {
          props.onSetExpanded(section.id, !expanded);
        }}
        type="button"
      >
        {codexStyle ? null : chevron}
        <span className="truncate">{projectSectionName(section)}</span>
        {codexStyle ? chevron : null}
        <span className="ms-auto shrink-0 text-[11px] text-sidebar-muted-foreground/55">
          {section.projectKeys.length}
        </span>
      </button>
      {section.custom ? (
        <>
          {codexStyle || !draggable ? null : (
            <button
              aria-label={`Reorder ${section.name} section`}
              className="inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing group-hover/project-section:opacity-100 group-focus-within/project-section:opacity-100"
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
                  aria-label={`Actions for ${section.name}`}
                  className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring group-hover/project-section:opacity-100 group-focus-within/project-section:opacity-100"
                  type="button"
                />
              }
            >
              <EllipsisIcon aria-hidden className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-40">
              <MenuItem
                onClick={() => openCommandPalette({ open: "add-project", sectionId: section.id })}
              >
                <FolderPlusIcon />
                Add project
              </MenuItem>
              <MenuItem onClick={() => props.onNewProjectInSection(section)}>
                <FilePlusIcon />
                New project…
              </MenuItem>
              {props.onNewSubsection ? (
                <MenuItem onClick={() => props.onNewSubsection?.(section)}>
                  <FolderTreeIcon />
                  New subsection
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => props.onOpenRename(section)}>
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
                    <MenuItem onClick={() => setSectionColor(section.id, null)}>
                      <span aria-hidden className="size-3 rounded-full border border-border" />
                      None
                      {section.ownColor === undefined ? <CheckIcon className="ms-auto" /> : null}
                    </MenuItem>
                    {PROJECT_ICON_COLORS.map((color) => (
                      <MenuItem
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
              <MenuItem onClick={() => setSectionFolderIcons(section.id, !section.ownFolderIcons)}>
                <FolderIcon />
                Use folder icons
                {section.ownFolderIcons ? <CheckIcon className="ms-auto" /> : null}
              </MenuItem>
              <MenuItem onClick={() => props.onResetIcons(section)}>
                <RotateCcwIcon />
                Reset project icons…
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => props.onDelete(section.id)} variant="destructive">
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
  readonly folderColor: ProjectIconColor | undefined;
  readonly forceFolder: boolean;
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
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef } = useSortable({
    data: {
      type: "project",
      sectionId: props.sectionId,
    } satisfies ProjectDragData,
    id: project.projectKey,
  });
  const otherSections = props.sections.filter(
    (section) => section.custom && section.id !== props.sectionId,
  );

  return (
    // Rows stay put while dragging; the drop line shows where this one lands.
    <li ref={setNodeRef} className={cn("relative rounded-md", isDragging && "opacity-40")}>
      <div className="group/project-row relative">
        {/* Codex style drags the whole row; otherwise the grip button is the handle. */}
        <SidebarMenuButton
          {...(codexStyle ? { ...attributes, ...listeners } : {})}
          aria-expanded={props.isProjectExpanded}
          className={
            codexStyle
              ? "h-8 text-sm group-hover/project-row:pe-14 group-focus-within/project-row:pe-14 pointer-coarse:pe-14"
              : "h-8 pe-12 text-sm"
          }
          isActive={props.selected}
          onClick={() => {
            props.onToggleProject(project.projectKey, !props.isProjectExpanded);
          }}
          size="sm"
          title={project.displayName}
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
            folderColor={props.folderColor}
            forceFolder={props.forceFolder}
            project={project}
            {...(codexStyle && props.isProjectExpanded ? { fallbackIcon: FolderOpenIcon } : {})}
          />
          <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
          {props.threads.length > 0 ? (
            <span className="shrink-0 text-[11px] text-sidebar-muted-foreground/55">
              {props.threads.length}
            </span>
          ) : project.groupedProjectCount > 1 ? (
            <span className="shrink-0 text-[11px] text-sidebar-muted-foreground/55">
              {project.groupedProjectCount}
            </span>
          ) : null}
        </SidebarMenuButton>
        <div className="pointer-events-none absolute inset-y-0 end-1 flex items-center gap-px">
          {codexStyle ? (
            <button
              aria-label={`New thread in ${project.displayName}`}
              className="pointer-events-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:opacity-100 group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100"
              onClick={() => props.onNewThreadInProject(project)}
              type="button"
            >
              <SquarePenIcon aria-hidden className="size-3.5" />
            </button>
          ) : (
            <button
              aria-label={`Reorder ${project.displayName}`}
              className="pointer-events-auto inline-flex size-6 cursor-grab items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100"
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
                  className="pointer-events-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-icon-muted opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:cursor-pointer group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100"
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
                        <MenuItem onClick={() => props.onMoveProject(project.projectKey, null)}>
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
        <ul className={codexStyle ? "ps-6" : "ms-5 border-sidebar-border/60 border-s ps-2"}>
          {props.threads.map((thread) => (
            <SidebarProjectThreadRow
              key={`${thread.environmentId}:${thread.id}`}
              codexStyle={codexStyle}
              activeThreadKey={props.activeThreadKey}
              onClick={props.onThreadClick}
              onContextMenu={props.onThreadContextMenu}
              thread={thread}
              runningSubagents={
                props.runningSubagentsByParentKey.get(
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                ) ?? NO_THREADS
              }
            />
          ))}
          {props.threads.length === 0 ? (
            <li className="px-2 py-1 text-[11px] text-sidebar-muted-foreground/55">
              No threads yet
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
});

function ProjectDragPreview(props: { readonly project: SidebarProjectSnapshot | null }) {
  if (props.project === null) return null;
  return (
    <div className="flex h-7 w-[min(20rem,calc(100vw-2rem))] min-w-0 items-center gap-2 rounded-md border border-sidebar-border bg-sidebar px-2 text-sm text-sidebar-foreground shadow-lg">
      <ProjectFavicon className="size-4 shrink-0" project={props.project} />
      <span className="min-w-0 flex-1 truncate font-medium">{props.project.displayName}</span>
    </div>
  );
}

const THREAD_STATUS_DOT_CLASS: Record<SidebarThreadStatus, string> = {
  approval: "bg-amber-500",
  failed: "bg-red-500",
  input: "bg-indigo-500",
  ready: "bg-emerald-500/70",
  waiting: "bg-sky-500/60",
  limited: "bg-amber-500/60",
  working: "bg-sky-500",
};

/** A zero-height marker, so showing it never shifts the rows around it. */
function ProjectDropLine() {
  return (
    <li aria-hidden className="relative h-0 list-none">
      <span className="absolute inset-x-2 -top-px h-0.5 rounded-full bg-blue-500" />
    </li>
  );
}

function compactThreadTime(thread: SidebarThreadSummary): string {
  const label = formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

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
  readonly runningSubagents: readonly SidebarThreadSummary[];
}): ReactNode {
  const status = withChildNeeds(resolveSidebarThreadStatus(props.thread), props.runningSubagents);
  const activeThreadKey = scopedThreadKey(
    scopeThreadRef(props.thread.environmentId, props.thread.id),
  );
  const active = props.activeThreadKey === activeThreadKey;
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[activeThreadKey],
  );
  // Finished while you were away and not opened since: a green dot where the spinner was.
  const unseenCompletion =
    status === "ready" &&
    hasUnseenCompletion({
      ...props.thread,
      lastVisitedAt: resolveThreadLastVisitedAt(props.thread.lastVisitedAt, localLastVisitedAt),
    });
  const workRows = describeSidebarBackgroundWork(
    props.thread.pendingBackgroundTasks,
    props.runningSubagents,
  );
  // Opens by itself while the thread waits on this work; a manual toggle wins for this row.
  const [manualWorkOpen, setManualWorkOpen] = useState<boolean | null>(null);
  const childWaitsOnYou = workRows.some((row) => row.needs !== undefined);
  const workOpen = manualWorkOpen ?? (status === "waiting" || childWaitsOnYou);
  return (
    <li className="relative list-none">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`${props.thread.title}, ${status}`}
        className={cn(
          "group/project-thread flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
        onClick={(event) => props.onClick(event, props.thread)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(props.thread, { x: event.clientX, y: event.clientY });
        }}
      >
        {props.codexStyle ? null : (
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", THREAD_STATUS_DOT_CLASS[status])}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{props.thread.title}</span>
        {workRows.length > 0 ? (
          // Room for the work toggle, which sits over this spot because buttons cannot nest.
          <span aria-hidden className="w-8 shrink-0" />
        ) : (
          <span className="shrink-0 text-[11px] text-sidebar-muted-foreground/55">
            {compactThreadTime(props.thread)}
          </span>
        )}
        {props.codexStyle ? <ThreadStatusMark status={unseenCompletion ? "done" : status} /> : null}
      </button>
      {workRows.length > 0 ? (
        <button
          type="button"
          aria-expanded={workOpen}
          aria-label={`${workOpen ? "Hide" : "Show"} ${workRows.length} running background ${workRows.length === 1 ? "task" : "tasks"}`}
          className={cn(
            "absolute top-2 flex h-5 w-8 cursor-pointer items-center justify-end gap-0.5 rounded px-0.5 text-[10px] text-sidebar-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            // Left of the 14px status mark and its 8px gap in Codex style; flush with the padding otherwise.
            props.codexStyle ? "right-[30px]" : "right-2",
          )}
          onClick={() => setManualWorkOpen(!workOpen)}
        >
          {workRows.length}
          {workOpen ? (
            <ChevronDownIcon aria-hidden className="size-3" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3" />
          )}
        </button>
      ) : null}
      {workRows.length > 0 && workOpen ? (
        <div className="ms-3 border-s border-sidebar-border/60 ps-1">
          <BackgroundWorkTaskList
            compact
            environmentId={props.thread.environmentId}
            rows={workRows}
          />
        </div>
      ) : null}
    </li>
  );
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
  const addSection = useUiStateStore((store) => store.addSidebarProjectSection);
  const renameSection = useUiStateStore((store) => store.renameSidebarProjectSection);
  const [name, setName] = useState(target.kind === "rename" ? target.name : "");
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
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
            <Button disabled={name.trim().length === 0} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export { SidebarProjectSections };
