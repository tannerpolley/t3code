import { GitBranchIcon, FolderRootIcon } from "lucide-react";
import {
  useEnvironmentIdentities,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../state/environments";
import type { SidebarThreadSummary } from "../types";
import { isThreadPreparingWorktree, threadLocation } from "./ThreadLocationIcon.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorktreeIcon } from "./WorktreeIcon";

type LocatedThread = Pick<SidebarThreadSummary, "environmentId" | "worktreePath"> & {
  readonly source?: SidebarThreadSummary["source"];
};

// Checkout icons, matching the composer's workspace control. A worktree is the branch glyph, in
// the foreground color like the pull request icons beside it, and muted while it is being made.
// The main checkout takes FolderRoot: the plain folder means the project.
const CHECKOUT_ICON = {
  local: FolderRootIcon,
  worktree: WorktreeIcon,
  preparing: WorktreeIcon,
};

/** The location mark is independent of the row's caret, provider and role. */
export function ThreadLocationIcon({
  thread,
  tooltip = true,
  worktreeStyle = "worktree",
}: {
  readonly thread: LocatedThread;
  readonly worktreeStyle?: "worktree" | "branch" | undefined;
  /** A Projects row supplies its own complete checkout hover. */
  readonly tooltip?: boolean;
}) {
  const location = useThreadLocation(thread);
  const CheckoutIcon =
    worktreeStyle === "branch" && location.kind !== "local"
      ? GitBranchIcon
      : CHECKOUT_ICON[location.kind];
  const icon = (
    <span
      role="img"
      aria-label={location.label}
      className={`inline-flex shrink-0 ${
        CheckoutIcon === WorktreeIcon && location.kind === "worktree"
          ? "text-foreground"
          : "text-muted-foreground"
      }`}
    >
      <CheckoutIcon aria-hidden className="size-3 shrink-0" />
    </span>
  );
  if (!tooltip) return icon;
  return (
    <Tooltip>
      <TooltipTrigger render={icon} />
      <TooltipPopup side="right">{location.label}</TooltipPopup>
    </Tooltip>
  );
}

function useThreadLocation(thread: LocatedThread) {
  const identities = useEnvironmentIdentities();
  const machines = useEnvironmentMachines();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machine = machines.get(thread.environmentId) ?? "desktop";
  const environmentName = identities.find(
    (entry) => entry.environmentId === thread.environmentId,
  )?.label;
  const remote = thread.environmentId !== primaryEnvironmentId || machine === "cloud";
  return threadLocation({
    remote,
    machine,
    environmentName: environmentName ?? (remote ? "Remote environment" : "Local checkout"),
    worktreePath: thread.worktreePath,
    preparingWorktree: isThreadPreparingWorktree(thread.source),
  });
}
