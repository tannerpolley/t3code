import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  THREAD_ROLE_LABELS,
  type ClientSettings,
  type OrchestrationV2ThreadShell,
  type ThreadRole,
} from "@t3tools/contracts";
import { useClientSettings } from "../../hooks/useSettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatSidebarTokens } from "./SidebarTokenUsage.logic";

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
 * or whose toggle is a `SidebarCaretToggle` over it, leaves it empty or puts a small mark there.
 */
export function SidebarCaretSlot(props: {
  readonly open?: boolean | undefined;
  readonly className?: string | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <span aria-hidden className={cn(CARET_SLOT_CLASS, props.className)}>
      {props.open === undefined ? props.children : <Caret open={props.open} />}
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

/**
 * All thread surfaces share these fixed tracks; only the name gets spare width. Rows never indent,
 * so every column lines up at every depth; in Projects a group tint marks the depth instead.
 */
export function SidebarThreadColumns(props: {
  readonly caret?: ReactNode;
  readonly location?: ReactNode;
  readonly role?: ReactNode;
  readonly provider?: ReactNode;
  readonly model?: ReactNode;
  readonly effort?: ReactNode;
  readonly name: ReactNode;
  readonly count?: number | undefined;
  readonly trailingClassName?: string | undefined;
  readonly time?: ReactNode;
  readonly status?: ReactNode;
  readonly usage?: ReactNode;
}) {
  return (
    <span className="sidebar-thread-columns">
      <span className="sidebar-thread-usage">{props.usage}</span>
      <span className="sidebar-thread-caret">{props.caret ?? <SidebarCaretSlot />}</span>
      <span className="sidebar-thread-icon">{props.location}</span>
      <span className="sidebar-thread-icon">{props.role}</span>
      <span className="sidebar-thread-icon">{props.provider}</span>
      <span className="sidebar-thread-model">{props.model}</span>
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

const selectSidebarThreadLabel = (settings: ClientSettings) => settings.sidebarThreadLabel;

/** Whether thread rows show a thread's role instead of its name (the "Thread row title" setting). */
export function useSidebarRoleLabels() {
  return useClientSettings(selectSidebarThreadLabel) === "role";
}

/** A thread row's title: with role labels on, a thread that has a role shows it, name on hover. */
export function sidebarThreadName(
  title: string,
  role: ThreadRole | undefined,
  roleLabels: boolean,
): ReactNode {
  if (!roleLabels || role === undefined) return title;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block truncate" />}>
        {THREAD_ROLE_LABELS[role]}
      </TooltipTrigger>
      <TooltipPopup side="top">{title}</TooltipPopup>
    </Tooltip>
  );
}

export function SidebarTokenUsage(props: {
  readonly summary: OrchestrationV2ThreadShell["usageSummary"];
}) {
  const usage = props.summary;
  if (!usage) return null;
  const number = (value: number | undefined) =>
    value === undefined ? "Unavailable" : value.toLocaleString();
  const contextPercent =
    usage.contextTokens !== undefined && usage.contextWindow
      ? `${Math.round((usage.contextTokens / usage.contextWindow) * 100)}%`
      : "Unavailable";
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        {formatSidebarTokens(usage.latestTurnTokens)}
      </TooltipTrigger>
      <TooltipPopup side="right">
        <div>
          Latest turn: {number(usage.latestTurnTokens)} tokens{usage.partial ? " (partial)" : ""}
        </div>
        <div>Input: {number(usage.inputTokens)}</div>
        <div>Cached input: {number(usage.cachedInputTokens)}</div>
        <div>Output: {number(usage.outputTokens)}</div>
        <div>
          Context: {contextPercent} · {number(usage.contextTokens)} / {number(usage.contextWindow)}
        </div>
        <div>Thread total (reported): {number(usage.threadTokens)} tokens</div>
      </TooltipPopup>
    </Tooltip>
  );
}
