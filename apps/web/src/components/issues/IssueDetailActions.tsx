import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  RepositoryIssueRef,
  RepositoryIssueSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
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
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { repositoryIssueEnvironment } from "~/state/repositoryIssues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useInlineActionConfirm } from "../pullRequest/useInlineActionConfirm";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger, MenuShortcut } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { canUnlinkIssue, issueMenuAvailability } from "./issueDetailActions.logic";
import { useIssueComposerHandoff } from "./useIssueComposerHandoff";

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
  reference: RepositoryIssueRef;
  issue: RepositoryIssueSummary;
  threadRef: ScopedThreadRef | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const handoff = useIssueComposerHandoff({ environmentId, reference, issue, threadRef });
  const { implementation, paste } = handoff;
  const setState = useAtomCommand(repositoryIssueEnvironment.setState, { reportFailure: false });
  const unlink = useAtomCommand(repositoryIssueEnvironment.unlink, { reportFailure: false });
  const canWrite = useAtomValue(repositoryIssueEnvironment.setState.permissionAtom(environmentId));
  const canUnlink = useAtomValue(repositoryIssueEnvironment.unlink.permissionAtom(environmentId));
  const [writing, setWriting] = useState(false);
  const pending = writing || handoff.pending;
  const confirm = useInlineActionConfirm(`${environmentId}:${issue.url}`);
  const availability = issueMenuAvailability({
    linked: canUnlinkIssue(issue, environmentId, threadRef),
    hasComposer: handoff.hasComposer,
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
  const write = async (action: "unlink" | "close" | "reopen") => {
    if (action === "unlink" && threadRef === null) return;
    setWriting(true);
    const result =
      action === "unlink" && threadRef !== null
        ? await unlink({ environmentId, input: { ...reference, threadId: threadRef.threadId } })
        : await setState({
            environmentId,
            input: { ...reference, state: action === "close" ? "closed" : "open" },
          });
    setWriting(false);
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
