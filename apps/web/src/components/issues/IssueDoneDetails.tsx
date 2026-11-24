import { T, useGT, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueCleanupInput,
  IssueRepositoryRef,
  RepositoryIssueSummary,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { repositoryIssueEnvironment } from "~/state/repositoryIssues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { useInlineActionConfirm } from "../pullRequest/useInlineActionConfirm";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";

export function IssueDoneDetails({
  issue,
  scope,
  environmentId,
}: {
  issue: RepositoryIssueSummary;
  scope: IssueRepositoryRef;
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const openPr = useOpenPrLink();
  const closedLabel =
    issue.stateReason === "completed"
      ? gt("Closed as completed")
      : issue.stateReason === "not_planned"
        ? gt("Closed as not planned")
        : issue.stateReason === "duplicate"
          ? gt("Closed as duplicate")
          : gt("Closed");
  return (
    <div className="flex flex-col gap-1 ps-6 text-xs text-muted-foreground">
      <p>
        {closedLabel}
        {issue.closedAt ? (
          <>
            {" "}
            · <time dateTime={issue.closedAt}>{new Date(issue.closedAt).toLocaleString()}</time>
          </>
        ) : (
          gt(" · closure time unavailable")
        )}
      </p>
      {(issue.pullRequests ?? []).map((pr) => (
        <div key={pr.url}>
          <InlineButton
            tone="muted"
            render={<a href={pr.url} target="_blank" rel="noopener noreferrer" />}
            onClick={(event) => openPr(event, pr.url, undefined, environmentId)}
          >
            #{pr.number} {pr.title || pr.repository} ·{" "}
            {pr.state === null
              ? gt("state unavailable")
              : resolve(
                  PULL_REQUEST_STATE_PRESENTATION[
                    pr.state === "open" && pr.isDraft ? "draft" : pr.state
                  ].label,
                )}
          </InlineButton>
        </div>
      ))}
      {(issue.liveWork ?? []).map((work) => (
        <IssueWorkCleanup
          key={`${work.threadId}:${work.branch}:${work.worktreePath}`}
          work={work}
          reference={{ ...scope, number: issue.number }}
          environmentId={environmentId}
        />
      ))}
    </div>
  );
}

function IssueWorkCleanup({
  work,
  reference,
  environmentId,
}: {
  work: NonNullable<RepositoryIssueSummary["liveWork"]>[number];
  reference: IssueRepositoryRef & { number: number };
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const cleanup = useAtomCommand(repositoryIssueEnvironment.cleanup, { reportFailure: false });
  const permitted = useAtomValue(repositoryIssueEnvironment.cleanup.permissionAtom(environmentId));
  const confirm = useInlineActionConfirm(
    `${environmentId}:${reference.repository}:${reference.number}:${work.threadId}:${work.branch}:${work.worktreePath}`,
  );
  const [busy, setBusy] = useState(false);
  const [unmerged, setUnmerged] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const remove = async (action: IssueCleanupInput["action"], confirmUnmerged = false) => {
    setFailure(null);
    setBusy(true);
    const result = await cleanup({
      environmentId,
      input: {
        ...reference,
        threadId: work.threadId,
        action,
        expectedBranch: work.branch,
        expectedWorktreePath: work.worktreePath,
        confirmed: true,
        confirmUnmerged,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "unmerged"
      )
        setUnmerged(true);
      setFailure(formatEnvironmentQueryError(result.cause));
      toastManager.add({
        type: "error",
        title: gt("Could not clean up issue work"),
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    if (action === "remove-worktree") {
      if (result.value?.outcome === "kept") {
        setFailure(result.value.reason);
        return;
      }
      return;
    }
    setRemoved(true);
    setUnmerged(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: work.threadId },
          })
        }
      >
        <T>Open worker ·</T> {work.title}
      </Button>
      {work.worktreePath && work.worktreeExists ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={!permitted || busy || work.status !== "idle"}
          {...confirm.props("worktree", () => void remove("remove-worktree"))}
        >
          {confirm.isArmed("worktree") ? gt("Confirm remove worktree?") : gt("Remove worktree")}
        </Button>
      ) : null}
      {work.branch && !removed ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={!permitted || busy || work.status !== "idle"}
          {...confirm.props("branch", () => void remove("delete-branch", unmerged))}
        >
          {confirm.isArmed("branch")
            ? unmerged
              ? gt("Confirm delete unmerged work?")
              : gt("Confirm delete branch?")
            : unmerged
              ? gt("Delete unmerged branch")
              : gt("Delete local branch")}{" "}
          · {work.branch}
        </Button>
      ) : null}
      {failure ? <p role="status">{failure}</p> : null}
    </div>
  );
}
