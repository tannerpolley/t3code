import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type EnvironmentId,
  type IssueRef,
  type ProjectId,
  type ThreadId,
  type ScopedThreadRef,
  type IssueWorkStartResult,
} from "@t3tools/contracts";
import { issueWorkPresentation } from "@t3tools/client-runtime/state/issue-work";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BotIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  useProjects,
  useServerConfigs,
  useThreadShell,
  useThreadShellsForProjectRefs,
} from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { randomUUID } from "~/lib/utils";
import { ThreadWorktreeIndicator } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { findIssueProject } from "./issueWorktree.logic";

interface IssueStartActionProps {
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRef;
  readonly threadRef: ScopedThreadRef | null;
  readonly closed: boolean;
}

/** Active top-level threads in the project that can lead its repository's issue work. */
export function useRepositoryLeads(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const threadShells = useThreadShellsForProjectRefs(
    projectId === null ? [] : [scopeProjectRef(environmentId, projectId)],
  );
  return threadShells.filter(
    (candidate) =>
      candidate.environmentId === environmentId &&
      candidate.projectId === projectId &&
      candidate.archivedAt === null &&
      candidate.lineage.parentThreadId === null &&
      candidate.lineage.rootThreadId === candidate.id &&
      candidate.linkedIssue === undefined,
  );
}

/** Older servers retain issue reads and draft preparation. */
export function IssueStartAction(props: IssueStartActionProps) {
  const configs = useServerConfigs();
  if (configs.get(props.environmentId)?.environment.capabilities.issueWork !== true) return null;
  return <IssueStartControls {...props} />;
}

