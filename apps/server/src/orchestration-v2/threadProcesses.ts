/**
 * Which of a thread's commands and tasks are running, and which sampled processes they run.
 * Pure: the `BackgroundTasks` service reads the records and the process sample.
 */
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ResourceTelemetryProcess,
  ThreadId,
  ThreadProcessGroup,
  ThreadRunningCommand,
} from "@t3tools/contracts";
import {
  pendingBackgroundTurnItems,
  pendingBackgroundWorkOfThread,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  classifyShellCommand,
  shellCommandWaitPids,
  shellCommandWords,
} from "@t3tools/shared/shellCommand";
import * as DateTime from "effect/DateTime";

/**
 * A thread's running work, not gated on an active run the way the sidebar's pending list is: the
 * provider roster's tasks (its own, and shells it started in its parent's session) and its
 * command items still running that the roster does not list. Items of rolled-back runs are
 * abandoned, not running.
 */
export function runningThreadWork(input: {
  readonly threadId: ThreadId;
  readonly ownRoster: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly parentRoster: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>;
}): {
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly commands: ReadonlyArray<ThreadRunningCommand>;
} {
  const roster = pendingBackgroundWorkOfThread(
    input.threadId,
    input.ownRoster,
    input.parentRoster,
  ).filter((task) => task.kind !== "subagent");
  const rosterIds = new Set(roster.map((task) => task.taskId));
  const commands = pendingBackgroundTurnItems({ turnItems: input.turnItems, runs: input.runs })
    .filter(
      (item): item is Extract<OrchestrationV2TurnItem, { type: "command_execution" }> =>
        item.type === "command_execution",
    )
    .map((item) => ({ item, taskId: item.nativeItemRef?.nativeId ?? item.id }))
    .filter(({ taskId }) => !rosterIds.has(taskId))
    .map(({ item, taskId }) => ({
      taskId,
      command: item.input.trim(),
      commandKind: classifyShellCommand(item.input),
      startedAt: item.startedAt === null ? null : DateTime.formatIso(item.startedAt),
      followable: item.nativeItemRef?.driver === "codex" && item.nativeItemRef.nativeId !== null,
    }));
  return {
    tasks: [
      ...roster,
      ...commands.map(({ taskId, command, commandKind }) => ({
        taskId,
        kind: "command" as const,
        command,
        commandKind,
      })),
    ],
    commands,
  };
}

type SampledProcess = Pick<
  ResourceTelemetryProcess,
  "identity" | "ppid" | "command" | "cpuPercent" | "residentBytes"
>;

/** The script of `<shell> -c '<script>'`, the way Codex runs every command; otherwise null. */
function shellScript(command: string): string | null {
  const commands = shellCommandWords(command);
  if (commands.length !== 1) return null;
  const [shell = "", flag = "", script = "", ...rest] = commands[0]!;
  return /(^|\/)(ba|z|da|k)?sh$/.test(shell) &&
    /^-[a-z]*c[a-z]*$/.test(flag) &&
    script.trim().length > 0 &&
    rest.length === 0
    ? script.trim()
    : null;
}

/**
 * The one sampled process tree running `command`: the processes whose command line holds it
 * (`matched`, the shell wrappers and the command itself) and every descendant (`tree`). Null when
 * nothing matches or identical commands run in separate trees, since then no tree is provably
 * this command's.
 */
