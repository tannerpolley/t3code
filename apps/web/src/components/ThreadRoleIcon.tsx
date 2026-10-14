import {
  effectiveThreadRole,
  isProviderNativeSubagentThread,
  THREAD_ROLE_LABELS,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import {
  BotIcon,
  ListChecksIcon,
  NetworkIcon,
  SearchIcon,
  ShieldCheckIcon,
  WrenchIcon,
} from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const ROLE_ICONS = {
  orchestrator: NetworkIcon,
  implementor: WrenchIcon,
  reviewer: ShieldCheckIcon,
  investigator: SearchIcon,
  checker: ListChecksIcon,
};

/** Native conversations are provider-controlled; app-owned children accept messages. */
export function ThreadRoleIcon({
  thread,
}: {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "role" | "creationSource" | "branch" | "worktreePath"
  > & {
    readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "relationshipToParent">;
  };
}) {
  const native = isProviderNativeSubagentThread(thread);
  const child = thread.lineage.relationshipToParent === "subagent" && !native;
  const role = effectiveThreadRole(thread);
  const RoleIcon = ROLE_ICONS[role];
  const label = native
    ? `Native subagent · ${THREAD_ROLE_LABELS[role]} · Runs on its own · Open parent to direct it`
    : `${THREAD_ROLE_LABELS[role]}${child ? " · Child thread · You can send messages here" : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="inline-flex shrink-0 text-muted-foreground"
          />
        }
      >
        {native ? <BotIcon aria-hidden className="size-3 shrink-0" /> : null}
        <RoleIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}
