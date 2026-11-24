import { T, msg, useGT, useMessages } from "gt-react";
import type { MessageResolver } from "~/i18n/messages";
import type {
  EnvironmentId,
  IssueChange,
  IssueChangeDecisionInput,
  IssueChangesListInput,
} from "@t3tools/contracts";
import { useState } from "react";
import { useServerConfigs } from "~/state/entities";
import { repositoryIssueEnvironment } from "~/state/repositoryIssues";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";

function title(change: IssueChange, resolve: MessageResolver) {
  const op = change.operation;
  switch (op.type) {
    case "body":
      return resolve(msg("Edit #{number} body", { number: op.number }));
    case "status":
      return op.clearOrchestratorHold
        ? resolve(msg("Move #{number} to Todo and clear Needs orchestrator", { number: op.number }))
        : resolve(msg("Move #{number} to {status}", { number: op.number, status: op.status }));
    case "state":
      return op.state === "closed"
        ? resolve(msg("Close #{number}", { number: op.number }))
        : resolve(msg("Reopen #{number}", { number: op.number }));
    case "milestone":
      return op.milestoneNumber === null
        ? resolve(msg("Move #{number} to no milestone", { number: op.number }))
        : resolve(
            msg("Move #{number} to milestone #{milestone}", {
              number: op.number,
              milestone: op.milestoneNumber,
            }),
          );
    case "split":
      return resolve(
        msg(
          "{count, plural, one {Split issue {number} into {count} sub-issue} other {Split issue {number} into {count} sub-issues}}",
          {
            number: op.number,
            count: op.issues.length,
          },
        ),
      );
    case "create":
      return resolve(msg("Create issue: {title}", { title: op.title }));
    case "blocked_by":
      return op.action === "add"
        ? resolve(
            msg("Add #{blocker} as a blocker of #{number}", {
              blocker: op.blockerNumber,
              number: op.number,
            }),
          )
        : resolve(
            msg("Remove #{blocker} as a blocker of #{number}", {
              blocker: op.blockerNumber,
              number: op.number,
            }),
          );
    case "sub_issue":
      return op.action === "add"
        ? resolve(msg("Add #{child} under #{number}", { child: op.childNumber, number: op.number }))
        : resolve(
            msg("Remove #{child} from #{number}", { child: op.childNumber, number: op.number }),
          );
  }
}

/** The same durable decision cards appear beside the requesting thread and issue. */
export function IssueChangeCards(props: {
  environmentId: EnvironmentId;
  input: IssueChangesListInput;
  compact?: boolean;
}) {
  const configs = useServerConfigs();
  if (configs.get(props.environmentId)?.environment.capabilities.issueChanges !== true) return null;
  return <Cards {...props} />;
}

function Cards({
  environmentId,
  input,
  compact = false,
}: {
  environmentId: EnvironmentId;
  input: IssueChangesListInput;
  compact?: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const query = useEnvironmentQuery(repositoryIssueEnvironment.changes({ environmentId, input }));
  const decide = useAtomCommand(repositoryIssueEnvironment.decideChange, { reportFailure: false });
  const [responding, setResponding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changes = query.data ?? [];
  if (changes.length === 0 && error === null && query.error === null) return null;
  const respond = async (id: string, decision: IssueChangeDecisionInput["decision"]) => {
    setResponding(id);
    setError(null);
    const result = await decide({ environmentId, input: { id, decision } });
    setResponding(null);
    if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
    query.refresh();
  };
  const decisions = {
    pending: gt("Pending"),
    auto_approved: gt("Auto-approved"),
    approved: gt("Approved"),
    rejected: gt("Rejected"),
  };
  const statuses = {
    pending: decisions.pending,
    queued: gt("Queued"),
    executing: gt("Executing"),
    succeeded: gt("Succeeded"),
    failed: gt("Failed"),
    conflict: gt("Conflict"),
    needs_attention: gt("Needs attention"),
    resolved: gt("Resolved"),
    rejected: decisions.rejected,
  };
  const issueStates = { open: gt("Open", { $context: "issue state" }), closed: gt("Closed") };
  const card = (change: IssueChange) => (
    <article key={change.id} className="rounded-lg border border-border bg-background p-3 text-xs">
      <p className="font-medium">{title(change, resolve)}</p>
      <p className="mt-1 text-muted-foreground" role="status">
        {change.decision === "pending"
          ? gt("Waiting for your approval")
          : `${decisions[change.decision]} · ${statuses[change.status]}`}
        {change.result ? ` · ${change.result}` : ""}
      </p>
      <details className="mt-2" open={change.decision === "pending"}>
        <summary className="cursor-pointer">
          <T>Exact change preview</T>
        </summary>
        {change.operation.type === "state" ? (
          <p className="my-2">
            <T>State:</T> {change.baseline ? issueStates[change.baseline.state] : ""} →{" "}
            {issueStates[change.operation.state]}
          </p>
        ) : null}
        {change.t3AuthoredBody ? (
          <p className="my-2 text-muted-foreground">
            <T>Current body matches the last body written by T3.</T>
          </p>
        ) : null}
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono">
          {change.diff ?? JSON.stringify(change.operation, null, 2)}
        </pre>
        {Object.entries(change.completedSteps).map(([step, result]) => (
          <p key={step} className="mt-1">
            {result.issue ? (
              <>
                <T>Created issue:</T>{" "}
                <a href={result.issue.url} target="_blank" rel="noreferrer" className="underline">
                  #{result.issue.number} {result.issue.title}
                </a>
              </>
            ) : step === "write" ||
              step === "clear-hold" ||
              step.startsWith("status:") ||
              step.startsWith("hold:") ? (
              gt("Issue updated")
            ) : (
              gt("Sub-issue linked")
            )}
          </p>
        ))}
      </details>
      {change.operation.type !== "milestone" && change.decision === "pending" ? (
        <div className="mt-3 flex gap-2">
          <Button
            size="xs"
            disabled={responding !== null}
            onClick={() => void respond(change.id, "approved")}
          >
            <T>Approve</T>
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={responding !== null}
            onClick={() => void respond(change.id, "rejected")}
          >
            <T>Reject</T>
          </Button>
        </div>
      ) : null}
      {change.status === "needs_attention" ? (
        <div className="mt-3">
          <p className="mb-2 text-muted-foreground">
            <T>Check GitHub before resolving. Mark resolved stops all remaining steps.</T>
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={responding !== null}
            onClick={() => void respond(change.id, "resolved")}
          >
            <T>Mark resolved</T>
          </Button>
        </div>
      ) : null}
      {change.operation.type !== "milestone" && change.status === "failed" ? (
        <div className="mt-3">
          <Button
            size="xs"
            variant="outline"
            disabled={responding !== null}
            onClick={() => void respond(change.id, "retry")}
          >
            <T>Retry remaining steps</T>
          </Button>
        </div>
      ) : null}
    </article>
  );
  const actionable = changes.filter(
    (change) => change.decision === "pending" || change.status === "needs_attention",
  );
  const decided = changes.filter(
    (change) => change.decision !== "pending" && change.status !== "needs_attention",
  );
  return (
    <section aria-label={gt("Issue changes")} className="mb-3 max-h-96 overflow-y-auto">
      {(error ?? query.error) ? (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
      <div className="space-y-2">{actionable.map(card)}</div>
      {decided.length > 0 ? (
        <details className="mt-2" open={!compact && actionable.length === 0}>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {gt("Issue change results ({count})", { count: decided.length })}
          </summary>
          <div className="mt-2 space-y-2">{decided.map(card)}</div>
        </details>
      ) : null}
    </section>
  );
}
