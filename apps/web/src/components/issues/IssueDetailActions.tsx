import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  RepositoryIssueRef,
  RepositoryIssueSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { CopyIcon, MoreHorizontalIcon, RefreshCwIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { repositoryIssueEnvironment } from "~/state/repositoryIssues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { canUnlinkIssue } from "./issueDetailActions.logic";

/**
 * The fork's issue actions upstream's panel lacks: removing an old `link_issue` link, refreshing
 * the work data, and copying the number. Upstream's panel owns state, links and opening.
 */
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
  const unlink = useAtomCommand(repositoryIssueEnvironment.unlink, { reportFailure: false });
  const canUnlink = useAtomValue(repositoryIssueEnvironment.unlink.permissionAtom(environmentId));
  const [writing, setWriting] = useState(false);
  const { copyToClipboard } = useCopyToClipboard<string>({
    target: "issue reference",
    onCopy: (label) => toastManager.add({ type: "success", title: `${label} copied` }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const removeLink = async () => {
    if (threadRef === null) return;
    setWriting(true);
    const result = await unlink({
      environmentId,
      input: { ...reference, threadId: threadRef.threadId },
    });
    setWriting(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not unlink issue",
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
        {canUnlink && canUnlinkIssue(issue, environmentId, threadRef) ? (
          <MenuItem disabled={writing} onClick={() => void removeLink()}>
            <UnlinkIcon />
            Unlink from this thread
          </MenuItem>
        ) : null}
        <MenuItem disabled={refreshing} onClick={onRefresh}>
          <RefreshCwIcon />
          Refresh
        </MenuItem>
        <MenuItem onClick={() => copyToClipboard(`#${issue.number}`, "Issue number")}>
          <CopyIcon />
          Copy issue number
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
