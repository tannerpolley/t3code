import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import {
  effectiveThreadRole,
  isProviderNativeSubagentThread,
  type ThreadRole,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import {
  BriefcaseIcon,
  PencilRulerIcon,
  PenLineIcon,
  HardHatIcon,
  NetworkIcon,
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
  designer: PencilRulerIcon,
  writer: PenLineIcon,
  implementor: WrenchIcon,
  reviewer: ShieldCheckIcon,
};
const ROLE_LABELS = {
  orchestrator: msg("Orchestrator"),
  designer: msg("Designer", { $context: "agent role" }),
  writer: msg("Writer", { $context: "agent role" }),
  implementor: msg("Implementor"),
  reviewer: msg("Reviewer"),
} satisfies Record<ThreadRole, string>;

export function threadRoleLabel(role: ThreadRole, resolve: MessageResolver = m) {
  return resolve(ROLE_LABELS[role]);
}

const ROLE_DESCRIPTIONS = {
  designer: msg("Gathers evidence and plans issues"),
  writer: msg("Writes deliverables with your direct guidance"),
  orchestrator: msg("Coordinates the repository's work and starts workers"),
  implementor: msg("Makes the changes in its own worktree"),
  reviewer: msg("Reviews work read-only"),
};

export function threadRoleDisplay(thread: RoleDisplayThread, resolve: MessageResolver = m) {
  const native = isProviderNativeSubagentThread(thread);
  const role = effectiveThreadRole(thread);
  const worker = native && role === "implementor";
  // An orchestrator another thread delegated runs one family of work for its parent.
  const manager =
    !native && role === "orchestrator" && thread.lineage.relationshipToParent === "subagent";
  const description = worker
    ? resolve(msg("Carries out work assigned by its parent"))
    : manager
      ? resolve(msg("Coordinates a family of work for its parent orchestrator"))
      : resolve(ROLE_DESCRIPTIONS[role]);
  const relationship = native
    ? resolve(msg(" · Provider's own subagent · Runs on its own · Open parent to direct it"))
    : thread.lineage.relationshipToParent === "subagent"
      ? resolve(msg(" · Child thread · You can send messages here"))
      : "";
  return {
    label: worker
      ? resolve(msg("Worker"))
      : manager
        ? resolve(msg("Manager"))
        : threadRoleLabel(role, resolve),
    description: `${description}${relationship}`,
    icon: worker ? HardHatIcon : manager ? BriefcaseIcon : ROLE_ICONS[role],
  };
}
