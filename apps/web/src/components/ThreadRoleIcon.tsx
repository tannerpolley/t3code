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
import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const ROLE_ICONS = {
  orchestrator: NetworkIcon,
  implementor: WrenchIcon,
  reviewer: ShieldCheckIcon,
  investigator: SearchIcon,
  checker: ListChecksIcon,
};

type RoleIconThread = Pick<
  OrchestrationV2AppThread,
  "role" | "creationSource" | "branch" | "worktreePath"
> & {
  readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "relationshipToParent">;
};

const NATIVE_SUBAGENT_LABEL = "Native subagent · Runs on its own · Open parent to direct it";

/**
 * The robot mark of a provider-controlled subagent. Column rows put it in the location column,
 * which a native subagent never uses, so the role icon keeps its own column.
 */
export function NativeSubagentMark() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={NATIVE_SUBAGENT_LABEL}
            className="inline-flex shrink-0 text-muted-foreground"
          />
        }
      >
        <BotIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup side="right">{NATIVE_SUBAGENT_LABEL}</TooltipPopup>
    </Tooltip>
  );
}

/** A column row's location cell: the robot for a native subagent, else `location`. */
export function threadLocationCell(
  thread: Pick<RoleIconThread, "creationSource" | "lineage">,
  location: ReactNode,
): ReactNode {
  return isProviderNativeSubagentThread(thread) ? <NativeSubagentMark /> : location;
}

/**
 * The role the thread works as. Native conversations are provider-controlled; app-owned children
 * accept messages. `nativeMark` draws the robot before the role icon; column rows pass false and
 * place `NativeSubagentMark` in the location column instead.
 */
export function ThreadRoleIcon({
  thread,
  nativeMark = true,
}: {
  readonly thread: RoleIconThread;
  readonly nativeMark?: boolean;
}) {
  const native = isProviderNativeSubagentThread(thread);
  const child = thread.lineage.relationshipToParent === "subagent" && !native;
  const role = effectiveThreadRole(thread);
  const RoleIcon = ROLE_ICONS[role];
  const label = `${THREAD_ROLE_LABELS[role]}${child ? " · Child thread · You can send messages here" : ""}`;
  const roleIcon = (
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
        <RoleIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
  return native && nativeMark ? (
    <>
      <NativeSubagentMark />
      {roleIcon}
    </>
  ) : (
    roleIcon
  );
}
