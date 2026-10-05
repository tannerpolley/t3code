import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/*
 * The Codex-style sidebar's shared columns. Every row (section header, project, thread, subagent,
 * shell) keeps an 8px start and end padding and a caret slot, so carets and icons line up across
 * rows; the trailing columns end flush at the row's end padding.
 */

/** Projects uses the same compact height for top-level threads and their work rows. */
export const PROJECTS_WORK_ROW_HEIGHT = "h-6";

const CARET_SLOT_CLASS = "flex w-4 shrink-0 items-center justify-center";

function Caret(props: { readonly open: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn("size-3 transition-transform", props.open && "rotate-90")}
    />
  );
}

/**
 * The left caret slot. Rows that are themselves the toggle pass `open`; a row that can't collapse,
 * or whose toggle is a `SidebarCaretToggle` over it, leaves it empty.
 */
export function SidebarCaretSlot(props: {
  readonly open?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <span aria-hidden className={cn(CARET_SLOT_CLASS, props.className)}>
      {props.open === undefined ? null : <Caret open={props.open} />}
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
        "absolute start-0.5 flex cursor-pointer items-center rounded px-1.5 text-sidebar-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        props.className,
      )}
      onClick={props.onToggle}
    >
      <span className={CARET_SLOT_CLASS}>
        <Caret open={props.open} />
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