/** Both issue views use the owning environment's start service and publishing policy. */
function IssueStartControls({
  environmentId,
  reference,
  threadRef,
  closed,
}: IssueStartActionProps) {
  const navigate = useNavigate();
  const [accepted, setAccepted] = useState<{
    result: IssueWorkStartResult;
    previousStatusAt: number;
  } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const projects = useProjects();
  const thread = useThreadShell(threadRef);
  const roles = useEnvironmentSettings(environmentId, (settings) => settings.modelRoles);
  const statusAtom = issueEnvironment.workStatus({ environmentId, input: reference });
  const statusQuery = useEnvironmentQuery(statusAtom);
  const status = statusQuery.data;
  const matchingProjects = projects.filter(
    (project) =>
      (status?.projectId == null || project.id === status.projectId) &&
      findIssueProject([project], { environmentId, ...reference }, null) !== null,
  );
  const preferredProject = findIssueProject(
    matchingProjects,
    { environmentId, ...reference },
    thread?.projectId ?? null,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [selectedOrchestratorId, setSelectedOrchestratorId] = useState<ThreadId | "create" | null>(
    null,
  );
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<"project" | "worktree">("worktree");
  const [expanded, setExpanded] = useState(false);
  const [starting, setStarting] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const project =
    matchingProjects.find((entry) => entry.id === selectedProjectId) ?? preferredProject;
  const leads = useRepositoryLeads(environmentId, project?.id ?? null);
  const createOrchestrator = status?.rootThreadId == null && selectedOrchestratorId === "create";
  const selectedLead = createOrchestrator
    ? undefined
    : (leads.find((candidate) => candidate.id === selectedOrchestratorId) ??
      leads.find((candidate) => candidate.id === thread?.lineage.rootThreadId));
  const orchestratorThreadId = status?.rootThreadId ?? selectedLead?.id;
  const hasOrchestrator = orchestratorThreadId !== undefined || createOrchestrator;
  const role = roles.find((entry) => entry.id === selectedRoleId) ?? roles[0];
  const startIssue = useAtomCommand(issueEnvironment.start, { reportFailure: false });
  const cancelStartRequest = useAtomCommand(issueEnvironment.cancelRequest, {
    reportFailure: false,
  });
  const canCancelStartRequest = useAtomValue(
    issueEnvironment.cancelRequest.permissionAtom(environmentId),
  );
  const [cancelling, setCancelling] = useState(false);
  const awaitingAcceptedStatus =
    accepted !== null && statusQuery.dataUpdatedAt <= accepted.previousStatusAt;
  const work = issueWorkPresentation(
    awaitingAcceptedStatus ? null : status,
    awaitingAcceptedStatus ? accepted.result : null,
  );
  const openThreadId = work.threadId;
  const worker = useThreadShell(
    openThreadId === null ? null : scopeThreadRef(environmentId, openThreadId),
  );
  const openWorkThread = () => {
    if (openThreadId === null) return;
    const target = scopeThreadRef(environmentId, openThreadId);
    useRightPanelStore.getState().openIssue(target, { environmentId, ...reference });
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: openThreadId },
    });
  };

  const pendingRequestId = awaitingAcceptedStatus ? null : (status?.pendingRequestId ?? null);
  const cancelPendingStart = async () => {
    if (cancelling || pendingRequestId === null || !status?.rootThreadId || !status.projectId)
      return;
    setCancelling(true);
    const result = await cancelStartRequest({
      environmentId,
      input: {
        host: reference.host,
        repository: reference.repository,
        projectId: status.projectId,
        expectedRootThreadId: status.rootThreadId,
        requestId: pendingRequestId,
        reason: "Cancelled from the issue's Start agent controls",
        clientRequestId: CommandId.make(randomUUID()),
      },
    });
    setCancelling(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not cancel the start request",
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    appAtomRegistry.refresh(statusAtom);
  };

  const start = async () => {
    if (starting || project === null || role === undefined || !hasOrchestrator) return;
    const input = {
      ...reference,
      projectId: project.id,
      modelRoleId: role.id,
      workspace,
      ...(orchestratorThreadId === undefined ? {} : { orchestratorThreadId }),
      ...(createOrchestrator ? { createOrchestrator: true } : {}),
    };
    // Only an unanswered Start keeps its id, so retrying it cannot queue a second request.
    const key = JSON.stringify(input);
    if (request.current?.key !== key) request.current = { key, id: randomUUID() };
    setStartError(null);
    setStarting(true);
    const result = await startIssue({
      environmentId,
      input: { ...input, clientRequestId: CommandId.make(request.current.id) },
    });
    setStarting(false);
    if (result._tag === "Failure") {
      setStartError(formatEnvironmentQueryError(result.cause));
      return;
    }
    request.current = null;
    if (result.value.status === "cancelled") {
      // The retried request was cancelled elsewhere; the next Start sends a new one.
      appAtomRegistry.refresh(statusAtom);
      toastManager.add({
        type: "warning",
        title: "That start request was cancelled",
        description: "Start again to send a new request.",
      });
      return;
    }
    setAccepted({ result: result.value, previousStatusAt: statusQuery.dataUpdatedAt });
    setExpanded(false);
    toastManager.add({
      type: "success",
      title: "Issue work accepted by the repository orchestrator",
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {work.label ? (
          <span className="text-xs text-muted-foreground" role="status">
            {work.label}
            {statusQuery.error ? " (last known)" : null}
            {work.publishingLabel ? ` · ${work.publishingLabel}` : null}
          </span>
        ) : null}
        {openThreadId !== null ? (
          <div className="flex min-w-0 items-center gap-1">
            {work.isWorker && worker ? <ThreadWorktreeIndicator thread={worker} /> : null}
            <Button onClick={openWorkThread} size="xs" variant="ghost">
              <span className="max-w-56 truncate">
                {worker?.title ??
                  (work.isWorker ? "Open worker thread" : "Open repository orchestrator")}
              </span>
            </Button>
          </div>
        ) : null}
        {pendingRequestId !== null && canCancelStartRequest ? (
          <Button
            disabled={cancelling}
            onClick={() => void cancelPendingStart()}
            size="xs"
            variant="ghost"
          >
            {cancelling ? "Cancelling…" : "Cancel start request"}
          </Button>
        ) : null}
        <Button
          disabled={closed || starting}
          onClick={() => setExpanded((value) => !value)}
          size="xs"
          variant="outline"
          aria-expanded={expanded}
        >
          <BotIcon aria-hidden />
          Start agent
        </Button>
      </div>
      {statusQuery.error ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <span>Work status unavailable: {statusQuery.error}</span>
          <Button onClick={statusQuery.refresh} size="xs" variant="ghost">
            Retry status
          </Button>
        </div>
      ) : statusQuery.data === null && work.label === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          Checking work status…
        </p>
      ) : null}
      {startError ? (
        <p className="max-w-72 text-xs text-destructive" role="alert">
          Start request failed: {startError}. Retry uses the same request.
        </p>
      ) : null}
      {expanded ? (
        <form
          className="flex w-72 flex-col gap-2 rounded-lg border border-border bg-background p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          {matchingProjects.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Add a project for this repository in this environment to start work.
            </p>
          ) : null}
          {roles.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Configure a model role in Customizations to start work.
            </p>
          ) : null}
          <label className="flex flex-col gap-1 text-xs">
            Model role
            <Select value={role?.id ?? null} onValueChange={setSelectedRoleId}>
              <SelectTrigger size="compact" aria-label="Issue model role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {role ? (
            <p className="text-xs text-muted-foreground">
              {role.targets.map((target) => target.model).join(" → ")}
            </p>
          ) : null}
          <label className="flex flex-col gap-1 text-xs">
            Repository workspace
            <Select value={project?.id ?? null} onValueChange={setSelectedProjectId}>
              <SelectTrigger size="compact" aria-label="Issue project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {matchingProjects.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {project ? (
            <p className="break-all text-xs text-muted-foreground">{project.workspaceRoot}</p>
          ) : null}
          {status?.projectId ? (
            <p className="text-xs text-muted-foreground">
              Uses the registered repository orchestrator’s project.
            </p>
          ) : null}
          {status?.rootThreadId == null ? (
            <label className="flex flex-col gap-1 text-xs">
              Repository orchestrator
              <Select
                value={createOrchestrator ? "create" : (selectedLead?.id ?? null)}
                onValueChange={(value) =>
                  setSelectedOrchestratorId(
                    value === "create"
                      ? "create"
                      : (leads.find((lead) => lead.id === value)?.id ?? null),
                  )
                }
              >
                <SelectTrigger size="compact" aria-label="Repository orchestrator">
                  <SelectValue placeholder="Choose or create a lead" />
                </SelectTrigger>
                <SelectContent>
                  {leads.map((lead) => (
                    <SelectItem key={lead.id} value={lead.id}>
                      {lead.title}
                    </SelectItem>
                  ))}
                  <SelectItem value="create">Create first orchestrator</SelectItem>
                </SelectContent>
              </Select>
              {leads.length === 0 ? (
                <span>Choose Create first orchestrator to start with a new lead.</span>
              ) : null}
              <span>Issue workers run beneath this lead, following the issue parent tree.</span>
            </label>
          ) : null}
          <Select
            value={workspace}
            onValueChange={(value) => {
              if (value === "project" || value === "worktree") setWorkspace(value);
            }}
          >
            <SelectTrigger size="compact" aria-label="Issue checkout choice">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="worktree">New worktree</SelectItem>
              <SelectItem value="project">Project checkout</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Starting authorizes one updated T3 status comment and one closeout comment per finished
            attempt. Agents can create and split issues and move milestones. Body edits,
            close/reopen, and standalone parent changes require your approval of the exact preview.
          </p>
          {statusQuery.error ? (
            <p className="text-xs text-muted-foreground">
              Work status is unavailable. The server will check ownership when starting.
            </p>
          ) : null}
          <div className="flex justify-end gap-1.5">
            <Button
              disabled={starting}
              onClick={() => setExpanded(false)}
              size="xs"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={starting || project === null || role === undefined || !hasOrchestrator}
              size="xs"
              type="submit"
            >
              {starting ? "Starting…" : "Start agent"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
