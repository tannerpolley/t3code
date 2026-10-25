import {
  FoldersIcon,
  ListPlusIcon,
  FolderPlusIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { useSidebarLayoutPermission } from "../../hooks/useSidebarLayoutPermission";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SidebarInput } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  hasProjects: boolean;
  sidebarMode: "projects" | "activity";
  onSidebarModeChange: (mode: "projects" | "activity") => void;
  onNewSection: () => void;

  projectScope: ReactNode;
  onNewProject: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  searchFieldRef,
  hasProjects,
  sidebarMode,
  onSidebarModeChange,
  onNewSection,
  projectScope,
  onNewProject,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const canWriteLayout = useSidebarLayoutPermission();
  const projectsViewEnabled = useClientSettings((s) => s.projectsView);
  const codexStyleSidebar = useClientSettings((s) => s.codexStyleSidebar);
  const showingProjects = sidebarMode === "projects";
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `New thread (${newThreadShortcutLabel})`
    : "New thread";

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <div
          ref={searchFieldRef}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
          <SidebarInput
            ref={searchInputRef}
            nativeInput
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search"
            aria-label="Search threads"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={resultsVisible}
            aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
            aria-activedescendant={
              activeResultExists
                ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                : undefined
            }
            className="min-w-0 flex-1"
          />
          {isSearching ? (
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="shrink-0"
              aria-label="Clear thread search"
              onClick={() => {
                onClearSearch();
                searchInputRef.current?.focus();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>
        {/* Unfilled like the search field beside it: the buttons carry their own
          hover states, and a background well reads far louder on themed
          palettes than on the base light and dark ones. */}
        <div className="flex shrink-0 items-center">
          {projectsViewEnabled ? (
            <>
              <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
                <FolderPlusIcon />
              </SidebarHeaderIconButton>
              <SidebarHeaderIconButton
                label={showingProjects ? "Show activity" : "Show projects"}
                aria-pressed={showingProjects}
                className={
                  showingProjects
                    ? "bg-info/15 text-info hover:bg-info/20 hover:text-info"
                    : undefined
                }
                onClick={() => onSidebarModeChange(showingProjects ? "activity" : "projects")}
              >
                <FoldersIcon />
              </SidebarHeaderIconButton>
            </>
          ) : hasProjects ? (
            <>
              {projectScope}
              <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
                <FolderPlusIcon />
              </SidebarHeaderIconButton>
            </>
          ) : null}
          {!projectsViewEnabled ? (
            <SidebarHeaderIconButton
              label="New thread"
              tooltip={
                showNewThreadInProjectHint ? (
                  <span className="flex flex-col gap-0.5">
                    <span>{newThreadLabel}</span>
                    <span className="text-muted-foreground">
                      New thread in current project: Shift+click
                      {newThreadInProjectShortcutLabel
                        ? ` (${newThreadInProjectShortcutLabel})`
                        : ""}
                    </span>
                  </span>
                ) : (
                  newThreadLabel
                )
              }
              disabled={newThreadDisabled}
              onClick={onNewThread}
            >
              <SquarePenIcon />
            </SidebarHeaderIconButton>
          ) : null}
        </div>
      </div>
      {projectsViewEnabled ? (
        <div className="flex min-w-0 items-center gap-1">
          {showingProjects && codexStyleSidebar ? (
            <SidebarHeaderLabeledButton
              disabled={!canWriteLayout}
              onClick={onNewSection}
              data-testid="sidebar-create-project-section"
            >
              <ListPlusIcon />
              <span>New section</span>
            </SidebarHeaderLabeledButton>
          ) : (
            <>
              {hasProjects ? projectScope : null}
              <SidebarHeaderLabeledButton
                onClick={onNewThread}
                disabled={newThreadDisabled}
                aria-label={newThreadLabel}
              >
                <SquarePenIcon />
                <span>New thread</span>
              </SidebarHeaderLabeledButton>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<"button">,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            {...rest}
            className={cn(
              "relative inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 [&_svg]:size-4",
              className,
            )}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** Text actions for the view beneath search; also used as the scope popup trigger. */
export function SidebarHeaderLabeledButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex h-7 w-auto min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 [&>span]:truncate [&_svg]:size-3.5",
        className,
      )}
    />
  );
}
