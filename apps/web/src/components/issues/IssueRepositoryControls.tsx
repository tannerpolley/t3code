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
import { ArrowRightLeftIcon, MoreHorizontalIcon, ReplaceIcon } from "lucide-react";
import { T, useGT } from "gt-react";
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
  const gt = useGT();
  const environments = useEnvironments().environments;
  const repositories = projectIssueRepositories(members);
  return repositories.map((entry, index) => (
    <IssueRepositoryControls
      key={`${entry.environmentId}:${entry.host}/${entry.repository}`}
      environmentId={entry.environmentId}
      reference={{ host: entry.host, repository: entry.repository }}
      {...(repositories.length > 1
        ? {
            title: gt("Repository orchestration: {repository} on {environment}", {
              repository: entry.repository,
              environment:
                environments.find(
                  (environment) => environment.environmentId === entry.environmentId,
                )?.label ?? entry.environmentId,
            }),
          }
        : {})}
      {...(index === 0 ? { id: REPOSITORY_ORCHESTRATION_SECTION_ID } : {})}
    />
  ));
}

/** Repository-wide orchestrator ownership, limits and handoff. */
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

/** Admission and capacity for the board's repository. */
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
  const { data, config, statusAtom } = useRepositoryWork(environmentId, reference);
  if (config == null || data == null) return null;
  const status = repositoryWorkStatus(config, data.idMismatch);
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pt-1 pb-2 text-xs text-muted-foreground">
      <span role="status" className="min-w-0 truncate">
        {status.label}
      </span>
      {data.idMismatch === undefined ? (
        <IssueWorkerLimitControl
          key={config.revision}
          environmentId={environmentId}
          reference={reference}
          config={config}
          slotsInUse={data.slotsInUse}
          onSettled={() => appAtomRegistry.refresh(statusAtom)}
        />
      ) : null}
      <SettingsLink environmentId={environmentId} projectId={config.projectId} />
    </div>
  );
}

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
      <T>Project settings</T>
    </Button>
  );
}

function RepositoryControls({
  environmentId,
  reference,
  title,
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
      <SettingsSection
        title={title ?? gt("Repository orchestration")}
        {...(id === undefined ? {} : { id })}
      >
        <SettingsRow
          title={gt("Orchestrator")}
          description={gt(
            "No orchestrator yet. Start an agent on an issue, or choose Make repository orchestrator from a thread's menu.",
          )}
        />
      </SettingsSection>
    );
  const restoreTarget = restoreCandidates.find((lead) => lead.id === restoreTargetId);
  const replaceRoot = async () => {
    if (busy || restoreTarget === undefined) return;
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
        title: gt("Could not change the repository orchestrator"),
        description: formatEnvironmentQueryError(result.cause),
      });
    else {
      setRestoreExpanded(false);
      setRestoreTargetId(null);
      toastManager.add({
        type: "success",
        title:
          result.value.rootThreadId === restoreTarget.id
            ? gt("Repository orchestrator changed")
            : gt("Restore requested"),
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
        title: gt("Could not hand off repository work"),
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
        title: gt("Could not close out the issue attempt"),
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
        title: gt("Could not end repository orchestration"),
        description: formatEnvironmentQueryError(result.cause),
      });
    appAtomRegistry.refresh(statusAtom);
  };
  const status = repositoryWorkStatus(config, data.idMismatch);
  const canHandOff = config.handoff === undefined && config.restore === undefined;
  return (
    <SettingsSection
      title={title ?? gt("Repository orchestration")}
      {...(id === undefined ? {} : { id })}
    >
      <SettingsRow
        title={gt("Orchestrator")}
        description={gt("The thread that starts and coordinates issue work for this repository.")}
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
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={gt("Orchestrator actions")}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuItem disabled={busy || !canEnd} onClick={() => void end()}>
                    <T>End repository orchestration</T>
                  </MenuItem>
                  {canHandOff ? (
                    <MenuItem disabled={busy} onClick={() => setHandoffExpanded(true)}>
                      <ArrowRightLeftIcon className="size-3.5" />
                      <T>Hand off to a fresh thread</T>
                    </MenuItem>
                  ) : null}
                  {canHandOff && canRestore ? (
                    <MenuItem disabled={busy} onClick={() => setRestoreExpanded(true)}>
                      <ReplaceIcon className="size-3.5" />
                      <T>Use another thread as orchestrator</T>
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
        {restoreExpanded && canHandOff ? (
          <div className="flex w-full max-w-md flex-col gap-2 pt-1">
            <span className="text-xs text-muted-foreground">
              <T>
                New workers wait while current work finishes. Cancel unclaimed start requests to
                unblock the restore.
              </T>
            </span>
            <Select
              items={restoreCandidates.map((lead) => ({ value: lead.id, label: lead.title }))}
              value={restoreTarget?.id ?? null}
              onValueChange={(value) =>
                setRestoreTargetId(restoreCandidates.find((lead) => lead.id === value)?.id ?? null)
              }
            >
              <SelectTrigger size="compact" aria-label={gt("New repository orchestrator")}>
                <SelectValue placeholder={gt("Choose a lead thread")} />
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
                <T>No other top-level thread in this project can lead.</T>
              </span>
            ) : null}
            <div className="flex justify-end gap-1">
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setRestoreExpanded(false)}
              >
                <T>Cancel</T>
              </Button>
              <Button
                size="xs"
                disabled={busy || restoreTarget === undefined}
                onClick={() => void replaceRoot()}
              >
                <T>Make orchestrator</T>
              </Button>
            </div>
          </div>
        ) : null}
        {config.restore ? (
          <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
            {status.label}
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void transfer("cancel")}
            >
              <T>Cancel</T>
            </Button>
          </div>
        ) : config.handoff ? (
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
              aria-label={gt("Handoff summary")}
              placeholder={gt("Summarize decisions and remaining work for the new root")}
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
                <T>Cancel</T>
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
        title={gt("Workers")}
        description={gt("How many issue workers can run at once.")}
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
        title={gt("Read-only")}
        description={gt(
          "How many read-only agents, such as designers and reviewers, can run at once.",
        )}
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
        title={gt("Status")}
        description={gt("New work starts from Todo when a worker slot opens.")}
        control={
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate" role="status">
              {status.label}
            </span>
          </span>
        }
      >
        {config.suspendedIssues
          .filter((entry) => entry.kind === "closed")
          .map((entry) => (
            <div key={entry.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                {issueThreads.find((thread) => thread.linkedIssue?.id === entry.id)?.title ??
                  gt("Closed issue")}
                : {entry.reason}
              </span>
              <Button
                variant="outline"
                size="xs"
                disabled={busy || !canCloseOut || repositoryPhase(config) === "draining"}
                onClick={() => void finishAttempt(entry.id)}
              >
                <T>Close out attempt</T>
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
        <MenuGroupLabel>
          <T>Previous orchestrators</T>
        </MenuGroupLabel>
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
