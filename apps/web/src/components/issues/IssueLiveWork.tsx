import { issueWorkerStatus } from "@t3tools/shared/issueWorkerStatus";
import { useNavigate } from "@tanstack/react-router";
import { type EnvironmentId, type RepositoryIssueSummary } from "@t3tools/contracts";
import { threadRoleLabel } from "../threadRoleDisplay";
import { T, useGT, useMessages, Var } from "gt-react";
import { CirclePauseIcon, CirclePlayIcon, LinkIcon } from "lucide-react";

import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { issueLiveWorkSummary } from "./issueRoadmap.logic";

import { useIssueStateLabel } from "./IssueStateIcon";

const STATUS_ICONS = {
  suspended: CirclePauseIcon,
  paused: CirclePauseIcon,
  working: CirclePlayIcon,
  waiting_on_you: CirclePauseIcon,
  question: CirclePauseIcon,
  approval: CirclePauseIcon,
  queued: CirclePauseIcon,
  failed: CirclePauseIcon,
  ready_for_review: LinkIcon,
  done: LinkIcon,
  idle: LinkIcon,
};

export function IssueLiveWork({
  issue,
  environmentId,
}: {
  issue: RepositoryIssueSummary;
  environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const gt = useGT();
  const labels = useWorkerStatusLabels();
  const resolve = useMessages();
  const summary = issueLiveWorkSummary(issue, resolve);
  if (summary === null) return null;
  const { status, work, agent, more } = summary;
  const label =
    status === "suspended"
      ? `${gt("Suspended")} · ${issue.suspensionReason}`
      : `${labels[status]} · ${agent}`;
  const Icon = STATUS_ICONS[status];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={more > 0 ? gt("{label}, and {more} more", { label, more }) : label}
            className="flex min-w-0 max-w-full items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: work[0]!.threadId },
              })
            }
          />
        }
      >
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            status === "working" && "text-primary",
            ["question", "approval", "waiting_on_you", "paused"].includes(status) &&
              "text-warning-foreground",
          )}
        />
        <span className="min-w-0 truncate">{label}</span>
        {more > 0 ? <span className="shrink-0">+{more}</span> : null}
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex max-w-96 flex-col gap-2">
          {work.map((thread) => (
            <div key={thread.threadId}>
              <p>
                {thread.role === undefined ? "" : `${threadRoleLabel(thread.role, resolve)}: `}
                {thread.title} ·{" "}
                {status === "suspended" ? label : labels[issueWorkerStatus(thread, issue)]}
              </p>
              {thread.branch ? (
                <p>
                  <T>
                    Branch: <Var>{thread.branch}</Var>
                  </T>
                </p>
              ) : null}
              {thread.worktreePath ? (
                <p>
                  <T>
                    Worktree: <Var>{thread.worktreePath}</Var>
                  </T>
                </p>
              ) : null}
              {thread.pullRequests.map((url) => (
                <p key={url}>
                  <T>
                    Pull request: <Var>{url}</Var>
                  </T>
                </p>
              ))}
            </div>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function useWorkerStatusLabels() {
  const gt = useGT();
  return {
    suspended: gt("Suspended"),
    paused: gt("Paused"),
    working: gt("Running"),
    waiting_on_you: gt("Needs you"),
    question: gt("Waiting on question"),
    approval: gt("Waiting on approval"),
    queued: gt("Queued"),
    ready_for_review: useIssueStateLabel("Ready for review"),
    done: gt("Done"),
    failed: gt("Failed"),
    idle: gt("Idle"),
  };
}
