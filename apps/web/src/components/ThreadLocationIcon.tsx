import { FolderGit2Icon, FolderGitIcon, FolderRootIcon, GitBranchIcon } from "lucide-react";
import {
  useEnvironmentIdentities,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../state/environments";
import type { SidebarThreadSummary } from "../types";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { threadLocation } from "./ThreadLocationIcon.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type LocatedThread = Pick<SidebarThreadSummary, "environmentId" | "worktreePath" | "branch"> & {
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

/** A Projects header naming one location and its branch, for the threads listed under it. */
export function ThreadLocationHeader({ thread }: { readonly thread: LocatedThread }) {
  const { location, machine } = useThreadLocation(thread);
  const CheckoutIcon = CHECKOUT_ICON[location.kind];
  return (
    <li
      aria-label={location.label}
      className="flex h-5 min-w-0 list-none items-center gap-1 px-2 text-2xs text-sidebar-muted-foreground/70"
    >
      {location.environment ? (
        <>
          <EnvironmentMachineIcon aria-hidden kind={machine} className="size-3 shrink-0" />
          <span className="min-w-0 shrink-1000 truncate">{location.environment}</span>
        </>
      ) : null}
      <CheckoutIcon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 shrink-100 truncate">{location.checkout}</span>
      {location.branch ? (
        <>
          <GitBranchIcon aria-hidden className="ms-1 size-3 shrink-0" />
          <span className="min-w-0 truncate">{location.branch}</span>
        </>
      ) : null}
    </li>
  );
}

/** The location mark is independent of the row's caret, provider and role. */
export function ThreadLocationIcon({ thread }: { readonly thread: LocatedThread }) {
  const { location } = useThreadLocation(thread);
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
  const location = threadLocation({
    remote,
    machine,
    environmentName: environmentName ?? (remote ? "Remote environment" : "Local checkout"),
    worktreePath: thread.worktreePath,
    branch: thread.branch,
    // App-owned worktree children prepare before their path can be bound.
    preparingWorktree:
      thread.source?.status === "preparing" &&
      thread.source.lineage.relationshipToParent === "subagent" &&
      thread.source.branch !== null,
  });
  return { location, machine };
}
