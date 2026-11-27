import { useAtomValue } from "@effect/atom-react";
import { workflowReferenceThreadId } from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRun } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { serverEnvironment } from "./server";

const runsFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const live = get(serverEnvironment.workflowsLive({ environmentId, input: {} }));
    return live._tag === "Success" ? live.value.runs : [];
  }).pipe(Atom.withLabel(`sidebar-workflows:${environmentId}`)),
);
const runsList = environmentAtomList("sidebar-workflows", runsFamily);

export function useSidebarWorkflowRuns(environmentIds: ReadonlyArray<EnvironmentId>) {
  const results = useAtomValue(runsList(environmentIdsKey(environmentIds)));
  const byThread = new Map<string, WorkflowRun[]>();
  results.forEach((runs, index) => {
    for (const run of runs) {
      if (run.status !== "running" && run.status !== "waiting") continue;
      const threadId = run.subject && workflowReferenceThreadId(run.subject);
      if (threadId === null) continue;
      const key = `${environmentIds[index]}:${threadId}`;
      const entries = byThread.get(key) ?? [];
      entries.push(run);
      byThread.set(key, entries);
    }
  });
  return byThread;
}
