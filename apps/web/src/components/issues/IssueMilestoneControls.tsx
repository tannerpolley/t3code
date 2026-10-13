import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type EnvironmentId,
  type IssueMilestone,
  type IssueRepositoryRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useState } from "react";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { findIssueProject } from "./issueWorktree.logic";
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
  const root = useThreadShell(
    data?.rootThreadId == null ? null : scopeThreadRef(environmentId, data.rootThreadId),
  );
  const openRoot = (threadId: ThreadId) =>
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  const canResume = config?.paused === true || (config?.suspendedIssues.length ?? 0) > 0;
  const [busy, setBusy] = useState(false);
  const [handoffExpanded, setHandoffExpanded] = useState(false);
  const [summary, setSummary] = useState("");
  const pause = useAtomCommand(issueEnvironment.setPaused, { reportFailure: false });
  const handoff = useAtomCommand(issueEnvironment.handoff, { reportFailure: false });
  const restore = useAtomCommand(issueEnvironment.restoreRoot, { reportFailure: false });
  const canRestore = useAtomValue(issueEnvironment.restoreRoot.permissionAtom(environmentId));
  const [restoreExpanded, setRestoreExpanded] = useState(false);
  const [restoreTargetId, setRestoreTargetId] = useState<ThreadId | null>(null);
  const restoreCandidates = useRepositoryLeads(environmentId, config?.projectId ?? null).filter(
    (lead) => lead.id !== data?.rootThreadId,
  );
  if (config == null || data?.rootThreadId == null) return null;
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
  return (
    <div className="flex flex-col gap-1 py-1 ps-6 pe-2">
      <div className="flex max-w-full flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground">Orchestrator:</span>
        <Button size="xs" variant="link" onClick={() => openRoot(data.rootThreadId!)}>
          <span className="max-w-48 truncate">{root?.title ?? data.rootThreadId}</span>
        </Button>
        {config.handoffHistory?.map((entry, index) => (
          <Button
            key={entry.threadId}
            size="xs"
            variant="link"
            onClick={() => openRoot(entry.threadId)}
            title={`Handed off ${entry.transferredAt}`}
          >
            Previous root {index + 1}
          </Button>
        ))}
        {config.paused ? <span className="text-xs text-muted-foreground">Paused</span> : null}
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || config.handoff?.status === "draining"}
          onClick={() => void togglePause()}
        >
          {canResume ? "Resume repository" : "Pause repository"}
        </Button>
        {config.handoff === undefined ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => setHandoffExpanded(!handoffExpanded)}
          >
            Hand off to fresh thread
          </Button>
        ) : null}
        {config.handoff === undefined && canRestore ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => setRestoreExpanded(!restoreExpanded)}
          >
            Use another thread as orchestrator
          </Button>
        ) : null}
      </div>
      {restoreExpanded && config.handoff === undefined ? (
        <div className="flex w-full max-w-md flex-col gap-2 p-2">
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
              disabled={busy || restoreTarget === undefined}
              onClick={() => void replaceRoot()}
            >
              Make orchestrator
            </Button>
          </div>
        </div>
      ) : null}
      {config.handoff || handoffExpanded ? (
        <div className="flex w-full max-w-md flex-col gap-2 p-2">
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
            ) : null}
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
    </div>
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
  const [workspace, setWorkspace] = useState<"project" | "worktree">("worktree");
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
        workspace,
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
      <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
        {plan ? (
          <span className="text-xs text-muted-foreground">
            {config?.paused ? "Paused" : plan.status.replaceAll("_", " ")}
          </span>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || project === null || milestone.state === "closed"}
          onClick={() => setExpanded(!expanded)}
        >
          Work through milestone
        </Button>
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
          <Select
            value={workspace}
            onValueChange={(value) => setWorkspace(value as "project" | "worktree")}
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="worktree">Workers in worktrees</SelectItem>
              <SelectItem value="project">Workers in project</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            Four workers across the repository. T3 publishes status and closeout comments.
          </span>
          <Button size="xs" disabled={busy || role === undefined} onClick={() => void start()}>
            Start milestone work
          </Button>
        </div>
      ) : null}
    </div>
  );
}
