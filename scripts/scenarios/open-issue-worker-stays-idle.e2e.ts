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
      title: "Open issue worker",
      messages: ["Report progress"],
    });
    const closed = await t3.thread({
      project,
      title: "Closed issue worker",
      messages: ["Report progress"],
    });
    // Replay gives the worker a real completed turn. Add a synthetic managed claim and parent
    // to its shell at the transport boundary so the fixture needs neither GitHub nor a paid model.
    await browser.addInitScript(
      ({ parentId, openId, closedId }) => {
        const linkedIssue = (closed: boolean) => ({
          host: "github.com",
          repository: "fixture/workers",
          repositoryId: "fixture-repo",
          id: closed ? "fixture-closed" : "fixture-open",
          nodeId: closed ? "fixture-closed" : "fixture-open",
          number: closed ? 43 : 42,
          title: closed ? "Closed issue" : "Open issue",
          url: `https://github.com/fixture/workers/issues/${closed ? 43 : 42}`,
        });
        let releaseStatus = false;
        const heldReplies: Array<() => void> = [];
        window.addEventListener("scenario-release-issue-status", () => {
          releaseStatus = true;
          for (const reply of heldReplies.splice(0)) reply();
        });
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          if (typeof data === "string") {
            const request = JSON.parse(data);
            if (request._tag === "Request" && request.tag === "issues.statusBatch") {
              const reply = () => {
                this.dispatchEvent(
                  new MessageEvent("message", {
                    data: JSON.stringify({
                      _tag: "Exit",
                      requestId: request.id,
                      exit: {
                        _tag: "Success",
                        value: request.payload.issues.map(
                          ({ host, nodeId }: { host: string; nodeId: string }) => ({
                            host,
                            nodeId,
                            state: nodeId === "fixture-closed" ? "closed" : "open",
                            stateReason: null,
                            blockedBy: [],
                            pullRequests: [],
                          }),
                        ),
                      },
                    }),
                  }),
                );
              };
              if (releaseStatus) queueMicrotask(reply);
              else heldReplies.push(reply);
              return;
            }
          }
          return send.call(this, data);
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
              row.id === openId || row.id === closedId
                ? {
                    ...row,
                    linkedIssue: linkedIssue(row.id === closedId),
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
      { parentId: parent.threadId, openId: child.threadId, closedId: closed.threadId },
    );

    await t3.open(parent);
    const openWorker = screen.getByRole("button", { name: /Open issue worker/ });
    const closedWorker = screen.getByRole("button", { name: /Closed issue worker/ });
    await openWorker.waitFor();
    await closedWorker.waitFor();
    await screen.getByText("first fixture turn complete").waitFor();
    try {
      await expect(closedWorker.getByText("Idle", { exact: true })).not.toBeVisible();
      await browser.evaluate(() =>
        window.dispatchEvent(new Event("scenario-release-issue-status")),
      );
      await expect(openWorker.getByText("Idle", { exact: true })).toBeVisible();
      await expect(openWorker.getByText("Done", { exact: true })).not.toBeVisible();
      await expect(closedWorker.getByText("Done", { exact: true })).toBeVisible();
    } finally {
      await app.screenshot("open-and-closed-issue-workers");
    }
  },
);
