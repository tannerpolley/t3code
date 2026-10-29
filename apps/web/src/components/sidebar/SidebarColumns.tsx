import { effortBarHeights } from "../chat/EffortGlyph";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { modelSelectionEffortLevel } from "@t3tools/client-runtime/state/thread-execution";
import { sidebarModelParts } from "./SidebarBackgroundWork.logic";
import { sidebarCaretCount } from "./SidebarColumns.logic";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";

// The debug toggles touch `document` on load, which tests running outside a browser lack.
if (import.meta.env.DEV && typeof document !== "undefined") void import("./ForkSidebarDebug");

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
  readonly count?: number | undefined;
  readonly className?: string | undefined;
  readonly children?: ReactNode;
}) {
  const count = sidebarCaretCount(props.count, props.open);
  const slot = (
    <span
      aria-hidden
      className={cn(CARET_SLOT_CLASS, "sidebar-caret-slot", props.className)}
      data-count={count === undefined ? undefined : ""}
    >
      {count === undefined ? null : (
        <span
          className={cn(
            "sidebar-caret-count",
            props.open !== undefined &&
              "group-hover/sidebar-caret:hidden group-focus/sidebar-caret:hidden",
          )}
        >
          {count}
        </span>
      )}
      {props.open === undefined ? (
        props.children
      ) : (
        <span
          className={cn(
            "sidebar-caret-icon",
            count !== undefined &&
              "hidden group-hover/sidebar-caret:flex group-focus/sidebar-caret:flex",
          )}
        >
          <SidebarCaret open={props.open} />
        </span>
      )}
    </span>
  );
  return props.count === undefined ? (
    slot
  ) : (
    <Tooltip>
      <TooltipTrigger render={slot} />
      <TooltipPopup side="right">{props.count}</TooltipPopup>
    </Tooltip>
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
  readonly count?: number | undefined;
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
        "sidebar-caret-toggle group/sidebar-caret absolute flex cursor-pointer items-center rounded px-1.5 text-sidebar-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.className,
      )}
      onClick={props.onToggle}
    >
      <SidebarCaretSlot open={props.open} count={props.count} />
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

// Only the row's edges are fixed tracks, so icons, times and status marks line up across rows.
const LEFT_TRACKS = { location: "0.75rem", role: "0.75rem", provider: "1rem" } as const;

/**
 * A thread row: fixed icon tracks, then the model name, version and effort with the name flowing
 * after them, then the badge hugging the time, then the status mark.
 */
export function SidebarThreadColumns(props: {
  readonly caret?: ReactNode;
  readonly location?: ReactNode;
  readonly role?: ReactNode;
  readonly provider?: ReactNode;
  /** The short model label, split into its name and version. */
  readonly model?: string | undefined;
  /** The effort label, shown as a five-bar meter. */
  readonly effort?: string | null | undefined;
  readonly name: ReactNode;
  readonly badgeKind?: "issue" | "pr" | undefined;
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
    version: !settings.codexStyleSidebar || settings.sidebarShowModelVersion,
    effort: !settings.codexStyleSidebar || settings.sidebarShowEffort,
    issue: !settings.codexStyleSidebar || settings.sidebarShowIssueBadge,
    pr: !settings.codexStyleSidebar || settings.sidebarShowPullRequestBadge,
  }));
  const left = (["location", "role", "provider"] as const).filter((column) => columns[column]);
  const gridTemplateColumns = [
    "var(--sidebar-caret-width, 1.5rem)",
    ...left.map((column) => LEFT_TRACKS[column]),
    "minmax(0, 1fr) auto 0.875rem",
  ].join(" ");
  const model = props.model ? sidebarModelParts(props.model) : undefined;
  const modelName = columns.model ? model?.name : undefined;
  const version = columns.version ? model?.version : undefined;
  const effort = columns.effort ? props.effort : undefined;
  const badge =
    props.badgeKind === "issue" && columns.issue
      ? props.issue
      : props.badgeKind === "pr" && columns.pr
        ? props.pr
        : null;
  return (
    <span
      className="sidebar-thread-columns"
      data-sidebar-role-display={columns.roleDisplay}
      style={{ gridTemplateColumns }}
    >
      <span className="sidebar-thread-caret">{props.caret ?? <SidebarCaretSlot />}</span>
      {left.map((column) => (
        <span key={column} className="sidebar-thread-icon">
          {props[column]}
        </span>
      ))}
      <span className="sidebar-thread-main">
        {modelName || version || effort ? (
          <span className="sidebar-thread-model">
            {modelName ? (
              <SidebarModelPiece label={props.model!}>{modelName}</SidebarModelPiece>
            ) : null}
            {version ? <SidebarModelPiece label={props.model!}>{version}</SidebarModelPiece> : null}
            {effort ? <SidebarEffortMeter effort={effort} /> : null}
          </span>
        ) : null}
        <span className="sidebar-thread-name">{props.name}</span>
      </span>
      <span className={cn("sidebar-thread-trailing", props.trailingClassName)}>
        {badge ? <span className="sidebar-thread-badge">{badge}</span> : null}
        {props.time ? <span className="sidebar-thread-time">{props.time}</span> : null}
      </span>
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

export function SidebarThreadTitle(props: { readonly role: string; readonly title: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="sidebar-role-title block truncate" />}>
        {props.role}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.title}</TooltipPopup>
    </Tooltip>
  );
}

/** A model name or version, with the whole label on hover. */
function SidebarModelPiece(props: { readonly label: string; readonly children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="min-w-0 truncate" />}>
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Rising bars, one per effort level, filled up to the current one; an effort off that scale shows none. */
function SidebarEffortMeter(props: { readonly effort: string }) {
  const { level, name } = modelSelectionEffortLevel(props.effort);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="sidebar-thread-effort" role="img" aria-label={name} />}
      >
        {level === 0 ? null : <SidebarEffortBars filled={level} />}
      </TooltipTrigger>
      <TooltipPopup side="top">{name}</TooltipPopup>
    </Tooltip>
  );
}

// Upstream's xs EffortGlyph is 18px wide; these 14px bars read as part of the 11px model label.
function SidebarEffortBars(props: { readonly filled: number }) {
  const maxBar = 8;
  return (
    <svg aria-hidden="true" width={14} height={maxBar} viewBox={`0 0 14 ${maxBar}`}>
      {effortBarHeights(5, maxBar).map((barHeight, index) => (
        <rect
          key={`bar-${barHeight}`}
          x={index * 3}
          y={maxBar - barHeight}
          width={2}
          height={barHeight}
          fill="currentColor"
          opacity={index < props.filled ? 1 : 0.4}
        />
      ))}
    </svg>
  );
}
