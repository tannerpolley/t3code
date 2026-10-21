import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  CLOSED_ISSUE_SUSPENSION_REASON,
  DEFAULT_REPOSITORY_WORK_SETTINGS,
  type EnvironmentId,
  type IssueMilestone,
  type IssueRepositoryRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ActivityIcon,
  ArrowRightLeftIcon,
  ListStartIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  PauseIcon,
  PlayIcon,
  ReplaceIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  useProjects,
  useServerConfigs,
  useThreadShell,
  useThreadShellsForProjectRefs,
} from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { randomUUID } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { MetaRow } from "../pullRequest/PullRequestSummaryTab";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { findIssueProject } from "./issueWorktree.logic";
import { IssueWorkerLimitControl } from "./IssueWorkerLimitControl";
import { useRepositoryLeads } from "./IssueStartAction";

/** Shown only by servers that support repository orchestration. */
function useIssueMilestonesCapability(environmentId: EnvironmentId) {
  const configs = useServerConfigs();
  return configs.get(environmentId)?.environment.capabilities.issueMilestones === true;
}

function useRepositoryWork(environmentId: EnvironmentId, reference: IssueRepositoryRef) {
  const statusAtom = issueEnvironment.repositoryStatus({ environmentId, input: reference });
  const { data } = useEnvironmentQuery(statusAtom);
  return { statusAtom, data, config: data?.orchestration };
}

/** Repository-wide orchestrator ownership, pause and handoff; independent of milestone rows. */
export function IssueRepositoryControls(props: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
}) {
  return useIssueMilestonesCapability(props.environmentId) ? (
    <RepositoryControls {...props} />
  ) : null;
}

