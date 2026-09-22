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
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FilterIcon,
  FolderIcon,
  FolderPlusIcon,
  GripVerticalIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { type SidebarProjectSection, useUiStateStore } from "../../uiStateStore";
import { cn } from "~/lib/utils";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
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

const UNGROUPED_SECTION_ID = "__ungrouped__";

type SidebarProjectSectionRender = {
  readonly id: string;
  readonly name: string;
  readonly projectKeys: readonly string[];
  readonly collapsed: boolean;
  readonly custom: boolean;
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

function sectionIdForDrop(sectionId: string | null | undefined): string | null | undefined {
  return sectionId === UNGROUPED_SECTION_ID ? null : sectionId;
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
  readonly onOpenProjectSettings: (project: SidebarProjectSnapshot) => void;
  readonly onNewThreadInProject: (project: SidebarProjectSnapshot) => void;
  readonly onRemoveProject: (project: SidebarProjectSnapshot) => void;
  readonly threadsByProjectKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
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
    threadsByProjectKey,
  } = props;
  const addSection = useUiStateStore((store) => store.addSidebarProjectSection);
  const renameSection = useUiStateStore((store) => store.renameSidebarProjectSection);
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
  const [dialog, setDialog] = useState<
    { readonly kind: "create" } | { readonly kind: "rename"; readonly sectionId: string } | null
  >(null);
  const [dialogName, setDialogName] = useState("");
  const [activeProjectKey, setActiveProjectKey] = useState<string | null>(null);

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
      next.push({
        id: section.id,
        name: section.name,
        projectKeys,
        collapsed: section.collapsed,
        custom: true,
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
      });
    }
    return next;
  }, [otherProjectsExpanded, projectByKey, projects, sections]);

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
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    return pointerCollisions.length > 0 ? pointerCollisions : closestCorners(args);
  }, []);

  const openCreateDialog = useCallback(() => {
    setDialogName("");
    setDialog({ kind: "create" });
  }, []);

  const openRenameDialog = useCallback((section: SidebarProjectSectionRender) => {
    if (!section.custom) return;
    setDialogName(section.name);
    setDialog({ kind: "rename", sectionId: section.id });
  }, []);

  const handleDialogSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const name = dialogName.trim();
      if (!dialog || !name) return;
      if (dialog.kind === "create") {
        addSection(name);
      } else {
        renameSection(dialog.sectionId, name);
      }
      setDialog(null);
    },
    [addSection, dialog, dialogName, renameSection],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const activeData = event.active.data.current as SidebarProjectDragData | undefined;
    setActiveProjectKey(activeData?.type === "project" ? String(event.active.id) : null);
  }, []);

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    setActiveProjectKey(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveProjectKey(null);
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
      const sourceSectionId = activeData.sectionId;
      const targetSectionId = sectionIdForDrop(sectionIdFromDragData(overData));
      if (targetSectionId === undefined || sourceSectionId === targetSectionId) {
        if (sourceSectionId === null || overData?.type !== "project") return;
        const section = renderedSections.find((candidate) => candidate.id === sourceSectionId);
        if (!section) return;
        const fromIndex = section.projectKeys.indexOf(projectKey);
        const toIndex = section.projectKeys.indexOf(String(event.over.id));
        if (fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex) {
          reorderSectionProjects(
            sourceSectionId,
            arrayMove([...section.projectKeys], fromIndex, toIndex),
          );
        }
        return;
      }

      moveProject(projectKey, targetSectionId);
      if (targetSectionId === null) return;
      const targetSection = renderedSections.find((candidate) => candidate.id === targetSectionId);
      if (!targetSection) return;
      const targetProjectKeys = targetSection.projectKeys.filter((key) => key !== projectKey);
      const targetIndex =
        overData?.type === "project"
          ? targetProjectKeys.indexOf(String(event.over.id))
          : targetProjectKeys.length;
      targetProjectKeys.splice(
        targetIndex < 0 ? targetProjectKeys.length : targetIndex,
        0,
        projectKey,
      );
      reorderSectionProjects(targetSectionId, targetProjectKeys);
    },
    [moveProject, reorderSectionProjects, reorderSections, renderedSections, sections],
  );

  return (
    <>
      <SidebarGroup className="group-data-[collapsible=icon]:hidden px-1 py-1">
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
              onClick={openCreateDialog}
              size="xs"
              variant="ghost-muted"
            >
              <FolderPlusIcon />
              New section
            </Button>
          </div>
        </div>
        <DndContext
          collisionDetection={collisionDetection}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
          onDragStart={handleDragStart}
          sensors={sensors}
        >
          <SidebarMenu className="gap-px">
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
            <SortableContext
              items={renderedSections
                .filter((section) => section.custom)
                .map((section) => sectionDragId(section.id))}
              strategy={verticalListSortingStrategy}
            >
              {renderedSections.map((section) => (
                <ProjectSection
                  key={section.id}
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
      </SidebarGroup>
      <Dialog
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        open={dialog !== null}
      >
        <DialogPopup className="max-w-md">
          <form onSubmit={handleDialogSubmit}>
            <DialogHeader>
              <DialogTitle>
                {dialog?.kind === "rename" ? "Rename project section" : "Create project section"}
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
                onChange={(event) => setDialogName(event.target.value)}
                placeholder="e.g. Work"
                value={dialogName}
              />
            </DialogPanel>
            <DialogFooter>
              <Button onClick={() => setDialog(null)} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={dialogName.trim().length === 0} type="submit">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}

const ProjectSection = memo(function ProjectSection(props: {
  readonly section: SidebarProjectSectionRender;
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
}) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    data: {
      type: "section-container",
      sectionId: props.section.custom ? props.section.id : null,
    } satisfies SectionContainerDragData,
    id: sectionContainerId(props.section.id),
  });
  const expanded = !props.section.collapsed;
  const sectionProjectKeys = expanded ? props.section.projectKeys : [];

  return (
    <li ref={setDropRef} className={cn("rounded-md", isOver && "bg-sidebar-row-selected/60")}>
      <SortableSectionHeader
        onDelete={props.onDelete}
        onOpenRename={props.onOpenRename}
        onSetExpanded={props.onSetExpanded}
        section={props.section}
      />
      {expanded ? (
        <ul className="ms-3 border-sidebar-border/60 border-s ps-1">
          <SortableContext items={[...sectionProjectKeys]} strategy={verticalListSortingStrategy}>
            {sectionProjectKeys.map((projectKey) => {
              const project = props.projectByKey.get(projectKey);
              return project ? (
                <SortableProjectRow
                  key={projectKey}
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
                />
              ) : null;
            })}
          </SortableContext>
          {sectionProjectKeys.length === 0 ? (
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
  readonly onOpenRename: (section: SidebarProjectSectionRender) => void;
  readonly onDelete: (sectionId: string) => void;
  readonly onSetExpanded: (sectionId: string, expanded: boolean) => void;
}) {
  const { section } = props;
  const sortable = useSortable({
    data: {
      type: "section",
      sectionId: section.id,
    } satisfies SectionDragData,
    disabled: !section.custom,
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
  const expanded = !section.collapsed;

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
      <button
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          props.onSetExpanded(section.id, !expanded);
        }}
        type="button"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")}
        />
        <span className="truncate">{projectSectionName(section)}</span>
        <span className="ms-auto shrink-0 text-[10px] text-sidebar-muted-foreground/55">
          {section.projectKeys.length}
        </span>
      </button>
      {section.custom ? (
        <>
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
              <MenuItem onClick={() => props.onOpenRename(section)}>
                <SettingsIcon />
                Rename section
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
}) {
  const { project } = props;
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
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
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn("relative rounded-md", isDragging && "opacity-0")}
    >
      <div className="group/project-row relative">
        <SidebarMenuButton
          aria-expanded={props.isProjectExpanded}
          className="pe-12"
          isActive={props.selected}
          onClick={() => {
            props.onToggleProject(project.projectKey, !props.isProjectExpanded);
          }}
          size="sm"
          title={project.displayName}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-icon-muted transition-transform",
              props.isProjectExpanded && "rotate-90",
            )}
          />
          <ProjectFavicon className="size-4" project={project} />
          <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
          {props.threads.length > 0 ? (
            <span className="shrink-0 text-[10px] text-sidebar-muted-foreground/55">
              {props.threads.length}
            </span>
          ) : project.groupedProjectCount > 1 ? (
            <span className="shrink-0 text-[10px] text-sidebar-muted-foreground/55">
              {project.groupedProjectCount}
            </span>
          ) : null}
        </SidebarMenuButton>
        <div className="pointer-events-none absolute inset-y-0 end-1 flex items-center gap-px">
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
                        {section.name}
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
        <ul className="ms-5 border-sidebar-border/60 border-s ps-2">
          {props.threads.map((thread) => (
            <SidebarProjectThreadRow
              key={`${thread.environmentId}:${thread.id}`}
              activeThreadKey={props.activeThreadKey}
              onClick={props.onThreadClick}
              onContextMenu={props.onThreadContextMenu}
              thread={thread}
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
      <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-icon-muted" />
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

function compactThreadTime(thread: SidebarThreadSummary): string {
  const label = formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function SidebarProjectThreadRow(props: {
  readonly thread: SidebarThreadSummary;
  readonly activeThreadKey: string | null;
  readonly onClick: (event: ReactMouseEvent, thread: SidebarThreadSummary) => void;
  readonly onContextMenu: (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
  ) => void;
}): ReactNode {
  const status = resolveSidebarThreadStatus(props.thread);
  const activeThreadKey = scopedThreadKey(
    scopeThreadRef(props.thread.environmentId, props.thread.id),
  );
  const active = props.activeThreadKey === activeThreadKey;
  return (
    <li className="list-none">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`${props.thread.title}, ${status}`}
        className={cn(
          "group/project-thread flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs outline-none transition-colors",
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
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", THREAD_STATUS_DOT_CLASS[status])}
        />
        <span className="min-w-0 flex-1 truncate">{props.thread.title}</span>
        <span className="shrink-0 text-[10px] text-sidebar-muted-foreground/55">
          {compactThreadTime(props.thread)}
        </span>
      </button>
    </li>
  );
}

export { SidebarProjectSections };
