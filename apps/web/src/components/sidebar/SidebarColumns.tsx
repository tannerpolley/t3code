import { ChevronRightIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { splitSidebarModelLabel } from "./SidebarBackgroundWork.logic";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";

if (import.meta.env.DEV) void import("./ForkSidebarDebug");

/*
 * The Codex-style sidebar's shared columns. Every row (section header, project, thread, subagent,
 * shell) keeps an 8px start and end padding and a caret slot, so carets and icons line up across
 * rows; the trailing columns end flush at the row's end padding.
 */

/** Projects uses the same compact height for top-level threads and their work rows. */
export const PROJECTS_WORK_ROW_HEIGHT = "h-6";

const CARET_SLOT_CLASS = "flex w-4 shrink-0 items-center justify-center";

export function SidebarCaret(props: { readonly open: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn("size-3 transition-transform", props.open && "rotate-90")}
    />
  );
}

/**
 * The left caret slot. Rows that are themselves the toggle pass `open`; a row that can't collapse,
 * or whose toggle is a `SidebarCaretToggle` over it, leaves it empty or puts a small mark there.
 */
export function SidebarCaretSlot(props: {
  readonly open?: boolean | undefined;
  readonly className?: string | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <span aria-hidden className={cn(CARET_SLOT_CLASS, props.className)}>
      {props.open === undefined ? props.children : <SidebarCaret open={props.open} />}
    </span>
  );
}

/**
 * A caret toggle over a row's empty caret slot, for rows that are buttons themselves (buttons
 * cannot nest), so it renders as the row's sibling inside a `relative` parent whose padding box
 * starts at the row. `start-0.5` plus `px-1.5` is the row's 8px padding, which widens the hit area.
 * `className` places it vertically to match the row's height.
 */
export function SidebarCaretToggle(props: {
  readonly open: boolean;
  readonly label: string;
  readonly onToggle: () => void;
  readonly className: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-label={props.label}
      className={cn(
        "sidebar-caret-toggle absolute flex cursor-pointer items-center rounded px-1.5 text-sidebar-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.className,
      )}
      onClick={props.onToggle}
    >
      <span className={CARET_SLOT_CLASS}>
        <SidebarCaret open={props.open} />
      </span>
    </button>
  );
}

/**
 * The right columns, last in the row: a count, then time, then status mark. Each renders only when
 * given, and the group sizes to what it holds, so a narrow sidebar leaves the title its room and a
 * header row reserves nothing it doesn't show.
 */
export function SidebarTrailingColumns(props: {
  readonly count?: number | undefined;
  readonly time?: ReactNode;
  readonly status?: ReactNode;
}) {
  if (props.count === undefined && !props.time && !props.status) return null;
  return (
    <span className="ms-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-2xs font-normal tabular-nums">
      {props.count === undefined ? null : (
        <span className="text-sidebar-muted-foreground/55">{props.count}</span>
      )}
      {props.time ? <span className="text-muted-foreground">{props.time}</span> : null}
      {props.status ? <span className="flex w-3.5 justify-center">{props.status}</span> : null}
    </span>
  );
}

/**
 * All thread surfaces share these fixed tracks; only the name gets spare width. Rows never indent,
 * so every column lines up at every depth; in Projects a group tint connects a thread's lineage.
 */
