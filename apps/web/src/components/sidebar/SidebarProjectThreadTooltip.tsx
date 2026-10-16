import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { GitBranchIcon } from "lucide-react";
import { memo, type ReactElement, type ReactNode } from "react";
import { useProject } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { environmentSummaries } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import type { SidebarThreadSummary } from "../../types";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { isThreadPreparingWorktree } from "../ThreadLocationIcon.logic";
import { ThreadPullRequestsMiniList } from "../ThreadStatusIndicators";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { resolveSidebarThreadModelLabel } from "./SidebarBackgroundWork.logic";
import {
  sidebarProjectThreadCheckout,
  sidebarProjectThreadPullRequests,
} from "./SidebarProjectThread.logic";

// One primitive selection per environment: other machines' updates never repaint a thread row.
const remoteMachineAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const machine = get(environmentSummaries.machineByIdAtom).get(environmentId) ?? "desktop";
    return environmentId !== get(primaryEnvironmentIdAtom) || machine === "cloud" ? machine : null;
  }),
);

const SidebarProjectThreadMachine = memo(function SidebarProjectThreadMachine(props: {
  readonly environmentId: EnvironmentId;
}) {
  const machine = useAtomValue(remoteMachineAtom(props.environmentId));
  return machine === null ? null : (
    <EnvironmentMachineIcon
      aria-label="Remote environment"
      kind={machine}
      className="size-3 shrink-0 text-muted-foreground"
    />
  );
});

/** Metadata stays inside the flexible name cell, leaving every existing column in place. */
export const SidebarProjectThreadName = memo(function SidebarProjectThreadName(props: {
  readonly thread: SidebarThreadSummary;
  readonly children: ReactNode;
}) {
  const pr = sidebarProjectThreadPullRequests(props.thread.pullRequests);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate">{props.children}</span>
      <SidebarProjectThreadMachine environmentId={props.thread.environmentId} />
      {pr ? (
        <span
          role="img"
          aria-label={pr.label}
          className={`inline-flex shrink-0 items-center gap-0.5 ${pr.toneClassName}`}
        >
          <pr.Icon aria-hidden className="size-3" />
          {pr.count > 1 ? <span className="text-3xs tabular-nums">{pr.count}</span> : null}
        </span>
      ) : null}
    </span>
  );
});

type ThreadTooltipProps = {
  readonly thread: SidebarThreadSummary;
  readonly provider: ServerProvider | undefined;
};

/** The portal mounts these local-state reads only while its row is hovered; no Git/PR queries. */
function SidebarProjectThreadTooltipPopup({ thread, provider }: ThreadTooltipProps) {
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const identities = useEnvironmentIdentities();
  const machine = useAtomValue(remoteMachineAtom(thread.environmentId));
  const checkout = sidebarProjectThreadCheckout({
    worktreePath: thread.worktreePath,
    projectPath: project?.workspaceRoot,
    preparingWorktree: isThreadPreparingWorktree(thread.source),
  });
  return (
    <ThreadHoverCard
      title={thread.title}
      footer={
        thread.pullRequests.length > 0 ? (
          <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
            <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
          </div>
        ) : null
      }
    >
      <div className="grid min-w-0 gap-1">
        <span className="text-foreground/75">{checkout.label}</span>
        {checkout.path ? (
          <span className="wrap-anywhere font-mono text-2xs">{checkout.path}</span>
        ) : null}
      </div>
      {thread.branch ? (
        <div className="flex min-w-0 items-start gap-2">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="wrap-anywhere">Branch: {thread.branch}</span>
        </div>
      ) : null}
      {machine ? (
        <div className="flex min-w-0 items-center gap-2">
          <EnvironmentMachineIcon aria-hidden kind={machine} className="size-3 shrink-0" />
          <span className="wrap-anywhere">
            {identities.find((entry) => entry.environmentId === thread.environmentId)?.label ??
              "Remote environment"}
          </span>
        </div>
      ) : null}
      <div className="wrap-anywhere">
        Provider: {provider?.displayName ?? thread.providerInstanceId}
      </div>
      <div className="wrap-anywhere">Model: {resolveSidebarThreadModelLabel(thread, provider)}</div>
      {isProviderNativeSubagentThread(thread.source) ? (
        <div>Native subagent · Runs on its own · Open parent to direct it</div>
      ) : null}
    </ThreadHoverCard>
  );
}

/** A full-row trigger also carries checkout identity for rows without a lead location icon. */
export function SidebarProjectThreadTooltip(
  props: ThreadTooltipProps & { readonly render: ReactElement },
) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.render} />
      <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
        <SidebarProjectThreadTooltipPopup thread={props.thread} provider={props.provider} />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}
