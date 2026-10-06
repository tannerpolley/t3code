import {
  CommandId,
  type EnvironmentId,
  type IssueMilestone,
  type IssueRepositoryRef,
} from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useProjects, useServerConfigs } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
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
  const canResume = config?.paused === true || (config?.suspendedIssues.length ?? 0) > 0;
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
  const pause = useAtomCommand(issueEnvironment.setPaused, { reportFailure: false });
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
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-1">
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
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void run("pause")}>
            {canResume ? "Resume repository" : "Pause repository"}
          </Button>
        ) : null}
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
          <Button size="xs" disabled={busy || role === undefined} onClick={() => void run("start")}>
            Start milestone work
          </Button>
        </div>
      ) : null}
    </div>
  );
}
