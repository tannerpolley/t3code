import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { splitSidebarModelLabel } from "./SidebarBackgroundWork.logic";

import { cn } from "~/lib/utils";

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
 * `className` places it vertically to match the row's height. A non-orchestrator's caret sits one
 * column in, over its row's emptied location cell (`inLocationColumn`), so carets step in with
 * depth: orchestrator, then its agents, then their processes.
 */
export function SidebarCaretToggle(props: {
  readonly open: boolean;
  readonly label: string;
  readonly onToggle: () => void;
  readonly className: string;
  readonly inLocationColumn?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-label={props.label}
      data-location-column={props.inLocationColumn ? "" : undefined}
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
  readonly count?: number | undefined;
  readonly trailingClassName?: string | undefined;
  readonly time?: ReactNode;
  readonly status?: ReactNode;
}) {
  return (
    <span className="sidebar-thread-columns">
      <span className="sidebar-thread-caret">{props.caret ?? <SidebarCaretSlot />}</span>
      <span className="sidebar-thread-icon">{props.location}</span>
      <span className="sidebar-thread-icon">{props.role}</span>
      <span className="sidebar-thread-icon">{props.provider}</span>
      <SidebarThreadModel label={props.model} />
      <span className="sidebar-thread-effort">{props.effort}</span>
      <span className="sidebar-thread-name">{props.name}</span>
      <span className={cn("sidebar-thread-count", props.trailingClassName)}>{props.count}</span>
      <span className={cn("sidebar-thread-time", props.trailingClassName)}>{props.time}</span>
      <span className={cn("sidebar-thread-icon", props.trailingClassName)}>{props.status}</span>
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

/** The model's name and version cells, with the whole label on hover. */
function SidebarThreadModel(props: { readonly label: string | undefined }) {
  if (!props.label) return <span className="sidebar-thread-model" />;
  const { name, version } = splitSidebarModelLabel(props.label);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="sidebar-thread-model" />}>
        <span className="sidebar-thread-model-part">{name}</span>
        <span className="sidebar-thread-model-part">{version}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
