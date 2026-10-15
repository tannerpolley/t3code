import { FolderGit2Icon, FolderGitIcon, FolderRootIcon } from "lucide-react";
import {
  useEnvironmentIdentities,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../state/environments";
import type { SidebarThreadSummary } from "../types";
import { threadLocation } from "./ThreadLocationIcon.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type LocatedThread = Pick<SidebarThreadSummary, "environmentId" | "worktreePath"> & {
  readonly source?: SidebarThreadSummary["source"];
};

// Checkout icons, matching the composer's workspace control: an existing worktree is
// FolderGit and a worktree still being made is FolderGit2. The main checkout takes FolderRoot,
// because the plain folder means the project and the computer means the environment.
const CHECKOUT_ICON = {
  local: FolderRootIcon,
  worktree: FolderGitIcon,
  preparing: FolderGit2Icon,
};

/** The location mark is independent of the row's caret, provider and role. */
export function ThreadLocationIcon({ thread }: { readonly thread: LocatedThread }) {
  const location = useThreadLocation(thread);
  const CheckoutIcon = CHECKOUT_ICON[location.kind];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={location.label}
            className="inline-flex shrink-0 text-muted-foreground"
          />
        }
      >
        <CheckoutIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
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
    // App-owned worktree children prepare before their path can be bound.
    preparingWorktree:
      thread.source?.status === "preparing" &&
      thread.source.lineage.relationshipToParent === "subagent" &&
      thread.source.branch !== null,
  });
}