export function attributeCommandProcesses(input: {
  readonly processes: ReadonlyArray<SampledProcess>;
  readonly serverPid: number;
  readonly command: string | null;
  readonly commandKind?: string;
}): { readonly matched: ReadonlySet<number>; readonly tree: ReadonlySet<number> } | null {
  const command = input.command?.trim();
  if (!command) return null;
  const script = shellScript(command);
  const processes = new Map(
    input.processes
      .filter((process) => process.identity.pid !== input.serverPid)
      .map((process) => [process.identity.pid, process]),
  );
  const matched = new Set(
    [...processes.values()]
      .filter(
        (process) =>
          process.command.includes(command) ||
          // Codex quotes the script it hands `bash -lc`; the process line holds it unquoted.
          (script !== null && process.command.includes(script)) ||
          // Claude escapes the command as an eval operand before passing it to Bash.
          (process.command.includes("eval") &&
            shellCommandWords(process.command).some(
              (words) => words[0] === "eval" && words.length === 2 && words[1]?.trim() === command,
            )),
      )
      .map((process) => process.identity.pid),
  );
  if (matched.size === 0) return null;

  const childrenByParent = new Map<number, number[]>();
  for (const process of processes.values()) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process.identity.pid);
    childrenByParent.set(process.ppid, children);
  }

  const roots = [...matched].filter((pid) => {
    const seen = new Set<number>();
    let current = processes.get(pid)?.ppid;
    while (current !== undefined && processes.has(current) && !seen.has(current)) {
      if (matched.has(current)) return false;
      seen.add(current);
      current = processes.get(current)?.ppid;
    }
    return true;
  });
  if (roots.length !== 1) return null;
  const tree = new Set<number>();
  const pending = [...roots];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (tree.has(pid)) continue;
    tree.add(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }

  // A watcher's own tree is only a sleep loop; it counts only when it waits on a process inside it.
  if (input.commandKind === "watcher" || classifyShellCommand(command) === "watcher") {
    const waitPids = shellCommandWaitPids(command);
    if (waitPids === null || waitPids.some((pid) => !tree.has(pid))) return null;
  }
  return { matched, tree };
}

/** Most process groups listed under one thread; the rest are counted. */
export const VISIBLE_PROCESS_GROUPS = 5;

// Wait loops start one of these every few seconds; listing them would only add churn.
const UNLISTED_PROGRAMS = new Set(["sleep"]);

/** A process's command line as words, with the program and absolute paths cut to file names. */
function processWords(command: string): Array<string> {
  return command
    .trim()
    .split(/\s+/)
    .map((word) => (word.startsWith("/") ? word.slice(word.lastIndexOf("/") + 1) || word : word));
}

/**
 * The processes the given commands spawned, beyond the command lines themselves, grouped by shape:
 * the same words once every number is ignored, so ten `python worker.py --shard N` are one group.
 * Largest groups first, `limit` of them.
 */
export function groupSpawnedProcesses(input: {
  readonly processes: ReadonlyArray<SampledProcess>;
  readonly serverPid: number;
  readonly commands: ReadonlyArray<{
    readonly command: string | null;
    readonly commandKind?: string;
  }>;
  readonly limit?: number;
}): { readonly groups: ReadonlyArray<ThreadProcessGroup>; readonly hiddenCount: number } {
  const commandPids = new Set<number>();
  const spawned = new Set<number>();
  for (const { command, commandKind } of input.commands) {
    const attributed = attributeCommandProcesses({
      processes: input.processes,
      serverPid: input.serverPid,
      command,
      ...(commandKind === undefined ? {} : { commandKind }),
    });
    if (attributed === null) continue;
    for (const pid of attributed.matched) commandPids.add(pid);
    for (const pid of attributed.tree) spawned.add(pid);
  }
  const byPid = new Map(input.processes.map((process) => [process.identity.pid, process]));
  const groups = new Map<
    string,
    { members: Array<Array<string>>; cpuPercent: number; residentBytes: number }
  >();
  for (const pid of spawned) {
    const process = byPid.get(pid);
    if (process === undefined || commandPids.has(pid)) continue;
    const words = processWords(process.command);
    if (words[0] === "" || UNLISTED_PROGRAMS.has(words[0]!)) continue;
    const key = words.map((word) => word.replace(/\d+/g, "#")).join(" ");
    const group = groups.get(key) ?? { members: [], cpuPercent: 0, residentBytes: 0 };
    group.members.push(words);
    group.cpuPercent += process.cpuPercent;
    group.residentBytes += process.residentBytes;
    groups.set(key, group);
  }
  const listed = [...groups].map(([key, group]) => {
    const shape = key.split(" ");
    const first = group.members[0]!;
    return {
      label: first
        .map((word, index) =>
          group.members.every((member) => member[index] === word) ? word : shape[index]!,
        )
        .join(" "),
      count: group.members.length,
      cpuPercent: group.cpuPercent,
      residentBytes: group.residentBytes,
    };
  });
  listed.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  const limit = input.limit ?? VISIBLE_PROCESS_GROUPS;
  return { groups: listed.slice(0, limit), hiddenCount: Math.max(0, listed.length - limit) };
}
