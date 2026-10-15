import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, IssueSummary } from "@t3tools/contracts";
import { CirclePauseIcon, LinkIcon } from "lucide-react";

import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { issueLiveStatus } from "./issueRoadmap.logic";

export function IssueLiveWork({
  issue,
  environmentId,
}: {
  issue: IssueSummary;
  environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const status = issueLiveStatus(issue);
  if (status === null) return null;
  const work = [...(issue.liveWork ?? [])].sort(
    (a, b) =>
      Number(b.status === status) - Number(a.status === status) || a.title.localeCompare(b.title),
  );
  const label =
    status === "working"
      ? "Working"
      : status === "waiting_on_you"
        ? "Waiting on you"
        : "Linked, idle";
  const Icon = status === "waiting_on_you" ? CirclePauseIcon : LinkIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${label}: ${work[0]!.title}`}
            className="flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: work[0]!.threadId },
              })
            }
          />
        }
      >
        {status !== "working" ? (
          <Icon
            aria-hidden
            className={cn("size-3.5", status === "waiting_on_you" && "text-warning-foreground")}
          />
        ) : null}
        <span>{label}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex max-w-96 flex-col gap-2">
          {work.map((thread) => (
            <div key={thread.threadId}>
              <p>
                {thread.title} ·{" "}
                {thread.status === "working"
                  ? "Working"
                  : thread.status === "waiting_on_you"
                    ? "Waiting on you"
                    : "Idle"}
              </p>
              {thread.branch ? <p>Branch: {thread.branch}</p> : null}
              {thread.worktreePath ? <p>Worktree: {thread.worktreePath}</p> : null}
              {thread.pullRequests.map((url) => (
                <p key={url}>Pull request: {url}</p>
              ))}
            </div>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
