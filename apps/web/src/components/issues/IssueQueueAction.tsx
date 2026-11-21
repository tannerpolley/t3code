import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type EnvironmentId,
  type RepositoryIssueRef,
  type IssueRepositoryRef,
  type RepositoryIssueSummary,
} from "@t3tools/contracts";
import { ListPlusIcon, ListMinusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useServerConfigs } from "~/state/entities";
import { repositoryIssueEnvironment } from "~/state/repositoryIssues";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { issueQueueRequestAfterResult, type IssueQueueRequest } from "./issueQueue.logic";
import { issueProgress } from "./IssueStateIcon";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

export function useIssueQueue(
  environmentId: EnvironmentId | undefined,
  reference: IssueRepositoryRef | null,
) {
  const configs = useServerConfigs();
  const supported =
    environmentId !== undefined &&
    reference !== null &&
    configs.get(environmentId)?.environment.capabilities.issueQueue === true;
  const query = useEnvironmentQuery(
    supported
      ? repositoryIssueEnvironment.repositoryStatus({
          environmentId,
          input: {
            host: reference.host.toLowerCase(),
            repository: reference.repository.toLowerCase(),
          },
        })
      : null,
  );
  return { supported, ...query };
}

/** Whether the issue waits in its repository's queue; state icons show it as queued. */
export function useIssueQueued(
  environmentId: EnvironmentId | undefined,
  reference: RepositoryIssueRef | null,
) {
  const status = useIssueQueue(environmentId, reference);
  return status.data?.queue?.some((entry) => entry.issue.number === reference?.number) === true;
}

export function IssueQueueAction({
  environmentId,
  reference,
  issue,
}: {
  environmentId: EnvironmentId;
  reference: RepositoryIssueRef;
  issue: RepositoryIssueSummary;
}) {
  const status = useIssueQueue(environmentId, reference);
  const enqueue = useAtomCommand(repositoryIssueEnvironment.queueIssue, { reportFailure: false });
  const dequeue = useAtomCommand(repositoryIssueEnvironment.unqueueIssue, { reportFailure: false });
  const canQueue = useAtomValue(
    repositoryIssueEnvironment.queueIssue.permissionAtom(environmentId),
  );
  const canUnqueue = useAtomValue(
    repositoryIssueEnvironment.unqueueIssue.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const request = useRef<IssueQueueRequest | null>(null);
  const entry = status.data?.queue?.find((entry) => entry.issue.number === reference.number);
  const queued = entry !== undefined;
  const needsAttention = entry?.state === "needs_attention";
  const suspended = issue.suspensionReason !== undefined;
  const progress = issueProgress(issue);
  if (
    !status.supported ||
    (!queued && (issue.state !== "open" || progress === "in_progress" || progress === "queued"))
  )
    return null;
  const label = queued ? "Remove from queue" : "Add to queue";
  const resumable = !queued && suspended;
  const change = async (remove = queued) => {
    if (busy) return;
    if (request.current?.queued !== remove)
      request.current = { queued: remove, id: CommandId.make(randomUUID()) };
    setBusy(true);
    const result = await (remove ? dequeue : enqueue)({
      environmentId,
      input: { ...reference, clientRequestId: request.current.id },
    });
    setBusy(false);
    request.current = issueQueueRequestAfterResult(request.current, result);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not ${remove ? "remove issue from" : "add issue to"} queue`,
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    status.refresh();
  };
  return (
    <>
      {queued ? (
        <Badge variant="secondary" size="sm">
          {needsAttention ? "Orchestrator didn't start it" : "Queued"}
        </Badge>
      ) : null}
      {needsAttention ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy || !canQueue}
          onClick={() => void change(false)}
        >
          Retry
        </Button>
      ) : null}
      {queued && suspended ? (
        <Button
          variant="outline"
          size="xs"
          disabled={busy || !canQueue}
          onClick={() => void change(false)}
        >
          Resume
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={resumable ? "outline" : "ghost"}
              size={resumable ? "xs" : "icon-xs"}
              aria-label={resumable ? "Resume issue" : label}
              disabled={busy || status.data === null || (queued ? !canUnqueue : !canQueue)}
              onClick={() => void change()}
            />
          }
        >
          {queued ? <ListMinusIcon aria-hidden /> : <ListPlusIcon aria-hidden />}
          {resumable ? "Resume" : null}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {resumable ? "Resume issue" : label}
          {queued && status.data?.rootThreadId === null
            ? " · Waiting for a repository orchestrator"
            : ""}
        </TooltipPopup>
      </Tooltip>
    </>
  );
}
