import { CircleAlertIcon, CircleXIcon, ClockIcon, MessageCircleQuestionIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { SidebarThreadStatus } from "./Sidebar.logic";
import { Spinner } from "./ui/spinner";

/** A sidebar thread status, plus `done` for a finished run worth a green dot. */
export type ThreadStatusMarkStatus = SidebarThreadStatus | "done";

/** Maps a Lineage edge status (subagent, fork run, or transfer) onto the shared mark. */
export function lineageStatusMark(status: string | null): ThreadStatusMarkStatus {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
    case "pending":
    case "running":
    case "in_progress":
    case "waiting":
      return "working";
    case "failed":
    case "error":
      return "failed";
    case "completed":
      return "done";
    case "input":
    case "approval":
      return status;
    default:
      return "ready";
  }
}

/**
 * The right-side status mark shared by sidebar thread rows and Lineage rows: a spinner while
 * working, a green dot when done, an icon when it needs you or failed, nothing when settled.
 */
export function ThreadStatusMark({ status }: { readonly status: ThreadStatusMarkStatus }) {
  const iconClass = "size-3.5 shrink-0";
  switch (status) {
    case "working":
      return (
        <Spinner aria-label="Working" className={cn(iconClass, "text-sidebar-muted-foreground")} />
      );
    case "waiting":
      // Its own turn is done but subagents or background tasks still run: same spinner, amber, half speed.
      return (
        <Spinner
          aria-label="Waiting on background work"
          className={cn(iconClass, "text-amber-500 [animation-duration:2s]!")}
        />
      );
    case "done":
      return (
        <span aria-label="Done" role="img" className={cn(iconClass, "grid place-items-center")}>
          <span className="size-2 rounded-full bg-emerald-500" />
        </span>
      );
    case "approval":
      return <CircleAlertIcon aria-hidden className={cn(iconClass, "text-amber-500")} />;
    case "input":
      return <MessageCircleQuestionIcon aria-hidden className={cn(iconClass, "text-amber-500")} />;
    case "failed":
      return <CircleXIcon aria-hidden className={cn(iconClass, "text-red-500")} />;
    case "limited":
      return <ClockIcon aria-hidden className={cn(iconClass, "text-amber-500")} />;
    case "ready":
      return null;
  }
}
