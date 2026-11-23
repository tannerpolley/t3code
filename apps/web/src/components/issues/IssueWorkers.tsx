import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  RepositoryIssueSummary,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { runtimeRequestIsOwnerVisible } from "@t3tools/shared/delegatedRequestVisibility";
import { issueWorkerNeedsOwner } from "@t3tools/shared/issueWorkerStatus";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { useThreadShell } from "~/state/entities";
import { environmentThreadDetails } from "~/state/threads";
import { ChildApproval } from "../chat/ChildThreadApprovals";
import { PendingQuestionForm } from "../PendingQuestionForm";
import { useWorkerStatusLabels } from "./IssueLiveWork";
import { issueLiveWorkSummary, issueWorkerStatus } from "./issueRoadmap.logic";

export function IssueWorkers({
  issue,
  environmentId,
}: {
  issue: RepositoryIssueSummary;
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const labels = useWorkerStatusLabels();
  const summary = issueLiveWorkSummary(issue);
  if (summary === null) return null;
  return (
    <section className="space-y-2" aria-label={gt("Workers")}>
      <h3 className="font-medium">{gt("Workers")}</h3>
      <ul className="divide-y rounded-md border">
        {summary.work.map((worker) => (
          <li key={worker.threadId} className="space-y-2 p-2">
            <div className="flex items-baseline justify-between gap-2">
              <Link
                className="min-w-0 break-words font-medium hover:underline"
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: worker.threadId }}
              >
                {worker.title}
              </Link>
              <span className="shrink-0 text-muted-foreground">
                {labels[issueWorkerStatus(worker)]}
              </span>
            </div>
            {worker.branch ? (
              <p className="break-all font-mono text-muted-foreground">{worker.branch}</p>
            ) : null}
            {issueWorkerNeedsOwner(worker) ? (
              <WorkerRequest threadRef={scopeThreadRef(environmentId, worker.threadId)} />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkerRequest({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const thread = useThreadShell(threadRef);
  const request = thread?.source.pendingRuntimeRequest;
  const routedTo = request?.routedTo;
  const parent = useThreadShell(
    routedTo === undefined ? null : scopeThreadRef(threadRef.environmentId, routedTo),
  );
  if (!thread || !request || thread.archivedAt !== null || thread.source.deletedAt !== null)
    return null;
  if (!runtimeRequestIsOwnerVisible(request, parent?.source))
    return (
      <p className="text-muted-foreground">
        {gt("Routed to {thread}", { thread: parent?.title ?? "" })}
      </p>
    );
  if (request.kind === "user_input")
    return <PendingQuestionForm key={request.id} {...threadRef} requestId={request.id} />;
  if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") return null;
  return (
    <WorkerApproval
      key={request.id}
      threadRef={threadRef}
      requestId={request.id}
      title={thread.title}
    />
  );
}

function WorkerApproval({
  threadRef,
  requestId,
  title,
}: {
  threadRef: ScopedThreadRef;
  requestId: RuntimeRequestId;
  title: string;
}) {
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(threadRef));
  const approval = requests?.approvals.find((entry) => entry.requestId === requestId);
  return approval === undefined ? null : (
    <ChildApproval entry={{ thread: threadRef, title, approval }} />
  );
}
