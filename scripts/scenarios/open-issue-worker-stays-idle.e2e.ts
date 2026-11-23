/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A completed child turn leaves its open issue worker Idle",
  WEB,
  async ({ t3, browser, screen, app }) => {
    const project = await t3.project("Worker status fixture");
    const parent = await t3.thread({ project, title: "Orchestrator", messages: ["Start"] });
    const child = await t3.thread({
      project,
      title: "Issue worker",
      messages: ["Report progress"],
    });
    // Replay gives the worker a real completed turn. Add a synthetic managed claim and parent
    // to its shell at the transport boundary so the fixture needs neither GitHub nor a paid model.
    await browser.addInitScript(
      ({ parentId, childId }) => {
        const linkedIssue = {
          host: "github.com",
          repository: "fixture/workers",
          repositoryId: "fixture-repo",
          id: "fixture-issue",
          nodeId: "fixture-issue",
          number: 42,
          title: "Open issue",
          url: "https://github.com/fixture/workers/issues/42",
        };
        const fetch = window.fetch;
        window.fetch = async (input, init) => {
          const response = await fetch(input, init);
          const url = input instanceof Request ? input.url : String(input);
          if (new URL(url, location.href).pathname !== "/api/orchestration/shell" || !response.ok)
            return response;
          const shell = await response.json();
          if (!Array.isArray(shell.threads)) return Response.json(shell);
          return Response.json({
            ...shell,
            threads: shell.threads.map((row: { id: string; createdAt: string }) =>
              row.id === childId
                ? {
                    ...row,
                    linkedIssue,
                    role: "implementor",
                    lastVisitedAt: row.createdAt,
                    lineage: {
                      parentThreadId: parentId,
                      rootThreadId: parentId,
                      relationshipToParent: "subagent",
                    },
                  }
                : row,
            ),
          });
        };
      },
      { parentId: parent.threadId, childId: child.threadId },
    );

    await t3.open(parent);
    const worker = screen.getByRole("button", { name: /Issue worker/ });
    await worker.waitFor();
    await app.screenshot("open-issue-worker");
    await expect(worker.getByText("Idle", { exact: true })).toBeVisible();
  },
);
