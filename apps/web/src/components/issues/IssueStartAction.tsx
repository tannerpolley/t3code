import { threadRoleLabel } from "../threadRoleDisplay";
import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  isRepositoryOrchestratorEligible,
  resolveModelRoles,
  type IssueRepositoryRef,
  type EnvironmentId,
  type RepositoryIssueRef,
  type ProjectId,
  type ThreadId,
  type ScopedThreadRef,
  type IssueWorkStartResult,
} from "@t3tools/contracts";
import { issueWorkPresentation } from "@t3tools/client-runtime/state/issue-work";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { T, useGT, useMessages } from "gt-react";
import { PlayIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useEnvironmentProviders } from "~/state/environments";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  useProjects,
  useServerConfigs,
  useThreadShell,
  useThreadShellsForProjectRefs,
} from "~/state/entities";
import { repositoryIssueEnvironment } from "~/state/repositoryIssues";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { randomUUID } from "~/lib/utils";
import { ThreadWorktreeIndicator } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { findIssueProject } from "./issueWorktree.logic";
import { useOpenIssueTab } from "./issueTabs";

interface IssueStartActionProps {
  readonly environmentId: EnvironmentId;
  readonly reference: RepositoryIssueRef;
  readonly threadRef: ScopedThreadRef | null;
  readonly closed: boolean;
}

