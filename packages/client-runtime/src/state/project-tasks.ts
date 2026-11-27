import type { EnvironmentThreadShell } from "./models.js";

export type ProjectTaskKind = "commands" | "monitors" | "terminals" | "workflows";

export interface ProjectTask {
  readonly kind: ProjectTaskKind;
  readonly id: string;
  readonly thread: EnvironmentThreadShell;
  readonly description: string;
  readonly startedAt: string | null;
}

/** Collect work once for a project, preserving its owning thread for navigation. */
export function projectTasks(
  threads: readonly EnvironmentThreadShell[],
  runningTerminals: ReadonlyMap<
    string,
    readonly { terminalId: string; label: string; updatedAt: string }[]
  >,
  workflowRuns: ReadonlyMap<string, readonly { runId: string; title: string; startedAt: string }[]>,
): readonly ProjectTask[] {
  const tasks: ProjectTask[] = [];
  for (const thread of threads) {
    const key = `${thread.environmentId}:${thread.id}`;
    for (const task of thread.pendingBackgroundTasks) {
      const kind =
        task.kind === "monitor"
          ? "monitors"
          : task.kind === "command" || task.kind === "background_task"
            ? "commands"
            : null;
      if (kind === null) continue;
      tasks.push({
        kind,
        id: task.taskId,
        thread,
        description: task.description ?? task.taskId,
        startedAt: thread.latestRun?.startedAt ?? null,
      });
    }
    for (const terminal of runningTerminals.get(key) ?? []) {
      tasks.push({
        kind: "terminals",
        id: terminal.terminalId,
        thread,
        description: terminal.label,
        startedAt: terminal.updatedAt,
      });
    }
    for (const run of workflowRuns.get(key) ?? []) {
      tasks.push({
        kind: "workflows",
        id: run.runId,
        thread,
        description: run.title,
        startedAt: run.startedAt,
      });
    }
  }
  return tasks;
}
