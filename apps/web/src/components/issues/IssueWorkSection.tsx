import { IssueWorkers } from "./IssueWorkers";
import type {
  EnvironmentId,
  RepositoryIssueRef,
  RepositoryIssueSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { agentWorktreeName } from "@t3tools/shared/forkAgentWorktreeName";
import type { IssueRef } from "@t3tools/contracts";
import {
  BookOpenIcon,
  CircleAlertIcon,
  FolderKanbanIcon,
  GitBranchPlusIcon,
  HammerIcon,
  ListTreeIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useOpenIssueLink } from "~/lib/openIssueLink";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { repositoryIssueEnvironment, useLiveIssueSummary } from "~/state/repositoryIssues";
import { sanitizeNewRefName } from "../BranchToolbar.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { PullRequestMetaRow } from "../pullRequest/PullRequestSummaryTab";
import { IssueChangeCards } from "./IssueChangeCards";
import { IssueDetailActions } from "./IssueDetailActions";
import { LiveIssueStateBadge } from "./LiveIssueStateBadge";
import { repositoryIssueOf } from "./issueTabs";
import { IssueQueueAction } from "./IssueQueueAction";
import { IssueStartAction } from "./IssueStartAction";
import { OwnerDecisionCards } from "./OwnerDecisionCards";
import { findIssueProject } from "./issueWorktree.logic";
import { useIssueComposerHandoff } from "./useIssueComposerHandoff";

/**
 * Opens a draft thread for the issue's project in a new worktree on its own branch, cut from the
 * default branch when the reader sends. The task is left in the composer, unsent.
 */
function StartInWorktree({
  environmentId,
  host,
  repository,
  issue,
  threadRef,
}: {
  readonly environmentId: EnvironmentId;
  readonly host: string;
  readonly repository: string;
  readonly issue: { readonly number: number; readonly title: string; readonly url: string };
  readonly threadRef: ScopedThreadRef | null;
}) {
  const projects = useProjects();
  const threadShell = useThreadShell(threadRef);
  const handleNewThread = useNewThreadHandler();
  const [branch, setBranch] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const project = findIssueProject(
    projects,
    { environmentId, host, repository },
    threadShell?.projectId ?? null,
  );
  if (project === null) return null;
  if (branch === null) {
    return (
      <Button
        onClick={() => setBranch(agentWorktreeName(issue.title, issue.number))}
        size="xs"
        variant="outline"
      >
        <GitBranchPlusIcon aria-hidden />
        Prepare draft
      </Button>
    );
  }
  const refName = sanitizeNewRefName(branch);
  const start = async () => {
    setStarting(true);
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      envMode: "worktree",
      branch: null,
      worktreePath: null,
      worktreeBranch: refName,
    }).catch(() => null);
    setStarting(false);
    if (opened === null) {
      toastManager.add({ type: "error", title: "Could not open a thread" });
      return;
    }
    const title = issue.title || "Untitled issue";
    useComposerDraftStore
      .getState()
      .setPrompt(opened.draftId, `Work on #${issue.number}: ${title}\n\n${issue.url}`);
    setBranch(null);
  };
  return (
    <form
      className="flex min-w-64 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (refName.length > 0 && !starting) void start();
      }}
    >
      <Input
        aria-label="New branch name"
        autoFocus
        className="flex-1"
        onChange={(event) => setBranch(event.target.value)}
        size="compact"
        value={branch}
      />
      <Button disabled={refName.length === 0 || starting} size="xs" type="submit">
        Create
      </Button>
      <Button onClick={() => setBranch(null)} size="xs" type="button" variant="ghost">
        Cancel
      </Button>
    </form>
  );
}