function RepositoryControls({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
}) {
  const { statusAtom, data, config } = useRepositoryWork(environmentId, reference);
  const navigate = useNavigate();
  const issueThreads = useThreadShellsForProjectRefs(
    config?.suspendedIssues.length ? [scopeProjectRef(environmentId, config.projectId)] : [],
  );
  const root = useThreadShell(
    data?.rootThreadId == null ? null : scopeThreadRef(environmentId, data.rootThreadId),
  );
  const openRoot = (threadId: ThreadId) =>
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  const canResume = config?.paused === true || (config?.suspendedIssues.length ?? 0) > 0;
  const [busy, setBusy] = useState(false);
  const [handoffExpanded, setHandoffExpanded] = useState(false);
  const [summary, setSummary] = useState("");
  const closeOut = useAtomCommand(issueEnvironment.closeOut, { reportFailure: false });
  const canCloseOut = useAtomValue(issueEnvironment.closeOut.permissionAtom(environmentId));
  const pause = useAtomCommand(issueEnvironment.setPaused, { reportFailure: false });
  const handoff = useAtomCommand(issueEnvironment.handoff, { reportFailure: false });
  const restore = useAtomCommand(issueEnvironment.restoreRoot, { reportFailure: false });
  const canRestore = useAtomValue(issueEnvironment.restoreRoot.permissionAtom(environmentId));
  const [restoreExpanded, setRestoreExpanded] = useState(false);
  const [restoreTargetId, setRestoreTargetId] = useState<ThreadId | null>(null);
  const restoreCandidates = useRepositoryLeads(
    environmentId,
    config?.projectId ?? null,
    reference,
  ).filter((lead) => lead.id !== data?.rootThreadId);
  if (config == null || data?.rootThreadId == null) return null;
  const restoreTarget = restoreCandidates.find((lead) => lead.id === restoreTargetId);
  const replaceRoot = async () => {
    if (busy || !config.paused || restoreTarget === undefined) return;
    setBusy(true);
    const result = await restore({
      environmentId,
      input: {
        ...reference,
        repositoryId: config.repositoryId,
        projectId: config.projectId,
        expectedRootThreadId: data.rootThreadId,
        expectedRevision: config.revision,
        targetThreadId: restoreTarget.id,
        reason: "Chose another thread as orchestrator from the Issues page",
        clientRequestId: CommandId.make(randomUUID()),
      },
    });
    setBusy(false);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: "Could not change the repository orchestrator",
        description: formatEnvironmentQueryError(result.cause),
      });
    else {
      setRestoreExpanded(false);
      setRestoreTargetId(null);
      toastManager.add({
        type: "success",
        title: "Repository orchestrator changed",
        description: "Repository work remains paused. Choose Resume repository work to continue.",
      });
    }
    appAtomRegistry.refresh(statusAtom);
  };
  const transfer = async (action: "approve" | "cancel") => {
    if (busy) return;
    setBusy(true);
    const common = {
      ...reference,
      expectedRevision: config.revision,
      clientRequestId: CommandId.make(randomUUID()),
    };
    const result = await handoff({
      environmentId,
      input:
        action === "cancel"
          ? { ...common, action }
          : {
              ...common,
              action,
              summary: config.handoff?.summary ?? summary.trim(),
              ...(config.handoff === undefined
                ? {}
                : { modelSelection: config.handoff.modelSelection }),
            },
    });
    setBusy(false);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: "Could not hand off repository work",
        description: formatEnvironmentQueryError(result.cause),
      });
    else {
      setHandoffExpanded(false);
      setSummary("");
    }
    appAtomRegistry.refresh(statusAtom);
  };
  const finishAttempt = async (issueId: string) => {
    if (busy || !canCloseOut) return;
    setBusy(true);
    const result = await closeOut({
      environmentId,
      input: {
        ...reference,
        issueId,
        expectedRevision: config.revision,
        clientRequestId: CommandId.make(randomUUID()),
      },
    });
    setBusy(false);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: "Could not close out the issue attempt",
        description: formatEnvironmentQueryError(result.cause),
      });
    appAtomRegistry.refresh(statusAtom);
  };
  const togglePause = async () => {
    if (busy) return;
    setBusy(true);
    const result = await pause({
      environmentId,
      input: { ...reference, paused: !canResume, clientRequestId: CommandId.make(randomUUID()) },
    });
    setBusy(false);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: "Could not update repository work",
        description: formatEnvironmentQueryError(result.cause),
      });
    else appAtomRegistry.refresh(statusAtom);
  };
  const suspended = config.suspendedIssues.length;
  const status =
    config.handoff?.status === "draining"
      ? "Handing off"
      : config.paused
        ? "Paused"
        : suspended > 0
          ? `Active, ${suspended} ${suspended === 1 ? "issue" : "issues"} on hold`
          : "Active";
  const pauseLabel = canResume ? "Resume repository work" : "Pause repository work";
  const canHandOff = config.handoff === undefined;
  return (
    <section aria-label="Repository orchestration" className="flex flex-col gap-1.5 px-2 pt-1 pb-2">
      <MetaRow icon={<NetworkIcon className="size-3.5" />} label="Orchestrator">
        <span className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            className="min-w-0 truncate text-left underline-offset-2 hover:underline"
            onClick={() => openRoot(data.rootThreadId!)}
          >
            {root?.title ?? data.rootThreadId}
          </button>
          {canHandOff || (config.handoffHistory?.length ?? 0) > 0 ? (
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost" size="icon-xs" aria-label="Orchestrator actions" />}
              >
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup align="start">
                {canHandOff ? (
                  <MenuItem disabled={busy} onClick={() => setHandoffExpanded(true)}>
                    <ArrowRightLeftIcon className="size-3.5" />
                    Hand off to a fresh thread
                  </MenuItem>
                ) : null}
                {canHandOff && canRestore ? (
                  <MenuItem disabled={busy} onClick={() => setRestoreExpanded(true)}>
                    <ReplaceIcon className="size-3.5" />
                    Use another thread as orchestrator
                  </MenuItem>
                ) : null}
                {config.handoffHistory?.length ? (
                  <>
                    {canHandOff ? <MenuSeparator /> : null}
                    <MenuGroup>
                      <MenuGroupLabel>Previous orchestrators</MenuGroupLabel>
                      {config.handoffHistory.map((entry) => (
                        <PreviousRootItem
                          key={entry.threadId}
                          environmentId={environmentId}
                          threadId={entry.threadId}
                          transferredAt={entry.transferredAt}
                          onOpen={openRoot}
                        />
                      ))}
                    </MenuGroup>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
        </span>
      </MetaRow>
      <MetaRow icon={<UsersIcon className="size-3.5" />} label="Workers">
        <IssueWorkerLimitControl
          key={`${data.rootThreadId}:${config.revision}`}
          environmentId={environmentId}
          reference={reference}
          config={config}
          slotsInUse={data.slotsInUse}
          onSettled={() => appAtomRegistry.refresh(statusAtom)}
        />
      </MetaRow>
      <MetaRow icon={<ActivityIcon className="size-3.5" />} label="Status">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate" role="status">
            {status}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={pauseLabel}
                  disabled={busy || config.handoff?.status === "draining"}
                  onClick={() => void togglePause()}
                />
              }
            >
              {canResume ? <PlayIcon /> : <PauseIcon />}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{pauseLabel}</TooltipPopup>
          </Tooltip>
        </span>
      </MetaRow>
      {config.suspendedIssues
        .filter((entry) => entry.reason === CLOSED_ISSUE_SUSPENSION_REASON)
        .map((entry) => (
          <div key={entry.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              {issueThreads.find((thread) => thread.linkedIssue?.id === entry.id)?.title ??
                "Closed issue"}
              : {entry.reason}
            </span>
            <Button
              variant="outline"
              size="xs"
              disabled={busy || !canCloseOut || config.handoff?.status === "draining"}
              onClick={() => void finishAttempt(entry.id)}
            >
              Close out attempt
            </Button>
          </div>
        ))}
      {restoreExpanded && config.handoff === undefined ? (
        <div className="flex w-full max-w-md flex-col gap-2 pt-1">
          <span className="text-xs text-muted-foreground">
            Pause the repository first. The current orchestrator must be stopped, with no active
            issue workers or unclaimed start requests. Existing issue workers keep their threads.
          </span>
          <Select
            items={restoreCandidates.map((lead) => ({ value: lead.id, label: lead.title }))}
            value={restoreTarget?.id ?? null}
            onValueChange={(value) =>
              setRestoreTargetId(restoreCandidates.find((lead) => lead.id === value)?.id ?? null)
            }
          >
            <SelectTrigger size="compact" aria-label="New repository orchestrator">
              <SelectValue placeholder="Choose a lead thread" />
            </SelectTrigger>
            <SelectContent>
              {restoreCandidates.map((lead) => (
                <SelectItem key={lead.id} value={lead.id}>
                  {lead.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {restoreCandidates.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              No other top-level thread in this project can lead.
            </span>
          ) : null}
          <div className="flex justify-end gap-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => setRestoreExpanded(false)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={busy || !config.paused || restoreTarget === undefined}
              onClick={() => void replaceRoot()}
            >
              Make orchestrator
            </Button>
          </div>
        </div>
      ) : null}
      {config.handoff || handoffExpanded ? (
        <div className="flex w-full max-w-md flex-col gap-2 pt-1">
          <span className="text-xs text-muted-foreground" role="status">
            {config.handoff?.status === "draining"
              ? "Handoff is pending while existing work finishes and the recovery inventory is prepared. The current root keeps ownership until then."
              : "Approve a fresh thread after existing work finishes. Routine model changes can keep the current thread."}
          </span>
          {config.handoff ? (
            <p className="break-words whitespace-pre-wrap text-xs">
              {config.handoff.summary}
              <br />
              Next model: {config.handoff.modelSelection.instanceId} /{" "}
              {config.handoff.modelSelection.model}
            </p>
          ) : (
            <Textarea
              aria-label="Handoff summary"
              placeholder="Summarize decisions and remaining work for the new root"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          )}
          <div className="flex justify-end gap-1">
            {config.handoff ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void transfer("cancel")}
              >
                Cancel handoff
              </Button>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setHandoffExpanded(false)}
              >
                Cancel
              </Button>
            )}
            {config.handoff?.status !== "draining" ? (
              <Button
                size="xs"
                disabled={busy || (config.handoff === undefined && summary.trim().length === 0)}
                onClick={() => void transfer("approve")}
              >
                Approve fresh-thread handoff
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** A menu entry per earlier orchestrator, named by its thread title once loaded. */
function PreviousRootItem({
  environmentId,
  threadId,
  transferredAt,
  onOpen,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  transferredAt: string;
  onOpen: (threadId: ThreadId) => void;
}) {
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  return (
    <MenuItem onClick={() => onOpen(threadId)}>
      <span className="min-w-0 flex-1 truncate">{thread?.title ?? threadId}</span>
      <span className="shrink-0 text-muted-foreground">
        <RelativeTime timestamp={transferredAt} />
      </span>
    </MenuItem>
  );
}

export function IssueMilestoneControls(props: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
  milestone: IssueMilestone;
}) {
  return useIssueMilestonesCapability(props.environmentId) ? <Controls {...props} /> : null;
}

function Controls({
  environmentId,
  reference,
  milestone,
}: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
  milestone: IssueMilestone;
}) {
  const projects = useProjects();
  const roles = useEnvironmentSettings(environmentId, (settings) => settings.modelRoles);
  const { statusAtom, config } = useRepositoryWork(environmentId, reference);
  const project = findIssueProject(
    projects.filter((entry) => config == null || entry.id === config.projectId),
    { environmentId, ...reference },
    null,
  );
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [roleId, setRoleId] = useState<string | null>(null);
  const role =
    roles.find((entry) => entry.id === roleId) ??
    roles.find((entry) => entry.id !== "orchestrator") ??
    roles[0];
  const plan = config?.milestones.find((entry) => entry.number === milestone.number);
  const work = useAtomCommand(issueEnvironment.workMilestone, { reportFailure: false });
  const start = async () => {
    if (busy || project === null || role === undefined) return;
    setBusy(true);
    const result = await work({
      environmentId,
      input: {
        ...reference,
        milestoneNumber: milestone.number,
        projectId: project.id,
        modelRoleId: role.id,
        clientRequestId: CommandId.make(randomUUID()),
      },
    });
    setBusy(false);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: "Could not update repository work",
        description: formatEnvironmentQueryError(result.cause),
      });
    else {
      setExpanded(false);
      appAtomRegistry.refresh(statusAtom);
    }
  };
  return (
    <div className="flex max-w-full shrink-0 flex-col items-end gap-1">
      <div className="flex min-h-8 items-center gap-1 pe-2">
        {plan ? (
          <span className="text-2xs text-muted-foreground">
            {config?.paused ? "Paused" : plan.status.replaceAll("_", " ")}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Work through milestone"
                aria-expanded={expanded}
                disabled={busy || project === null || milestone.state === "closed"}
                onClick={() => setExpanded(!expanded)}
              />
            }
          >
            <ListStartIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Work through milestone</TooltipPopup>
        </Tooltip>
      </div>
      {expanded ? (
        <div className="flex flex-col gap-2 p-2">
          <Select value={role?.id ?? ""} onValueChange={setRoleId}>
            <SelectTrigger size="sm">
              <SelectValue placeholder="Worker model role" />
            </SelectTrigger>
            <SelectContent>
              {roles.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            Up to {config?.workerLimit ?? DEFAULT_REPOSITORY_WORK_SETTINGS.workerLimit} workers
            across the repository, each in a new issue-named worktree from the default branch. T3
            publishes status and closeout comments.
          </span>
          <Button size="xs" disabled={busy || role === undefined} onClick={() => void start()}>
            Start milestone work
          </Button>
        </div>
      ) : null}
    </div>
  );
}
