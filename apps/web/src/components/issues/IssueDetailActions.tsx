import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, IssueRef, IssueSummary, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BookOpenIcon,
  CircleSlashIcon,
  CopyIcon,
  ExternalLinkIcon,
  HammerIcon,
  LinkIcon,
  MessageCircleQuestionIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  Undo2Icon,
  UnlinkIcon,
} from "lucide-react";
import { useState } from "react";

import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { handoffPrompt } from "../pullRequest/pullRequestDetail.logic";
import { useInlineActionConfirm } from "../pullRequest/useInlineActionConfirm";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger, MenuShortcut } from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  canUnlinkIssue,
  issueComposerPrompt,
  issueImplementDestination,
  issueMenuAvailability,
  type IssueComposerAction,
} from "./issueDetailActions.logic";
import { findIssueProject } from "./issueWorktree.logic";

const lastHandoffByDraft = new Map<string, string>();

/** The issue-specific actions use the PR's menu controls, confirmation and composer handoff. */
export function IssueDetailActions({
  environmentId,
  reference,
  issue,
  threadRef,
  refreshing,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  issue: IssueSummary;
  threadRef: ScopedThreadRef | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const projects = useProjects();
  const thread = useThreadShell(threadRef);
  const navigate = useNavigate();
  const configs = useServerConfigs();
  const capabilities = configs.get(environmentId)?.environment.capabilities;
  const { data: repositoryWork } = useEnvironmentQuery(
    capabilities?.issueMilestones === true
      ? issueEnvironment.repositoryStatus({
          environmentId,
          input: { host: reference.host, repository: reference.repository },
        })
      : null,
  );
  const implementation = issueImplementDestination({
    environmentId,
    rootThreadId: repositoryWork?.rootThreadId,
    hasParent: issue.parent != null,
    paused: repositoryWork?.orchestration?.paused === true,
  });
  const project = findIssueProject(
    projects,
    { environmentId, ...reference },
    thread?.projectId ?? null,
  );
  const handleNewThread = useNewThreadHandler();
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const unlink = useAtomCommand(issueEnvironment.unlink, { reportFailure: false });
  const canWrite = useAtomValue(issueEnvironment.setState.permissionAtom(environmentId));
  const canUnlink = useAtomValue(issueEnvironment.unlink.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const confirm = useInlineActionConfirm(`${environmentId}:${issue.url}`);
  const availability = issueMenuAvailability({
    linked: canUnlinkIssue(issue, environmentId, threadRef),
    hasComposer: threadRef !== null || project !== null,
    state: issue.state,
    canWrite,
    canUnlink,
  });
  const { copyToClipboard } = useCopyToClipboard<string>({
    target: "issue reference",
    onCopy: (label) => toastManager.add({ type: "success", title: `${label} copied` }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const paste = async (action: IssueComposerAction) => {
    setPending(true);
    try {
      const opened =
        action !== "implement" && threadRef === null && project !== null
          ? await handleNewThread(scopeProjectRef(project.environmentId, project.id))
          : null;
      const target =
        action === "implement" ? implementation.threadRef : (threadRef ?? opened?.draftId);
      if (!target) {
        throw new Error(
          implementation.disabledReason && action === "implement"
            ? implementation.disabledReason
            : "Add a project for this repository to open a thread.",
        );
      }
      const store = useComposerDraftStore.getState();
      const key = typeof target === "string" ? `draft:${target}` : scopedThreadKey(target);
      const prompt = issueComposerPrompt(action, issue);
      store.setPrompt(
        target,
        handoffPrompt(
          {
            prompt: store.getComposerDraft(target)?.prompt ?? "",
            lastHandoffPrompt: lastHandoffByDraft.get(key),
          },
          prompt,
        ),
      );
      lastHandoffByDraft.set(key, prompt);
      if (
        action === "implement" &&
        typeof target !== "string" &&
        (target.environmentId !== threadRef?.environmentId ||
          target.threadId !== threadRef?.threadId)
      ) {
        await navigate({ to: "/$environmentId/$threadId", params: target });
      }
      toastManager.add({
        type: "success",
        title: "Added to the composer",
        description: "Read it over, then send.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not prepare the composer",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  };
  const write = async (action: "unlink" | "close" | "reopen") => {
    if (action === "unlink" && threadRef === null) return;
    setPending(true);
    const result =
      action === "unlink" && threadRef !== null
        ? await unlink({ environmentId, input: { ...reference, threadId: threadRef.threadId } })
        : await setState({
            environmentId,
            input: { ...reference, state: action === "close" ? "closed" : "open" },
          });
    setPending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not ${action} issue`,
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    onRefresh();
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={refreshing ? "Refreshing issue" : "More issue actions"}
            size="icon-xs"
            variant="ghost-muted"
          />
        }
      >
        {refreshing ? (
          <RefreshCwIcon aria-hidden className="size-4" />
        ) : (
          <MoreHorizontalIcon aria-hidden className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        {availability.unlink ? (
          <MenuItem disabled={pending} onClick={() => void write("unlink")}>
            <UnlinkIcon />
            Unlink from this thread
          </MenuItem>
        ) : null}
        <MenuItem disabled={refreshing} onClick={onRefresh}>
          <RefreshCwIcon />
          Refresh
        </MenuItem>
        <MenuItem disabled={pending || !availability.composer} onClick={() => void paste("ask")}>
          <MessageCircleQuestionIcon />
          Ask a question
        </MenuItem>
        <MenuItem
          disabled={pending || !availability.composer}
          onClick={() => void paste("explain")}
        >
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
        <MenuSeparator />
        <MenuItem render={<a href={issue.url} target="_blank" rel="noopener noreferrer" />}>
          <ExternalLinkIcon />
          Open on GitHub
        </MenuItem>
        <MenuItem onClick={() => copyToClipboard(issue.url, "Issue link")}>
          <LinkIcon />
          Copy link
          <MenuShortcut>
            {shortcutLabelForCommand(keybindings, "thread.copyReference")}
          </MenuShortcut>
        </MenuItem>
        <MenuItem onClick={() => copyToClipboard(`#${issue.number}`, "Issue number")}>
          <CopyIcon />
          Copy issue number
        </MenuItem>
        {availability.close ? (
          <>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={pending}
              closeOnClick={confirm.isArmed("close")}
              aria-label={confirm.isArmed("close") ? "Confirm close?" : "Close issue"}
              {...confirm.props("close", () => void write("close"))}
            >
              <CircleSlashIcon />
              {confirm.isArmed("close") ? "Confirm close?" : "Close issue"}
            </MenuItem>
          </>
        ) : null}
        {availability.reopen ? (
          <>
            <MenuSeparator />
            <MenuItem disabled={pending} onClick={() => void write("reopen")}>
              <Undo2Icon />
              Reopen issue
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