/** Active top-level threads in the project that can lead its repository's issue work. */
export function useRepositoryLeads(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  repository: IssueRepositoryRef,
) {
  const providers = useEnvironmentProviders().get(environmentId);
  const threadShells = useThreadShellsForProjectRefs(
    projectId === null ? [] : [scopeProjectRef(environmentId, projectId)],
  );
  return threadShells.filter(
    (candidate) =>
      candidate.environmentId === environmentId &&
      projectId !== null &&
      isRepositoryOrchestratorEligible(
        candidate.source,
        providers?.find((provider) => provider.instanceId === candidate.modelSelection.instanceId)
          ?.driver,
        { ...repository, projectId },
      ),
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
  const openIssueTab = useOpenIssueTab();
  const [accepted, setAccepted] = useState<{
    result: IssueWorkStartResult;
    previousStatusAt: number;
  } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const projects = useProjects();
  const thread = useThreadShell(threadRef);
  const settings = useEnvironmentSettings(environmentId);
  const gt = useGT();
  const resolve = useMessages();
  const levelLabels = { routine: gt("Routine"), complex: gt("Complex") };
  const roles = resolveModelRoles(settings);
  const statusAtom = repositoryIssueEnvironment.workStatus({ environmentId, input: reference });
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
  const [expanded, setExpanded] = useState(false);
  const [starting, setStarting] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const project =
    matchingProjects.find((entry) => entry.id === selectedProjectId) ?? preferredProject;
  const leads = useRepositoryLeads(environmentId, project?.id ?? null, reference);
  const createOrchestrator = status?.rootThreadId == null && selectedOrchestratorId === "create";
  const selectedLead = createOrchestrator
    ? undefined
    : (leads.find((candidate) => candidate.id === selectedOrchestratorId) ??
      leads.find((candidate) => candidate.id === thread?.lineage.rootThreadId));
  const orchestratorThreadId = status?.rootThreadId ?? selectedLead?.id;
  const hasOrchestrator = orchestratorThreadId !== undefined || createOrchestrator;
  const role = roles.find((entry) => entry.id === selectedRoleId) ?? roles[0];
  const startIssue = useAtomCommand(repositoryIssueEnvironment.start, { reportFailure: false });
  const cancelStartRequest = useAtomCommand(repositoryIssueEnvironment.cancelRequest, {
    reportFailure: false,
  });
  const canCancelStartRequest = useAtomValue(
    repositoryIssueEnvironment.cancelRequest.permissionAtom(environmentId),
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
    openIssueTab(scopeThreadRef(environmentId, openThreadId), { environmentId, ...reference });
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
        title: gt("Could not cancel the start request"),
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
        title: gt("That start request was cancelled"),
        description: gt("Start again to send a new request."),
      });
      return;
    }
    setAccepted({ result: result.value, previousStatusAt: statusQuery.dataUpdatedAt });
    setExpanded(false);
    toastManager.add({
      type: "success",
      title:
        result.value.issueThreadId === null ? gt("Issue work queued") : gt("Issue worker started"),
      description: issueWorkPresentation(null, result.value).label ?? undefined,
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {work.label ? (
          <span className="text-xs text-muted-foreground" role="status">
            {work.label}
            {statusQuery.error ? gt(" (last known)") : null}
            {work.publishingLabel ? ` · ${work.publishingLabel}` : null}
          </span>
        ) : null}
        {openThreadId !== null ? (
          <div className="flex min-w-0 items-center gap-1">
            {work.isWorker && worker ? <ThreadWorktreeIndicator thread={worker} /> : null}
            <Button onClick={openWorkThread} size="xs" variant="ghost">
              <span className="max-w-56 truncate">
                {worker?.title ??
                  (work.isWorker ? gt("Open worker thread") : gt("Open repository orchestrator"))}
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
            {cancelling ? gt("Cancelling…") : gt("Cancel start request")}
          </Button>
        ) : null}
        <Button
          disabled={closed || starting}
          onClick={() => setExpanded((value) => !value)}
          size="xs"
          variant="outline"
          aria-expanded={expanded}
        >
          <PlayIcon aria-hidden />
          <T>Start agent</T>
        </Button>
      </div>
      {statusQuery.error ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <span>
            <T>Work status unavailable:</T> {statusQuery.error}
          </span>
          <Button onClick={statusQuery.refresh} size="xs" variant="ghost">
            <T>Retry status</T>
          </Button>
        </div>
      ) : statusQuery.data === null && work.label === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          <T>Checking work status…</T>
        </p>
      ) : null}
      {startError ? (
        <p className="max-w-72 text-xs text-destructive" role="alert">
          <T>Start request failed:</T> {startError.replace(/\.$/, "")}
          <T>. Retry uses the same request.</T>
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
              <T>Add a project for this repository in this environment to start work.</T>
            </p>
          ) : null}
          {roles.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>Configure a model role in Customizations to start work.</T>
            </p>
          ) : null}
          <label className="flex flex-col gap-1 text-xs">
            <T>Model role</T>
            <Select value={role?.id ?? null} onValueChange={setSelectedRoleId}>
              <SelectTrigger size="compact" aria-label={gt("Issue model role")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {`${threadRoleLabel(entry.role, resolve)} · ${levelLabels[entry.level]}`}
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
            <T>Repository project</T>
            <Select
              items={matchingProjects.map((entry) => ({ value: entry.id, label: entry.title }))}
              value={project?.id ?? null}
              onValueChange={setSelectedProjectId}
            >
              <SelectTrigger size="compact" aria-label={gt("Issue project")}>
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
              <T>Uses the registered repository orchestrator’s project.</T>
            </p>
          ) : null}
          {status?.rootThreadId == null ? (
            <label className="flex flex-col gap-1 text-xs">
              <T>Repository orchestrator</T>
              <Select
                items={[
                  ...leads.map((lead) => ({ value: lead.id, label: lead.title })),
                  { value: "create", label: gt("Create first orchestrator") },
                ]}
                value={createOrchestrator ? "create" : (selectedLead?.id ?? null)}
                onValueChange={(value) =>
                  setSelectedOrchestratorId(
                    value === "create"
                      ? "create"
                      : (leads.find((lead) => lead.id === value)?.id ?? null),
                  )
                }
              >
                <SelectTrigger size="compact" aria-label={gt("Repository orchestrator")}>
                  <SelectValue placeholder={gt("Choose or create a lead")} />
                </SelectTrigger>
                <SelectContent>
                  {leads.map((lead) => (
                    <SelectItem key={lead.id} value={lead.id}>
                      {lead.title}
                    </SelectItem>
                  ))}
                  <SelectItem value="create">
                    <T>Create first orchestrator</T>
                  </SelectItem>
                </SelectContent>
              </Select>
              {leads.length === 0 ? (
                <span>
                  <T>Choose Create first orchestrator to start with a new lead.</T>
                </span>
              ) : null}
              <span>
                <T>Issue workers run beneath this lead, following the issue parent tree.</T>
              </span>
            </label>
          ) : null}
          <p className="text-xs text-muted-foreground">
            <T>
              Each worker gets a new issue-named worktree from the default branch. The repository
              orchestrator stays on the default branch in the main checkout.
            </T>
          </p>
          <p className="text-xs text-muted-foreground">
            <T>
              Starting authorizes one updated T3 status comment and one closeout comment per
              finished attempt.
            </T>
          </p>
          <p className="text-xs text-muted-foreground">
            {gt(
              'Creating, splitting, and moving issues between milestones require approval when "Ask before agents create, split or move issues" is on. Body edits, closing or reopening issues, and parent or blocker changes require approval when the agent thread is in Approval required mode.',
            )}
          </p>
          {statusQuery.error ? (
            <p className="text-xs text-muted-foreground">
              <T>Work status is unavailable. The server will check ownership when starting.</T>
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
              <T>Cancel</T>
            </Button>
            <Button
              disabled={starting || project === null || role === undefined || !hasOrchestrator}
              size="xs"
              type="submit"
            >
              {starting ? gt("Starting…") : gt("Start agent")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
