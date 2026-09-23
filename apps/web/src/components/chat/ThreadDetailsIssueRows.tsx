import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, RepositoryIdentity, ThreadId } from "@t3tools/contracts";
import { pullRequestHostOf } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { useNavigate } from "@tanstack/react-router";
import { CircleDotIcon, ListIcon, MinusIcon, PlusIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironment } from "~/state/environments";
import { issueEnvironment } from "~/state/issues";

import { Button } from "../ui/button";
import { THREAD_DETAILS_PANEL_ROW_CLASS } from "./threadDetailsPanelStyles";

/** Issue rows shown before "Show N more", matching the pull request rows. */
const VISIBLE_ISSUE_COUNT = 5;

/** The GitHub repository a thread's project pushes to, when the issue browser can read it. */
export function threadIssueRepository(
  identity: RepositoryIdentity | null | undefined,
): { readonly host: string; readonly repository: string } | null {
  if (identity?.provider !== "github") return null;
  const repository = sourceControlRepositorySelector(identity);
  const host = pullRequestHostOf(identity, "github");
  // The issue browser reads github.com only.
  return repository === null || host !== "github.com" ? null : { host, repository };
}

/**
 * The open issues of the thread's repository, most recently updated first. A row opens the issue
 * beside the thread; the list stays live while agents work on it.
 */
export function ThreadDetailsIssueRows({
  environmentId,
  threadId,
  repositoryIdentity,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  repositoryIdentity: RepositoryIdentity | null | undefined;
}) {
  const enabled = useClientSettings((settings) => settings.versionControlIssues);
  const environment = useEnvironment(environmentId);
  const target = threadIssueRepository(repositoryIdentity);
  const capable = environment?.serverConfig?.environment.capabilities.githubIssues === true;
  if (!enabled || target === null || !capable) return null;
  return <IssueRows environmentId={environmentId} threadId={threadId} {...target} />;
}

function IssueRows({
  environmentId,
  threadId,
  host,
  repository,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  host: string;
  repository: string;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const result = useAtomValue(
    issueEnvironment.liveList({ environmentId, input: { host, repository, state: "open" } }),
  );
  const list = Option.getOrNull(AsyncResult.value(result));
  if (list === null) {
    return result._tag === "Failure" ? (
      <p className="px-2.5 py-1.5 text-xs text-muted-foreground/70">Issues unavailable</p>
    ) : null;
  }
  const issues = list.issues.toSorted((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const shown = expanded ? issues : issues.slice(0, VISIBLE_ISSUE_COUNT);
  const hidden = issues.length - VISIBLE_ISSUE_COUNT;
  const more = list.nextCursor === null ? "" : "+";

  return (
    <div className="flex flex-col" aria-label={`Open issues in ${repository}`} role="group">
      <div className="flex items-center justify-between px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground/70">
        <span>Issues</span>
        <span className="tabular-nums">
          {issues.length}
          {more} open
        </span>
      </div>
      {shown.map((issue) => (
        <Button
          key={issue.number}
          variant="ghost"
          size="sm"
          className={cn(THREAD_DETAILS_PANEL_ROW_CLASS, "active:scale-100")}
          onClick={() =>
            useRightPanelStore.getState().openIssue(scopeThreadRef(environmentId, threadId), {
              environmentId,
              host,
              repository,
              number: issue.number,
              url: issue.url,
            })
          }
        >
          <CircleDotIcon aria-hidden className="-mx-0.5 size-4 shrink-0 text-emerald-500" />
          <span className="min-w-0 flex-1 truncate text-left">
            <span className="me-1 text-muted-foreground">#{issue.number}</span>
            {issue.title || "Untitled issue"}
          </span>
        </Button>
      ))}
      {issues.length === 0 ? (
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground/70">No open issues</p>
      ) : null}
      {hidden > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          className={cn(
            THREAD_DETAILS_PANEL_ROW_CLASS,
            "w-full text-muted-foreground/70 hover:text-foreground/80 active:scale-100",
          )}
        >
          {expanded ? (
            <MinusIcon aria-hidden className="-mx-0.5 size-4 shrink-0" />
          ) : (
            <PlusIcon aria-hidden className="-mx-0.5 size-4 shrink-0" />
          )}
          {expanded ? "Show less" : `Show ${hidden}${more} more`}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void navigate({
            to: "/issues",
            search: { environmentId, host, repository, originThreadId: threadId },
          })
        }
        className={cn(
          THREAD_DETAILS_PANEL_ROW_CLASS,
          "w-full text-muted-foreground/70 hover:text-foreground/80 active:scale-100",
        )}
      >
        <ListIcon aria-hidden className="-mx-0.5 size-4 shrink-0" />
        Browse all issues
      </Button>
    </div>
  );
}
