import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createTerminalEnvironmentAtoms } from "@t3tools/client-runtime/state/terminal";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";

import { connectionAtomRuntime } from "../connection/runtime";
import { readProject, readThreadShell } from "./entities";

export const terminalEnvironment = createTerminalEnvironmentAtoms(connectionAtomRuntime);

/**
 * Where a new terminal for a thread opens, like the terminal drawer's: its worktree when it has
 * one, else its project root, with the project script environment. Null without a known project.
 */
export function readThreadTerminalLaunch(threadRef: ScopedThreadRef) {
  const thread = readThreadShell(threadRef);
  const project = thread
    ? readProject(scopeProjectRef(threadRef.environmentId, thread.projectId))
    : null;
  if (!thread || !project) return null;
  const target = { project: { cwd: project.workspaceRoot }, worktreePath: thread.worktreePath };
  return {
    thread,
    open: {
      cwd: projectScriptCwd(target),
      ...(thread.worktreePath != null ? { worktreePath: thread.worktreePath } : {}),
      env: projectScriptRuntimeEnv(target),
    },
  };
}
