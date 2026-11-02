import { ProviderThreadId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { findBackgroundTaskProviderThread, findWatchedPullRequest } from "./BackgroundTaskStop.ts";

const parentThreadId = ThreadId.make("thread-parent");
const childThreadId = ThreadId.make("thread-child");
const otherChildThreadId = ThreadId.make("thread-other-child");
const shell = (taskId: string, owner?: ThreadId) => ({
  taskId,
  kind: "command" as const,
  ...(owner === undefined ? {} : { ownerThreadId: owner }),
});
const parentProviderThread = {
  id: ProviderThreadId.make("provider-parent"),
  pendingBackgroundTasks: [
    shell("parent-shell"),
    shell("child-shell", childThreadId),
    shell("other-child-shell", otherChildThreadId),
  ],
};
const codexProviderThread = {
  id: ProviderThreadId.make("provider-codex"),
  pendingBackgroundTasks: [],
};
const commandItem = (id: string, status: "running" | "completed") => ({
  id: TurnItemId.make(id),
  type: "command_execution" as const,
  status,
  nativeItemRef: null,
  providerThreadId: codexProviderThread.id,
});

describe("findBackgroundTaskProviderThread", () => {
  it("finds a subagent's shell on its parent's roster, and only its own", () => {
    const find = (taskId: string) =>
      findBackgroundTaskProviderThread({
        threadId: childThreadId,
        taskId,
        own: { providerThreads: [], turnItems: [] },
        parentProviderThreads: [parentProviderThread],
      });
    expect(find("child-shell")).toBe(parentProviderThread);
    // The parent's own shell and a sibling's shell are not the child's to stop.
    expect(find("parent-shell")).toBeNull();
    expect(find("other-child-shell")).toBeNull();
  });

  it("finds any shell on the thread's own roster", () => {
    expect(
      findBackgroundTaskProviderThread({
        threadId: parentThreadId,
        taskId: "child-shell",
        own: { providerThreads: [parentProviderThread], turnItems: [] },
        parentProviderThreads: [],
      }),
    ).toBe(parentProviderThread);
  });

  it("finds a running Codex background command by its item id", () => {
    const find = (taskId: string) =>
      findBackgroundTaskProviderThread({
        threadId: parentThreadId,
        taskId,
        own: {
          providerThreads: [codexProviderThread],
          turnItems: [
            commandItem("call-running", "running"),
            commandItem("call-done", "completed"),
          ],
        },
        parentProviderThreads: [],
      });
    expect(find("call-running")).toBe(codexProviderThread);
    expect(find("call-done")).toBeNull();
    expect(find("call-unknown")).toBeNull();
  });

  it("maps a pull request watch row back to the watched link", () => {
    const watch = { startedAt: "2026-10-30T04:13:41.608Z" };
    const link = (number: number, watched: boolean) => ({
      host: "github.com",
      repository: "Acme/App",
      number,
      url: `https://github.com/Acme/App/pull/${number}`,
      source: "agent" as const,
      snapshot: null,
      ...(watched ? { watch } : {}),
    });
    const links = [link(1, false), link(2, true)];
    const [row] = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [],
      turnItems: [],
      pullRequests: links as never,
    });
    expect(findWatchedPullRequest(links as never, row!.taskId)).toBe(links[1]);
    expect(
      findWatchedPullRequest(links as never, "pull-request-watch:github.com/acme/app#1"),
    ).toBeNull();
  });
});