export function SidebarThreadColumns(props: {
  readonly caret?: ReactNode;
  readonly location?: ReactNode;
  readonly role?: ReactNode;
  readonly provider?: ReactNode;
  /** The short model label; its name and version fill two aligned tracks. */
  readonly model?: string | undefined;
  readonly effort?: ReactNode;
  readonly name: ReactNode;
  /** The row has no model or effort, so its name starts in the model's column. */
  readonly wideName?: boolean | undefined;
  readonly count?: number | undefined;
  readonly issue?: ReactNode;
  readonly pr?: ReactNode;
  readonly trailingClassName?: string | undefined;
  readonly time?: ReactNode;
  readonly status?: ReactNode;
}) {
  const columns = useClientSettings((settings) => ({
    roleDisplay: settings.sidebarRoleDisplay,
    location: !settings.codexStyleSidebar || settings.sidebarShowLocation,
    role: settings.sidebarRoleDisplay === "icon",
    provider: !settings.codexStyleSidebar || settings.sidebarShowProvider,
    model: !settings.codexStyleSidebar || settings.sidebarShowModel,
    version: !settings.codexStyleSidebar || settings.sidebarShowModel,
    effort: !settings.codexStyleSidebar || settings.sidebarShowEffort,
    issue: !settings.codexStyleSidebar || settings.sidebarShowIssueBadge,
    pr: !settings.codexStyleSidebar || settings.sidebarShowPullRequestBadge,
  }));
  const style = Object.fromEntries(
    Object.entries(columns).flatMap(([column, visible]) =>
      visible === false
        ? [
            [`--sidebar-${column}-track`, "0px"],
            [`--sidebar-${column}-gap`, "0px"],
          ]
        : [],
    ),
  ) as CSSProperties;
  return (
    <span
      className="sidebar-thread-columns"
      data-sidebar-role-display={columns.roleDisplay}
      style={style}
    >
      <span className="sidebar-thread-caret">{props.caret ?? <SidebarCaretSlot />}</span>
      {columns.location !== false ? (
        <span className="sidebar-thread-icon sidebar-thread-location">{props.location}</span>
      ) : null}
      {columns.role !== false ? (
        <span className="sidebar-thread-icon sidebar-thread-role">{props.role}</span>
      ) : null}
      {columns.provider !== false ? (
        <span className="sidebar-thread-icon sidebar-thread-provider">{props.provider}</span>
      ) : null}
      {columns.model !== false && !props.wideName ? (
        <SidebarThreadModel label={props.model} />
      ) : null}
      {columns.effort !== false && !props.wideName ? (
        <span className="sidebar-thread-effort">{props.effort}</span>
      ) : null}
      <span className={cn("sidebar-thread-name", props.wideName && "sidebar-thread-name-wide")}>
        {props.name}
      </span>
      <span className={cn("sidebar-thread-count", props.trailingClassName)}>{props.count}</span>
      {columns.issue !== false ? (
        <span className={cn("sidebar-thread-badge sidebar-thread-issue", props.trailingClassName)}>
          {props.issue}
        </span>
      ) : null}
      {columns.pr !== false ? (
        <span className={cn("sidebar-thread-badge sidebar-thread-pr", props.trailingClassName)}>
          {props.pr}
        </span>
      ) : null}
      <span className={cn("sidebar-thread-time", props.trailingClassName)}>{props.time}</span>
      <span className={cn("sidebar-thread-icon sidebar-thread-work", props.trailingClassName)}>
        {props.status}
      </span>
    </span>
  );
}

// oklch hue angles that read in light and dark themes as low-alpha row tints.
const THREAD_GROUP_HUES = [250, 300, 160, 70, 20, 195] as const;

/** The hue a thread group tints its rows with, fixed by its top-level thread's id. */
export function threadGroupHue(rootThreadId: string): number {
  let hash = 0;
  for (let index = 0; index < rootThreadId.length; index++) {
    hash = (hash * 31 + rootThreadId.charCodeAt(index)) | 0;
  }
  return THREAD_GROUP_HUES[Math.abs(hash) % THREAD_GROUP_HUES.length]!;
}

/** A row's title (see `sidebarThreadTitle`) with the thread's own name on hover. */
export function sidebarThreadName(name: string, title: string): ReactNode {
  if (title === name) return name;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block truncate" />}>{title}</TooltipTrigger>
      <TooltipPopup side="top">{name}</TooltipPopup>
    </Tooltip>
  );
}

/** The model's name and version cells, with the whole label on the name's hover. */
function SidebarThreadModel(props: { readonly label: string | undefined }) {
  if (!props.label) {
    return (
      <>
        <span className="sidebar-thread-model" />
        <span className="sidebar-thread-version" />
      </>
    );
  }
  const { name, version } = splitSidebarModelLabel(props.label);
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<span className="sidebar-thread-model" />}>{name}</TooltipTrigger>
        <TooltipPopup side="top">{props.label}</TooltipPopup>
      </Tooltip>
      <span className="sidebar-thread-version">{version}</span>
    </>
  );
}
