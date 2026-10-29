import type { NotebookIdentity, ProjectId, ThreadId } from "@t3tools/contracts";
import { isHostPath, workspaceRelativeFilePath } from "@t3tools/shared/path";

export function notebookWorkspaceIdentity(input: {
  projectId: ProjectId | null;
  threadId: ThreadId;
  workspaceRoot: string;
  path: string | null;
  staticOnly: boolean;
}): NotebookIdentity | null {
  if (input.staticOnly || !input.projectId || !input.path?.endsWith(".ipynb")) return null;
  if (!isHostPath(input.path) && /^[a-z][a-z\d+.-]*:/i.test(input.path)) return null;
  const relativePath = isHostPath(input.path)
    ? workspaceRelativeFilePath(input.path, input.workspaceRoot)
    : input.path;
  if (!relativePath || relativePath === ".") return null;
  return { projectId: input.projectId, threadId: input.threadId, relativePath };
}
