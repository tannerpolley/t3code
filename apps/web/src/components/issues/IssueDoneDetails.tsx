import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueCleanupInput,
  IssueRepositoryRef,
  IssueSummary,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { issueEnvironment } from "~/state/issues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useInlineActionConfirm } from "../pullRequest/useInlineActionConfirm";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";

export function IssueDoneDetails({
  issue,
  scope,
  environmentId,
}: {
  issue: IssueSummary;
  scope: IssueRepositoryRef;
  environmentId: EnvironmentId;
}) {
  const openPr = useOpenPrLink();
  return (
    <div className="flex flex-col gap-1 ps-6 text-xs text-muted-foreground">
      <p>
        Closed{issue.stateReason ? ` · ${issue.stateReason.replaceAll("_", " ")}` : ""}
        {issue.closedAt ? (
          <>
            {" "}
            · <time dateTime={issue.closedAt}>{new Date(issue.closedAt).toLocaleString()}</time>
          </>
        ) : (
          " · closure time unavailable"
        )}
      </p>
      {(issue.pullRequests ?? []).map((pr) => (
        <div key={pr.url}>
          <InlineButton
            tone="muted"
            render={<a href={pr.url} target="_blank" rel="noopener noreferrer" />}
            onClick={(event) => openPr(event, pr.url, undefined, environmentId)}
          >
            #{pr.number} {pr.title || pr.repository} · {pr.state ?? "state unavailable"}
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
  work: NonNullable<IssueSummary["liveWork"]>[number];
  reference: IssueRepositoryRef & { number: number };
  environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const cleanup = useAtomCommand(issueEnvironment.cleanup, { reportFailure: false });
  const permitted = useAtomValue(issueEnvironment.cleanup.permissionAtom(environmentId));
  const confirm = useInlineActionConfirm(
    `${environmentId}:${reference.repository}:${reference.number}:${work.threadId}:${work.branch}:${work.worktreePath}`,
  );
  const [busy, setBusy] = useState(false);
  const [unmerged, setUnmerged] = useState(false);
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const remove = async (action: IssueCleanupInput["action"], confirmUnmerged = false) => {
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
      toastManager.add({
        type: "error",
        title: "Could not clean up issue work",
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    setRemoved((current) => [...current, action]);
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
        Open worker · {work.title}
      </Button>
      {work.branch && !removed.includes("delete-branch") ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={!permitted || busy || work.status !== "idle"}
          {...confirm.props("branch", () => void remove("delete-branch", unmerged))}
        >
          {confirm.isArmed("branch")
            ? unmerged
              ? "Confirm delete unmerged work?"
              : "Confirm delete branch?"
            : unmerged
              ? "Delete unmerged branch"
              : "Delete local branch"}{" "}
          · {work.branch}
        </Button>
      ) : null}
      {work.worktreePath && !removed.includes("remove-worktree") ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={!permitted || busy || work.status !== "idle"}
          title={work.worktreePath}
          {...confirm.props("worktree", () => void remove("remove-worktree"))}
        >
          {confirm.isArmed("worktree") ? "Confirm remove worktree?" : "Remove worktree"}
        </Button>
      ) : null}
    </div>
  );
}
