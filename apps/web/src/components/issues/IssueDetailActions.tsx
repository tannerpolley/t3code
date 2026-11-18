import type { RepositoryIssueSummary } from "@t3tools/contracts";
import { CopyIcon, MoreHorizontalIcon, RefreshCwIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

/**
 * The fork's issue actions upstream's panel lacks: refreshing the work data and copying the
 * number. Upstream's panel owns state, links and opening.
 */
export function IssueDetailActions({
  issue,
  refreshing,
  onRefresh,
}: {
  issue: RepositoryIssueSummary;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { copyToClipboard } = useCopyToClipboard<string>({
    target: "issue reference",
    onCopy: (label) => toastManager.add({ type: "success", title: `${label} copied` }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
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
