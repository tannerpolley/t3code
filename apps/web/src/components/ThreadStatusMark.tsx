import {
  CircleAlertIcon,
  CircleDotDashedIcon,
  CirclePauseIcon,
  CircleXIcon,
  ClockIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";

import { msg, useMessages } from "gt-react";
import { cn } from "~/lib/utils";
import type { SidebarThreadStatus } from "./Sidebar.logic";
import { Spinner } from "./ui/spinner";

/** A sidebar thread status, plus `done` for a finished run worth a green dot. */
export type ThreadStatusMarkStatus = SidebarThreadStatus | "done";

const THREAD_STATUS_LABELS = {
  approval: msg("Needs approval"),
  input: msg("Needs input"),
  request: msg("Awaiting response"),
  preparing: msg("Setting up"),
  working: msg("Working"),
  waiting: msg("Waiting on background work"),
  failed: msg("Failed"),
  limited: msg("Usage limited"),
  paused: msg("Paused"),
  ready: msg("Idle"),
  done: msg("Done"),
} satisfies Record<ThreadStatusMarkStatus, string>;

export function useThreadStatusLabel(status: ThreadStatusMarkStatus): string {
  return useMessages()(THREAD_STATUS_LABELS[status]);
}

/** Maps a Lineage edge status (subagent, fork run, or transfer) onto the shared mark. */
export function lineageStatusMark(status: string | null): ThreadStatusMarkStatus {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
    case "pending":
    case "running":
    case "in_progress":
      return "working";
    case "waiting":
      return "waiting";
    case "failed":
    case "error":
      return "failed";
    case "completed":
    case "resolved_native":
    case "resolved_portable":
    case "consumed":
    case "superseded":
      return "done";
    case "input":
    case "approval":
      return status;
    default:
      return "ready";
  }
}

/**
 * The right-side status mark shared by sidebar thread rows and Lineage rows: a blue spinner while
 * working, a green dot when done, an icon when it needs you or failed, a gray dot when settled.
 */
export function ThreadStatusMark({ status }: { readonly status: ThreadStatusMarkStatus }) {
  const label = useThreadStatusLabel(status);
  const iconClass = "size-3.5 shrink-0";
  switch (status) {
    case "working":
      return <Spinner aria-label={label} size="sm" tone="working" />;
    case "waiting":
      return (
        <CircleDotDashedIcon
          aria-label={label}
          className={cn(iconClass, "text-muted-foreground")}
        />
      );
    case "done":
      return (
        <span aria-label={label} role="img" className={cn(iconClass, "grid place-items-center")}>
          <span className="size-2 rounded-full bg-success" />
        </span>
      );
    case "approval":
      return <CircleAlertIcon aria-hidden className={cn(iconClass, "text-warning")} />;
    case "input":
      return <MessageCircleQuestionIcon aria-hidden className={cn(iconClass, "text-warning")} />;
    case "failed":
      return <CircleXIcon aria-hidden className={cn(iconClass, "text-error")} />;
    case "limited":
      return <ClockIcon aria-hidden className={cn(iconClass, "text-warning")} />;
    case "paused":
      return (
        <CirclePauseIcon
          role="img"
          aria-label={label}
          className={cn(iconClass, "text-warning-foreground")}
        />
      );
    case "ready":
      // A settled thread still fills the slot, so the time beside it never shifts.
      return (
        <span aria-label={label} role="img" className={cn(iconClass, "grid place-items-center")}>
          <span className="size-2 rounded-full bg-sidebar-muted-foreground/35" />
        </span>
      );
  }
}
