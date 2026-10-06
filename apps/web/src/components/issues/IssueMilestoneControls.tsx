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

export function IssueMilestoneControls(props: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
  milestone: IssueMilestone;
}) {
  const configs = useServerConfigs();
  return configs.get(props.environmentId)?.environment.capabilities.issueMilestones === true ? (
    <Controls {...props} />
  ) : null;
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
  const statusAtom = issueEnvironment.repositoryStatus({ environmentId, input: reference });
  const { data } = useEnvironmentQuery(statusAtom);
  const config = data?.orchestration;
  const navigate = useNavigate();
  const root = useThreadShell(
    data?.rootThreadId == null ? null : scopeThreadRef(environmentId, data.rootThreadId),
  );
  const openRoot = (threadId: ThreadId) =>
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  const canResume = config?.paused === true || (config?.suspendedIssues.length ?? 0) > 0;
  const project = findIssueProject(
    projects.filter((entry) => config == null || entry.id === config.projectId),
    { environmentId, ...reference },
    null,
  );
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [handoffExpanded, setHandoffExpanded] = useState(false);
  const [summary, setSummary] = useState("");
  const [roleId, setRoleId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<"project" | "worktree">("worktree");
  const role =
    roles.find((entry) => entry.id === roleId) ??
    roles.find((entry) => entry.id !== "orchestrator") ??
    roles[0];
  const plan = config?.milestones.find((entry) => entry.number === milestone.number);
  const work = useAtomCommand(issueEnvironment.workMilestone, { reportFailure: false });
  const pause = useAtomCommand(issueEnvironment.setPaused, { reportFailure: false });
  const handoff = useAtomCommand(issueEnvironment.handoff, { reportFailure: false });
  const transfer = async (action: "approve" | "cancel") => {
    if (busy || config == null) return;
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
  const run = async (action: "start" | "pause") => {
    if (busy || (action === "start" && (project === null || role === undefined))) return;
    setBusy(true);
    const clientRequestId = CommandId.make(randomUUID());
    const result =
      action === "pause"
        ? await pause({
            environmentId,
            input: { ...reference, paused: !canResume, clientRequestId },
          })
        : await work({
            environmentId,
            input: {
              ...reference,
              milestoneNumber: milestone.number,
              projectId: project!.id,
              modelRoleId: role!.id,
              workspace,
              clientRequestId,
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
        {config ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || config.handoff?.status === "draining"}
            onClick={() => void run("pause")}
          >
            {canResume ? "Resume repository" : "Pause repository"}
          </Button>
        ) : null}
        {config && config.handoff === undefined ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => setHandoffExpanded(!handoffExpanded)}
          >
            Hand off to fresh thread
          </Button>
        ) : null}
      </div>
      {data?.rootThreadId ? (
        <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
          <span className="text-xs text-muted-foreground">Current root:</span>
          <Button size="xs" variant="link" onClick={() => openRoot(data.rootThreadId!)}>
            <span className="max-w-48 truncate">{root?.title ?? data.rootThreadId}</span>
          </Button>
          {config?.handoffHistory?.map((entry, index) => (
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
        </div>
      ) : null}
      {config?.handoff || handoffExpanded ? (
        <div className="flex w-full max-w-md flex-col gap-2 p-2">
          <span className="text-xs text-muted-foreground" role="status">
            {config?.handoff?.status === "draining"
              ? "Handoff is pending while existing work finishes and the recovery inventory is prepared. The current root keeps ownership until then."
              : "Approve a fresh thread after existing work finishes. Routine model changes can keep the current thread."}
          </span>
          {config?.handoff ? (
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
            {config?.handoff ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void transfer("cancel")}
              >
                Cancel handoff
              </Button>
            ) : null}
            {config?.handoff?.status !== "draining" ? (
              <Button
                size="xs"
                disabled={busy || (config?.handoff === undefined && summary.trim().length === 0)}
                onClick={() => void transfer("approve")}
              >
                Approve fresh-thread handoff
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
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
          <Button size="xs" disabled={busy || role === undefined} onClick={() => void run("start")}>
            Start milestone work
          </Button>
        </div>
      ) : null}
    </div>
  );
}
