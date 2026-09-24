import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupThreadLineageRows, resolveSubagentProgressText } from "./ThreadRelationshipsControl";

describe("thread lineage groups", () => {
  const parent = ThreadId.make("parent");
  const row = (id: string, kind: "fork" | "subagent", status: string) => ({
    threadId: ThreadId.make(id),
    fromThreadId: parent,
    depth: 1,
    edge: { sourceThreadId: parent, targetThreadId: ThreadId.make(id), kind, status },
  });
  const rows = [
    row("fork", "fork", "completed"),
    row("running", "subagent", "running"),
    row("done-before", "subagent", "completed"),
    row("failed-unknown-time", "subagent", "failed"),
    row("done-after", "subagent", "completed"),
  ];
  const finishedAt = (threadId: ThreadId) =>
    ({ running: 50, "done-before": 90, "done-after": 200 })[threadId as string] ?? null;
  const ids = (list: ReadonlyArray<{ readonly threadId: ThreadId }>) =>
    list.map(({ threadId }) => threadId);

  it("lists every finished agent until cleared", () => {
    const groups = groupThreadLineageRows({
      rows,
      currentThreadId: parent,
      clearedAt: null,
      finishedAt,
    });
    expect(ids(groups.related)).toEqual(["fork"]);
    expect(ids(groups.active)).toEqual(["running"]);
    expect(ids(groups.previous)).toEqual(["done-before", "failed-unknown-time", "done-after"]);
    expect(groups.clearedCount).toBe(0);
  });

  it("clears only agents that settled by the clear, never live ones", () => {
    const groups = groupThreadLineageRows({
      rows,
      currentThreadId: parent,
      clearedAt: 100,
      finishedAt,
    });
    expect(ids(groups.active)).toEqual(["running"]);
    expect(ids(groups.previous)).toEqual(["done-after"]);
    expect(groups.clearedCount).toBe(2);
  });
});

describe("subagent progress line", () => {
  const assistant = { role: "assistant" as const, text: "Running  the\n unit tests" };

  it("prefers reported progress, then the result once settled", () => {
    expect(
      resolveSubagentProgressText({
        status: "running",
        progress: "Reading files",
        result: null,
        latestMessage: assistant,
      }),
    ).toBe("Reading files");
    expect(
      resolveSubagentProgressText({
        status: "completed",
        progress: "Reading files",
        result: "All good",
        latestMessage: assistant,
      }),
    ).toBe("All good");
  });

  it("falls back to the child's latest assistant message when nothing is reported", () => {
    expect(
      resolveSubagentProgressText({ status: "running", result: null, latestMessage: assistant }),
    ).toBe("Running the unit tests");
    expect(
      resolveSubagentProgressText({
        status: "running",
        result: null,
        latestMessage: { role: "user", text: "Check the change" },
      }),
    ).toBe("");
  });
});
