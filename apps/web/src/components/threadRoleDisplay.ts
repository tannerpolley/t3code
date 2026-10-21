import {
  effectiveThreadRole,
  isProviderNativeSubagentThread,
  THREAD_ROLE_LABELS,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import {
  BriefcaseIcon,
  HardHatIcon,
  ListChecksIcon,
  NetworkIcon,
  SearchIcon,
  ShieldCheckIcon,
  WrenchIcon,
} from "lucide-react";

export type RoleDisplayThread = Pick<
  OrchestrationV2AppThread,
  "role" | "creationSource" | "branch" | "worktreePath"
> & {
  readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "relationshipToParent">;
};

const ROLE_ICONS = {
  orchestrator: NetworkIcon,
  implementor: WrenchIcon,
  reviewer: ShieldCheckIcon,
  investigator: SearchIcon,
  checker: ListChecksIcon,
};
const ROLE_DESCRIPTIONS = {
  orchestrator: "Coordinates the repository's work and starts workers",
  implementor: "Makes the changes in its own worktree",
  reviewer: "Reviews work read-only",
  investigator: "Gathers evidence and answers questions",
  checker: "Verifies builds and tests",
};

export function threadRoleDisplay(thread: RoleDisplayThread) {
  const native = isProviderNativeSubagentThread(thread);
  const role = effectiveThreadRole(thread);
  const worker = native && role === "implementor";
  // An orchestrator another thread delegated runs one family of work for its parent.
  const manager =
    !native && role === "orchestrator" && thread.lineage.relationshipToParent === "subagent";
  const description = worker
    ? "Carries out work assigned by its parent"
    : manager
      ? "Coordinates a family of work for its parent orchestrator"
      : ROLE_DESCRIPTIONS[role];
  const relationship = native
    ? " · Provider's own subagent · Runs on its own · Open parent to direct it"
    : thread.lineage.relationshipToParent === "subagent"
      ? " · Child thread · You can send messages here"
      : "";
  return {
    label: worker ? "Worker" : manager ? "Manager" : THREAD_ROLE_LABELS[role],
    description: `${description}${relationship}`,
    icon: worker ? HardHatIcon : manager ? BriefcaseIcon : ROLE_ICONS[role],
  };
}
