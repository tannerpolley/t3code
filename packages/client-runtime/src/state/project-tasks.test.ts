import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "./models.js";
import { projectTasks } from "./project-tasks.js";

const thread = {
  environmentId: "env",
  id: "thread",
  title: "Build",
  latestRun: { startedAt: "2026-11-27T12:00:00Z" },
  pendingBackgroundTasks: [
    { taskId: "command", kind: "command", description: "compile" },
    { taskId: "watch", kind: "monitor", description: "watch tests" },
    { taskId: "child", kind: "subagent" },
  ],
} as unknown as EnvironmentThreadShell;

describe("projectTasks", () => {
  it("groups each running source by its owning thread and excludes subagents", () => {
    const tasks = projectTasks(
      [thread],
      new Map([
        [
          "env:thread",
          [{ terminalId: "terminal", label: "shell", updatedAt: "2026-11-27T12:01:00Z" }],
        ],
      ]),
      new Map([
        ["env:thread", [{ runId: "run", title: "Release", startedAt: "2026-11-27T12:02:00Z" }]],
      ]),
    );
    expect(tasks.map(({ kind, id, description }) => [kind, id, description])).toEqual([
      ["commands", "command", "compile"],
      ["monitors", "watch", "watch tests"],
      ["terminals", "terminal", "shell"],
      ["workflows", "run", "Release"],
    ]);
    expect(tasks.every((task) => task.thread === thread)).toBe(true);
  });

  it("removes a terminal when the live roster no longer reports it", () => {
    expect(projectTasks([{ ...thread, pendingBackgroundTasks: [] }], new Map(), new Map())).toEqual(
      [],
    );
  });
});
