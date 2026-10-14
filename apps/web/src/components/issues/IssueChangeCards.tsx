import {
  issueChangePreview,
  issueChangeTitle,
  type EnvironmentId,
  type IssueChange,
  type IssueChangeDecisionInput,
  type IssueChangesListInput,
} from "@t3tools/contracts";
import { useState } from "react";
import { useServerConfigs } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";

/**
 * An issue's change history. Agents ask about pending changes in their thread; one whose
 * question was dismissed, or that predates those questions, can still be decided here.
 */
export function IssueChangeCards(props: {
  environmentId: EnvironmentId;
  input: IssueChangesListInput;
}) {
  const configs = useServerConfigs();
  if (configs.get(props.environmentId)?.environment.capabilities.issueChanges !== true) return null;
  return <Cards {...props} />;
}

function Cards({
  environmentId,
  input,
}: {
  environmentId: EnvironmentId;
  input: IssueChangesListInput;
}) {
  const query = useEnvironmentQuery(issueEnvironment.changes({ environmentId, input }));
  const decide = useAtomCommand(issueEnvironment.decideChange, { reportFailure: false });
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
  const card = (change: IssueChange) => (
    <article key={change.id} className="rounded-lg border border-border bg-background p-3 text-xs">
      <p className="font-medium">{issueChangeTitle(change)}</p>
      <p className="mt-1 text-muted-foreground" role="status">
        {change.decision === "pending"
          ? "Waiting for your approval"
          : `${change.decision.replaceAll("_", " ")} · ${change.status.replaceAll("_", " ")}`}
        {change.result ? ` · ${change.result}` : ""}
      </p>
      <details className="mt-2" open={change.decision === "pending"}>
        <summary className="cursor-pointer">Exact change preview</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono">
          {issueChangePreview(change)}
        </pre>
        {Object.entries(change.completedSteps).map(([step, result]) => (
          <p key={step} className="mt-1">
            {result.issue ? (
              <>
                Created issue:{" "}
                <a href={result.issue.url} target="_blank" rel="noreferrer" className="underline">
                  #{result.issue.number} {result.issue.title}
                </a>
              </>
            ) : step === "write" ? (
              "Issue updated"
            ) : (
              "Sub-issue linked"
            )}
          </p>
        ))}
      </details>
      {change.decision === "pending" ? (
        <div className="mt-3 flex gap-2">
          <Button
            size="xs"
            disabled={responding !== null}
            onClick={() => void respond(change.id, "approved")}
          >
            Approve
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={responding !== null}
            onClick={() => void respond(change.id, "rejected")}
          >
            Decline
          </Button>
        </div>
      ) : null}
      {change.status === "needs_attention" ? (
        <div className="mt-3">
          <p className="mb-2 text-muted-foreground">
            Check GitHub before resolving. Mark resolved stops all remaining steps.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={responding !== null}
            onClick={() => void respond(change.id, "resolved")}
          >
            Mark resolved
          </Button>
        </div>
      ) : null}
      {change.status === "failed" ? (
        <div className="mt-3">
          <Button
            size="xs"
            variant="outline"
            disabled={responding !== null}
            onClick={() => void respond(change.id, "retry")}
          >
            Retry remaining steps
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
    <section aria-label="Issue changes" className="mb-3 max-h-96 overflow-y-auto">
      {(error ?? query.error) ? (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
      <div className="space-y-2">{actionable.map(card)}</div>
      {decided.length > 0 ? (
        <details className="mt-2" open={actionable.length === 0}>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Issue change results ({decided.length})
          </summary>
          <div className="mt-2 space-y-2">{decided.map(card)}</div>
        </details>
      ) : null}
    </section>
  );
}
