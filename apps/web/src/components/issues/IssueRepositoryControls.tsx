import { useAtomValue } from "@effect/atom-react";
import {
  repositoryPhase,
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type IssueRepositoryRef,
  type RepositoryOrchestration,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ArrowRightLeftIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  ReplaceIcon,
} from "lucide-react";
import { useGT } from "gt-react";
import { useState } from "react";
import { useServerConfigs, useThreadShell, useThreadShellsForProjectRefs } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { orchestrationEnvironment } from "~/state/orchestration";
import { repositoryIssueEnvironment } from "~/state/repositoryIssues";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { randomUUID } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { useDeadlinePassed } from "~/hooks/useDeadline";
import { Badge } from "../ui/badge";
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
import { projectIssueRepositories, repositoryWorkStatus } from "./issueWorkspace.logic";

/** Shown only by servers that support repository orchestration. */
function useRepositoryOrchestrationCapability(environmentId: EnvironmentId) {
  const configs = useServerConfigs();
  return configs.get(environmentId)?.environment.capabilities.issueMilestones === true;
}

function useRepositoryWork(environmentId: EnvironmentId, reference: IssueRepositoryRef) {
  const statusAtom = repositoryIssueEnvironment.repositoryStatus({
    environmentId,
    input: reference,
  });
  const { data } = useEnvironmentQuery(statusAtom);
  return { statusAtom, data, config: data?.orchestration };
}

const REPOSITORY_ORCHESTRATION_SECTION_ID = "repository-orchestration";

/** Project settings section for each repository the project group's checkouts belong to. */
export function ProjectRepositoryOrchestration({
  members,
}: {
  members: Parameters<typeof projectIssueRepositories>[0];
}) {
  const environments = useEnvironments().environments;
  const repositories = projectIssueRepositories(members);
  return repositories.map((entry, index) => (
    <IssueRepositoryControls
      key={`${entry.environmentId}:${entry.host}/${entry.repository}`}
      environmentId={entry.environmentId}
      reference={{ host: entry.host, repository: entry.repository }}
      {...(repositories.length > 1
        ? {
            title: `Repository orchestration: ${entry.repository} on ${
              environments.find((environment) => environment.environmentId === entry.environmentId)
                ?.label ?? entry.environmentId
            }`,
          }
        : {})}
      {...(index === 0 ? { id: REPOSITORY_ORCHESTRATION_SECTION_ID } : {})}
    />
  ));
}

/** Repository-wide orchestrator ownership, limits, pause and handoff. */
export function IssueRepositoryControls(props: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
  title?: string;
  id?: string;
}) {
  return useRepositoryOrchestrationCapability(props.environmentId) ? (
    <RepositoryControls {...props} />
  ) : null;
}

/** The Issues pane's one-line pointer to the settings section, shown only while it needs attention. */
export function IssueRepositoryStatusLine(props: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
}) {
  return useRepositoryOrchestrationCapability(props.environmentId) ? (
    <RepositoryStatusLine {...props} />
  ) : null;
}

function RepositoryStatusLine({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
}) {
  const { data, config } = useRepositoryWork(environmentId, reference);
  if (config == null) return null;
  const status = repositoryWorkStatus(config, data?.idMismatch);
  if (!status.needsAttention) return null;
  return (
    <div className="flex items-center gap-2 px-2 pt-1 pb-2 text-xs text-muted-foreground">
      <span role="status" className="min-w-0 truncate">
        {status.label}
      </span>
      <SettingsLink environmentId={environmentId} projectId={config.projectId} />
    </div>
  );
}

/** Mounted only while the line shows, so an active repository does not build project groups. */
function SettingsLink({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const navigate = useNavigate();
  const group = useSettingsProjectGroups().find((entry) =>
    entry.memberProjects.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    ),
  );
  if (group === undefined) return null;
  return (
    <Button
      variant="link"
      size="xs"
      onClick={() =>
        void navigate({
          to: "/settings/projects",
          search: { project: group.projectKey, machine: environmentId, checkout: undefined },
          hash: REPOSITORY_ORCHESTRATION_SECTION_ID,
        })
      }
    >
      Project settings
    </Button>
  );
}

