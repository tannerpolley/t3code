import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  ISSUE_WORK_STATUS_LABELS,
  type EnvironmentId,
  type IssueRef,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BotIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useRightPanelStore } from "~/rightPanelStore";
import { randomUUID } from "~/lib/utils";
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
  const [acceptedRootId, setAcceptedRootId] = useState<ThreadId | null>(null);
  const projects = useProjects();
  const thread = useThreadShell(threadRef);
  const roles = useEnvironmentSettings(environmentId, (settings) => settings.modelRoles);
  const statusAtom = issueEnvironment.workStatus({ environmentId, input: reference });
  const statusResult = useAtomValue(statusAtom);
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
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<"project" | "worktree">("worktree");
  const [expanded, setExpanded] = useState(false);
  const [starting, setStarting] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const project =
    matchingProjects.find((entry) => entry.id === selectedProjectId) ?? preferredProject;
  const role = roles.find((entry) => entry.id === selectedRoleId) ?? roles[0];
  const startIssue = useAtomCommand(issueEnvironment.start, { reportFailure: false });
  const openThreadId = status?.threadId ?? status?.rootThreadId ?? acceptedRootId;
  const openWorkThread = () => {
    if (openThreadId === null) return;
    const target = scopeThreadRef(environmentId, openThreadId);
    useRightPanelStore.getState().openIssue(target, { environmentId, ...reference });
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: openThreadId },
    });
  };

  const start = async () => {
    if (starting || project === null || role === undefined) return;
    const input = { ...reference, projectId: project.id, modelRoleId: role.id, workspace };
    const key = JSON.stringify(input);
    if (request.current?.key !== key) request.current = { key, id: randomUUID() };
    setStarting(true);
    const result = await startIssue({
      environmentId,
      input: { ...input, clientRequestId: CommandId.make(request.current.id) },
    });
    setStarting(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not start issue work",
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    setAcceptedRootId(result.value.rootThreadId);
    request.current = null;
    setExpanded(false);
    toastManager.add({
      type: "success",
      title: "Issue work accepted by the repository orchestrator",
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        {status?.status ? (
          <span className="text-xs text-muted-foreground" role="status">
            {ISSUE_WORK_STATUS_LABELS[status.status]}
            {status.publishing === "pending" ? " · GitHub update pending" : null}
            {status.publishing === "failed" ? " · GitHub update will retry" : null}
          </span>
        ) : null}
        {openThreadId !== null ? (
          <Button onClick={openWorkThread} size="xs" variant="ghost">
            Open work thread
          </Button>
        ) : null}
        <Button
          disabled={closed || matchingProjects.length === 0 || roles.length === 0}
          onClick={() => setExpanded((value) => !value)}
          size="xs"
          variant="outline"
          aria-expanded={expanded}
        >
          <BotIcon aria-hidden />
          Start agent
        </Button>
      </div>
      {expanded ? (
        <form
          className="flex w-72 flex-col gap-2 rounded-lg border border-border bg-background p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
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
            attempt. Issue content and state changes require separate approval.
          </p>
          {statusResult._tag === "Failure" ? (
            <p className="text-xs text-muted-foreground">
              Work status is unavailable. The server will check ownership when starting.
            </p>
          ) : null}
          <div className="flex justify-end gap-1.5">
            <Button onClick={() => setExpanded(false)} size="xs" type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={starting || project === null || role === undefined}
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
