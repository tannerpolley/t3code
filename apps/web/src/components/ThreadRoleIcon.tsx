import {
  isProviderNativeSubagentThread,
  THREAD_ROLE_LABELS,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import {
  ListChecksIcon,
  MessagesSquareIcon,
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

/**
 * A thread's role, or a generic child mark for children without one. Native and app-owned children
 * share the icon; the tooltip tells them apart (native ones run on their own).
 */
export function ThreadRoleIcon({
  thread,
}: {
  readonly thread: Pick<OrchestrationV2AppThread, "role" | "creationSource"> & {
    readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "relationshipToParent">;
  };
}) {
  const native = isProviderNativeSubagentThread(thread);
  const child = thread.lineage.relationshipToParent === "subagent" && !native;
  if (!native && !thread.role && !child) return null;
  const Icon = thread.role ? ROLE_ICONS[thread.role] : MessagesSquareIcon;
  const label = native
    ? `Native subagent${thread.role ? ` · ${THREAD_ROLE_LABELS[thread.role]}` : ""} · Runs on its own · Open parent to direct it`
    : `${thread.role ? THREAD_ROLE_LABELS[thread.role] : "Child thread"}${child ? `${thread.role ? " · Child thread" : ""} · You can send messages here` : ""}`;
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
        <Icon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}