function RepositoryControls({
  environmentId,
  reference,
  title = "Repository orchestration",
  id,
}: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
  title?: string;
  id?: string;
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
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [handoffExpanded, setHandoffExpanded] = useState(false);
  const [summary, setSummary] = useState("");
  const closeOut = useAtomCommand(repositoryIssueEnvironment.closeOut, { reportFailure: false });
  const canCloseOut = useAtomValue(
    repositoryIssueEnvironment.closeOut.permissionAtom(environmentId),
  );
  const endRepository = useAtomCommand(repositoryIssueEnvironment.endRepository, {
    reportFailure: false,
  });
  const canEnd = useAtomValue(
    repositoryIssueEnvironment.endRepository.permissionAtom(environmentId),
  );
  const pause = useAtomCommand(repositoryIssueEnvironment.setPaused, { reportFailure: false });
  const handoff = useAtomCommand(repositoryIssueEnvironment.handoff, { reportFailure: false });
  const restore = useAtomCommand(repositoryIssueEnvironment.restoreRoot, { reportFailure: false });
  const canRestore = useAtomValue(
    repositoryIssueEnvironment.restoreRoot.permissionAtom(environmentId),
  );
  const [restoreExpanded, setRestoreExpanded] = useState(false);
  const [restoreTargetId, setRestoreTargetId] = useState<ThreadId | null>(null);
  const restoreCandidates = useRepositoryLeads(
    environmentId,
    config?.projectId ?? null,
    reference,
  ).filter((lead) => lead.id !== data?.rootThreadId);
  if (data == null) return null;
  if (config == null || data.rootThreadId == null)
    return (
      <SettingsSection title={title} {...(id === undefined ? {} : { id })}>
        <SettingsRow
          title="Orchestrator"
          description="No orchestrator yet. Start an agent on an issue, or choose Make repository orchestrator from a thread's menu."
        />
      </SettingsSection>
    );
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
        reason: "Chose another thread as orchestrator from Project settings",
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
          : { ...common, action, summary: summary.trim() },
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
  const end = async () => {
    if (busy || !canEnd) return;
    setBusy(true);
    const result = await endRepository({
      environmentId,
      input: {
        ...reference,
        expectedRevision: config.revision,
        clientRequestId: CommandId.make(randomUUID()),
      },
    });
    setBusy(false);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: "Could not end repository orchestration",
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
  const status = repositoryWorkStatus(config, data.idMismatch);
  const pauseLabel = canResume ? "Resume repository work" : "Pause repository work";
  const canHandOff = config.handoff === undefined;
  return (
    <SettingsSection title={title} {...(id === undefined ? {} : { id })}>
      <SettingsRow
        title="Orchestrator"
        description="The thread that starts and coordinates issue work for this repository."
        control={
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
                  render={
                    <Button variant="ghost" size="icon-xs" aria-label="Orchestrator actions" />
                  }
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuItem disabled={busy || !canEnd} onClick={() => void end()}>
                    End repository orchestration
                  </MenuItem>
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
                    <PreviousRootsMenu
                      environmentId={environmentId}
                      history={config.handoffHistory}
                      separator={canHandOff}
                      onOpen={openRoot}
                    />
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
          </span>
        }
      >
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
        {config.handoff ? (
          <PendingHandoffLine
            environmentId={environmentId}
            handoff={config.handoff}
            busy={busy}
            onCancel={() => void transfer("cancel")}
          />
        ) : handoffExpanded ? (
          <div className="flex w-full max-w-md flex-col gap-2 pt-1">
            <span className="text-xs text-muted-foreground">
              {gt(
                "T3 pauses new issue starts while existing work finishes, then hands off to a fresh thread.",
              )}
            </span>
            <Textarea
              aria-label="Handoff summary"
              placeholder="Summarize decisions and remaining work for the new root"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
            <div className="flex justify-end gap-1">
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setHandoffExpanded(false)}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                disabled={busy || summary.trim().length === 0}
                onClick={() => void transfer("approve")}
              >
                {gt("Start handoff")}
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Workers"
        description="How many issue workers can run at once."
        control={
          <IssueWorkerLimitControl
            key={`${data.rootThreadId}:${config.revision}`}
            environmentId={environmentId}
            reference={reference}
            config={config}
            slotsInUse={data.slotsInUse}
            onSettled={() => appAtomRegistry.refresh(statusAtom)}
          />
        }
      />
      <SettingsRow
        title="Read-only"
        description="How many read-only agents, such as designers and reviewers, can run at once."
        control={
          <IssueWorkerLimitControl
            key={`read-only:${data.rootThreadId}:${config.revision}`}
            environmentId={environmentId}
            reference={reference}
            config={config}
            pool="readOnly"
            slotsInUse={data.readOnlySlotsInUse}
            onSettled={() => appAtomRegistry.refresh(statusAtom)}
          />
        }
      />
      <SettingsRow
        title="Status"
        description="Pause stops new issue work from starting; resume continues it."
        control={
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate" role="status">
              {status.label}
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
        }
      >
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
      </SettingsRow>
    </SettingsSection>
  );
}

const STALE_HANDOFF_MS = 24 * 60 * 60 * 1000;

/** The summary is agent-facing and goes to the successor thread, so settings show only this line. */
function PendingHandoffLine({
  environmentId,
  handoff,
  busy,
  onCancel,
}: {
  environmentId: EnvironmentId;
  handoff: NonNullable<RepositoryOrchestration["handoff"]>;
  busy: boolean;
  onCancel: () => void;
}) {
  const gt = useGT();
  const requestedMs = handoff.requestedAt === undefined ? NaN : Date.parse(handoff.requestedAt);
  const old = useDeadlinePassed(Number.isNaN(requestedMs) ? null : requestedMs + STALE_HANDOFF_MS);
  const draining = handoff.status === "draining";
  const existingTarget = useThreadShell(scopeThreadRef(environmentId, handoff.nextThreadId));
  const target = existingTarget?.title ?? handoff.modelSelection.model;
  return (
    <div
      className="flex w-full items-center gap-2 pt-1 text-xs text-muted-foreground"
      role="status"
    >
      <span className="min-w-0 break-words">
        {draining
          ? gt("Handoff to {target} is draining", { target })
          : gt("Handoff to {target} awaits approval", { target })}
      </span>
      {handoff.requestedAt === undefined ? null : (
        <span className="shrink-0">
          · <RelativeTime timestamp={handoff.requestedAt} />
        </span>
      )}
      <span className="flex-1" />
      {old ? (
        <Badge variant="warning" size="sm" className="shrink-0">
          {gt("Over a day old")}
        </Badge>
      ) : null}
      <Button size="xs" variant="ghost" className="shrink-0" disabled={busy} onClick={onCancel}>
        {gt("Cancel")}
      </Button>
    </div>
  );
}

function PreviousRootsMenu({
  environmentId,
  history,
  separator,
  onOpen,
}: {
  environmentId: EnvironmentId;
  history: NonNullable<RepositoryOrchestration["handoffHistory"]>;
  separator: boolean;
  onOpen: (threadId: ThreadId) => void;
}) {
  const { data } = useEnvironmentQuery(
    orchestrationEnvironment.threadTitles({
      environmentId,
      input: { threadIds: history.map(({ threadId }) => threadId) },
    }),
  );
  const previous = data == null ? history : history.filter(({ threadId }) => data[threadId]);
  if (previous.length === 0) return null;
  return (
    <>
      {separator ? <MenuSeparator /> : null}
      <MenuGroup>
        <MenuGroupLabel>Previous orchestrators</MenuGroupLabel>
        {previous.map(({ threadId, transferredAt }) => (
          <MenuItem key={threadId} onClick={() => onOpen(threadId)}>
            <span className="min-w-0 flex-1 truncate">{data?.[threadId] ?? threadId}</span>
            <span className="shrink-0 text-muted-foreground">
              <RelativeTime timestamp={transferredAt} />
            </span>
          </MenuItem>
        ))}
      </MenuGroup>
    </>
  );
}
