import { expect, it } from "vite-plus/test";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { notebookWorkspaceIdentity } from "./notebookWorkspaceIdentity";

it("gives file-tree and absolute artifact opens the same thread workspace identity and excludes host files and attachments", () => {
  const context = {
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make("thread"),
    workspaceRoot: "/repo.worktrees/task",
    staticOnly: false,
  };
  const tree = notebookWorkspaceIdentity({ ...context, path: "results/test.ipynb" });
  expect(tree).toEqual({
    projectId: context.projectId,
    threadId: context.threadId,
    relativePath: "results/test.ipynb",
  });
  expect(
    notebookWorkspaceIdentity({ ...context, path: "/repo.worktrees/task/results/test.ipynb" }),
  ).toEqual(tree);
  for (const path of [
    "/other/test.ipynb",
    "/repo.worktrees/task/../outside.ipynb",
    "~/test.ipynb",
    "https://example.com/test.ipynb",
    "plot.png",
  ])
    expect(notebookWorkspaceIdentity({ ...context, path })).toBeNull();
  expect(
    notebookWorkspaceIdentity({ ...context, path: "results/test.ipynb", staticOnly: true }),
  ).toBeNull();
});