/** Ask, explain and implement hand-offs, which only the fork's panel has. */
function IssueComposerMenu({
  environmentId,
  reference,
  issue,
  threadRef,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: RepositoryIssueRef;
  readonly issue: RepositoryIssueSummary;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { paste, pending, implementation, hasComposer } = useIssueComposerHandoff({
    environmentId,
    reference,
    issue,
    threadRef,
  });
  return (
    <Menu>
      <MenuTrigger render={<Button aria-label="Send to composer" size="xs" variant="outline" />}>
        <MessageCircleQuestionIcon aria-hidden />
        Ask agent
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <MenuItem disabled={pending || !hasComposer} onClick={() => void paste("ask")}>
          <MessageCircleQuestionIcon />
          Ask a question
        </MenuItem>
        <MenuItem disabled={pending || !hasComposer} onClick={() => void paste("explain")}>
          <BookOpenIcon />
          Explain this issue
        </MenuItem>
        <MenuItem
          disabled={pending || implementation.threadRef === null}
          onClick={() => void paste("implement")}
        >
          <HammerIcon />
          <span className="flex flex-col">
            <span>Implement this issue</span>
            {implementation.disabledReason ? (
              <span className="text-xs text-muted-foreground">{implementation.disabledReason}</span>
            ) : null}
          </span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * What the fork adds to an issue's detail: owner decisions and change approvals, queue, start and
 * worktree actions, and composer hand-offs. Reads the issue itself, so any detail panel can mount
 * it from an issue reference.
 */
function IssueWorkSection({
  environmentId,
  reference,
  threadRef = null,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: RepositoryIssueRef;
  readonly threadRef?: ScopedThreadRef | null;
}) {
  const query = useEnvironmentQuery(
    repositoryIssueEnvironment.detail({ environmentId, input: reference }),
  );
  const issue = useLiveIssueSummary(query.data?.issue, reference, environmentId);
  const issueKey = `${environmentId}:${reference.host}/${reference.repository}#${reference.number}`;
  return (
    <>
      {issue ? (
        <div className="flex flex-wrap items-start gap-1.5 px-4 py-3">
          <IssueQueueAction environmentId={environmentId} reference={reference} issue={issue} />
          <IssueStartAction
            key={issueKey}
            environmentId={environmentId}
            reference={reference}
            threadRef={threadRef}
            closed={issue.state === "closed"}
          />
          <StartInWorktree
            environmentId={environmentId}
            host={reference.host}
            repository={reference.repository}
            issue={issue}
            threadRef={threadRef}
          />
          <IssueComposerMenu
            environmentId={environmentId}
            reference={reference}
            issue={issue}
            threadRef={threadRef}
          />
          <IssueDetailActions
            issue={issue}
            refreshing={query.isPending}
            onRefresh={query.refresh}
          />
        </div>
      ) : null}
      {issue ? (
        <IssueWorkFacts
          environmentId={environmentId}
          reference={reference}
          issue={issue}
          threadRef={threadRef}
        />
      ) : null}
      <OwnerDecisionCards environmentId={environmentId} input={reference} />
      <IssueChangeCards environmentId={environmentId} input={reference} />
    </>
  );
}

/** What GitHub knows that upstream's issue rows have no field for: work state, projects, sub-issues, blockers. */
function IssueWorkFacts({
  environmentId,
  reference,
  issue,
  threadRef,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: RepositoryIssueRef;
  readonly issue: RepositoryIssueSummary;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const openIssue = useOpenIssueLink(threadRef ?? undefined);
  return (
    <div className="space-y-1.5 px-4 pb-3 text-xs">
      <LiveIssueStateBadge issue={issue} reference={reference} environmentId={environmentId} />
      <IssueWorkers issue={issue} environmentId={environmentId} />
      {issue.projects?.length ? (
        <PullRequestMetaRow icon={<FolderKanbanIcon className="size-3.5" />} label="Projects">
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {issue.projects.map((project) => (
              <span key={project.id}>
                {project.title}
                {project.status ? ` · ${project.status}` : ""}
                {project.priority ? ` · ${project.priority.name}` : ""}
              </span>
            ))}
          </span>
        </PullRequestMetaRow>
      ) : null}
      {issue.subIssues && issue.subIssues.total > 0 ? (
        <PullRequestMetaRow icon={<ListTreeIcon className="size-3.5" />} label="Sub-issues">
          {issue.subIssues.completed} / {issue.subIssues.total} completed
        </PullRequestMetaRow>
      ) : null}
      {issue.blockedBy?.length ? (
        <PullRequestMetaRow icon={<CircleAlertIcon className="size-3.5" />} label="Blocked by">
          <span className="flex flex-wrap gap-2">
            {issue.blockedBy.map((blocker) => {
              const url = `https://${blocker.host}/${blocker.repository}/issues/${blocker.number}`;
              return (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => openIssue(event, url, environmentId)}
                  className="hover:underline"
                >
                  {blocker.repository} #{blocker.number}
                  {blocker.state === "closed" ? " (closed)" : ""}
                </a>
              );
            })}
          </span>
        </PullRequestMetaRow>
      ) : null}
    </div>
  );
}

/** The fork's work block inside upstream's issue panel, for GitHub issues on a fork server. */
export function IssueWorkSlot({
  environmentId,
  reference,
  threadRef = null,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRef;
  readonly threadRef?: ScopedThreadRef | null;
}) {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.issueWork === true;
  const issue = repositoryIssueOf(reference);
  if (!supported || issue === null) return null;
  return (
    <IssueWorkSection
      key={`${environmentId}:${issue.host}/${issue.repository}#${issue.number}`}
      environmentId={environmentId}
      reference={issue}
      threadRef={threadRef}
    />
  );
}
