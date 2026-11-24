import { T, useGT } from "gt-react";
import type { RepositoryIssueSummary } from "@t3tools/contracts";
import { CopyIcon, MoreHorizontalIcon, RefreshCwIcon } from "lucide-react";

import { namedClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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
  const gt = useGT();
  const { copyToClipboard } = useCopyToClipboard<string>({
    target: namedClipboardTarget("issue reference"),
    onCopy: (label) => toastManager.add({ type: "success", title: `${label} copied` }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={refreshing ? gt("Refreshing issue") : gt("More issue actions")}
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
          <T>Refresh</T>
        </MenuItem>
        <MenuItem onClick={() => copyToClipboard(`#${issue.number}`, "Issue number")}>
          <CopyIcon />
          <T>Copy issue number</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
