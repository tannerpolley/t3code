import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ProviderThreadId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

/** Only queued work on the exhausted instance follows its automatic continuation. */
export function usageLimitQueuedRunEvents(
  projection: OrchestrationV2ThreadProjection,
  providerThreadId: ProviderThreadId,
  now: DateTime.Utc,
): Array<Omit<OrchestrationV2DomainEvent, "id">> {
  const marker = projection.thread.autoProviderSwitch;
  if (marker?.to == null) return [];
  const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = [];
  for (const run of projection.runs.filter(
    (run) => run.status === "queued" && run.providerInstanceId === marker.from.instanceId,
  )) {
    events.push({
      type: "run.updated",
      threadId: projection.thread.id,
      runId: run.id,
      occurredAt: now,
      payload: {
        ...run,
        modelSelection: marker.to,
        providerInstanceId: marker.to.instanceId,
        providerThreadId,
      },
    });
    const attempt = projection.attempts.find((attempt) => attempt.id === run.activeAttemptId);
    if (attempt)
      events.push({
        type: "run-attempt.updated",
        threadId: projection.thread.id,
        runId: run.id,
        occurredAt: now,
        payload: { ...attempt, providerInstanceId: marker.to.instanceId },
      });
    const node = projection.nodes.find((node) => node.id === run.rootNodeId);
    if (node)
      events.push({
        type: "node.updated",
        threadId: projection.thread.id,
        runId: run.id,
        occurredAt: now,
        payload: { ...node, providerThreadId },
      });
    const scope = projection.checkpointScopes.find((scope) => scope.id === node?.checkpointScopeId);
    if (scope)
      events.push({
        type: "checkpoint-scope.created",
        threadId: projection.thread.id,
        runId: run.id,
        occurredAt: now,
        payload: { ...scope, providerThreadId },
      });
  }
  return events;
}
