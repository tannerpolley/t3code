import { useAtomValue } from "@effect/atom-react";
import {
  repositoryPhase,
  CommandId,
  type EnvironmentId,
  type IssueRepositoryRef,
  type ProviderInstanceId,
  type RepositoryOrchestration,
  type ThreadId,
} from "@t3tools/contracts";
import { formatDateTimeShort } from "@t3tools/shared/usageFormat";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ActivityIcon,
  ArrowRightLeftIcon,
  GaugeIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  PauseIcon,
  PlayIcon,
  ReplaceIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { useServerConfigs, useThreadShell, useThreadShellsForProjectRefs } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
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
import { IssueWorkerLimitControl } from "./IssueWorkerLimitControl";
import { useRepositoryLeads } from "./IssueStartAction";

/** Shown only by servers that support repository orchestration. */
function useRepositoryOrchestrationCapability(environmentId: EnvironmentId) {
  const configs = useServerConfigs();
  return configs.get(environmentId)?.environment.capabilities.issueMilestones === true;
}

function useRepositoryWork(environmentId: EnvironmentId, reference: IssueRepositoryRef) {
  const statusAtom = issueEnvironment.repositoryStatus({ environmentId, input: reference });
  const { data } = useEnvironmentQuery(statusAtom);
  return { statusAtom, data, config: data?.orchestration };
}

/** Repository-wide orchestrator ownership, pause and handoff. */
export function IssueRepositoryControls(props: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
}) {
  return useRepositoryOrchestrationCapability(props.environmentId) ? (
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
  const canResume =
    (config != null &&
      (repositoryPhase(config) === "paused" ||
        (repositoryPhase(config) === "handoff_awaiting_approval" && config.paused) ||
        repositoryPhase(config) === "draining")) ||
    (config?.suspendedIssues.length ?? 0) > 0;
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
    repositoryPhase(config) === "draining"
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
      <MetaRow icon={<UsersIcon className="size-3.5" />} label="Read-only">
        <IssueWorkerLimitControl
          key={`read-only:${data.rootThreadId}:${config.revision}`}
          environmentId={environmentId}
          reference={reference}
          config={config}
          pool="readOnly"
          slotsInUse={data.readOnlySlotsInUse}
          onSettled={() => appAtomRegistry.refresh(statusAtom)}
        />
      </MetaRow>
      <MetaRow icon={<GaugeIcon className="size-3.5" />} label="Usage sprint">
        <UsageSprintControl
          key={`sprint:${data.rootThreadId}:${config.revision}`}
          environmentId={environmentId}
          reference={reference}
          config={config}
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
                  disabled={busy || repositoryPhase(config) === "draining"}
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
        .filter((entry) => entry.kind === "closed")
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
              disabled={busy || !canCloseOut || repositoryPhase(config) === "draining"}
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
            {repositoryPhase(config) === "draining"
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
            {repositoryPhase(config) !== "draining" ? (
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

/** Starts a one-time sprint on one Codex or Claude provider, or shows and stops the active one. */
function UsageSprintControl({
  environmentId,
  reference,
  config,
  onSettled,
}: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
  config: RepositoryOrchestration;
  onSettled: () => void;
}) {
  const providers = (useEnvironmentProviders().get(environmentId) ?? []).filter(
    (provider) =>
      provider.enabled && (provider.driver === "codex" || provider.driver === "claudeAgent"),
  );
  const setSprint = useAtomCommand(issueEnvironment.setUsageSprint, { reportFailure: false });
  const canSet = useAtomValue(issueEnvironment.setUsageSprint.permissionAtom(environmentId));
  const [choice, setChoice] = useState<ProviderInstanceId | null>(null);
  const [busy, setBusy] = useState(false);
  const label = (instanceId: ProviderInstanceId) =>
    providers.find((provider) => provider.instanceId === instanceId)?.displayName ?? instanceId;
  const submit = async (providerInstanceId: ProviderInstanceId | null, startedAt?: string) => {
    if (busy) return;
    setBusy(true);
    const result = await setSprint({
      environmentId,
      input: {
        ...reference,
        providerInstanceId,
        ...(startedAt === undefined ? {} : { startedAt }),
        clientRequestId: CommandId.make(randomUUID()),
      },
    });
    setBusy(false);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title:
          providerInstanceId === null
            ? "Could not stop the usage sprint"
            : "Could not start the usage sprint",
        description: formatEnvironmentQueryError(result.cause),
      });
    onSettled();
  };
  const sprint = config.usageSprint;
  if (sprint !== undefined)
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate" role="status">
          {`${label(sprint.providerInstanceId)} until ${formatDateTimeShort(sprint.resetsAt)}`}
        </span>
        <Button
          variant="outline"
          size="xs"
          disabled={busy || !canSet}
          onClick={() => void submit(null, sprint.startedAt)}
        >
          Stop
        </Button>
      </span>
    );
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Select
        items={providers.map((provider) => ({
          value: provider.instanceId,
          label: label(provider.instanceId),
        }))}
        value={choice}
        onValueChange={(value) =>
          setChoice(providers.find((provider) => provider.instanceId === value)?.instanceId ?? null)
        }
      >
        <SelectTrigger size="compact" aria-label="Usage sprint provider">
          <SelectValue placeholder="Off" />
        </SelectTrigger>
        <SelectContent>
          {providers.map((provider) => (
            <SelectItem key={provider.instanceId} value={provider.instanceId}>
              {label(provider.instanceId)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="xs"
        disabled={busy || !canSet || choice === null}
        onClick={() => void submit(choice)}
      >
        Start
      </Button>
    </span>
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
