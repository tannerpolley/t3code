import { FolderGit2Icon, FolderIcon } from "lucide-react";
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

/** A Projects header naming one location and its branch, for the threads listed under it. */
export function ThreadLocationHeader({ thread }: { readonly thread: LocatedThread }) {
  const { location } = useThreadLocation(thread);
  return (
    <li className="flex h-5 list-none items-center px-2 text-2xs text-sidebar-muted-foreground/70">
      <span className="min-w-0 truncate">{location.label}</span>
    </li>
  );
}

/** The location mark is independent of the row's caret, provider and role. */
export function ThreadLocationIcon({ thread }: { readonly thread: LocatedThread }) {
  const { location, machine } = useThreadLocation(thread);
  const icon =
    location.kind === "environment" ? (
      <EnvironmentMachineIcon aria-hidden kind={machine} className="size-3 shrink-0" />
    ) : location.kind === "worktree" ? (
      <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
    ) : (
      <FolderIcon aria-hidden className="size-3 shrink-0" />
    );
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
        {icon}
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
