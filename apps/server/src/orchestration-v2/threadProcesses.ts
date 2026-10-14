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
  shellProgramName,
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

const SHELL_PROGRAM = /(^|\/)(ba|z|da|k)?sh$/;
const SHELL_SCRIPT_FLAG = /^-[a-z]*c[a-z]*$/;

/** Text with every whitespace run made one space, the way a sampled command line reads. */
const oneLine = (text: string) => text.trim().split(/\s+/).join(" ");

/** The script of `<shell> -c '<script>'`, the way Codex runs every command; otherwise null. */
function shellScript(command: string): string | null {
  const commands = shellCommandWords(command);
  if (commands.length !== 1) return null;
  const [shell = "", flag = "", script = "", ...rest] = commands[0]!;
  return SHELL_PROGRAM.test(shell) &&
    SHELL_SCRIPT_FLAG.test(flag) &&
    script.trim().length > 0 &&
    rest.length === 0
    ? script.trim()
    : null;
}

/**
 * Whether a sampled command line runs exactly `command`: it is the command (or the script of a
 * `<shell> -c` command), a `<shell> -c` wrapper whose script is one of those, or Claude's
 * `eval '<command>'`. Sampled lines are argv joined by spaces, so a wrapper's quoting is gone.
 */
function runsCommand(processCommand: string, command: string, script: string | null): boolean {
  const line = oneLine(processCommand);
  const exact = [oneLine(command), ...(script === null ? [] : [oneLine(script)])];
  if (exact.includes(line)) return true;
  const [shell = "", flag = "", ...rest] = line.split(" ");
  if (SHELL_PROGRAM.test(shell) && SHELL_SCRIPT_FLAG.test(flag) && exact.includes(rest.join(" "))) {
    return true;
  }
  // Claude escapes the command as an eval operand before passing it to Bash.
  return (
    line.includes("eval") &&
    shellCommandWords(processCommand).some(
      (words) => words[0] === "eval" && words.length === 2 && words[1]?.trim() === command,
    )
  );
}

/**
 * The one sampled process tree running `command`: the processes whose command line runs exactly
 * it (`matched`, the shell wrappers and the command itself; see `runsCommand`) and every
 * descendant (`tree`). Null when nothing matches or identical commands run in separate trees,
 * since then no tree is provably this command's.
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
  // ponytail: the server does not know provider process ids, so an item still marked running
  // after its process exited claims an identical command another thread runs; track provider
  // PIDs if that shows up in practice.
  const matched = new Set(
    [...processes.values()]
      .filter((process) => runsCommand(process.command, command, script))
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

/**
 * The processes the given commands spawned, beyond the command lines themselves, grouped by the
 * kind of program they run (`shellProgramName`): ten `python worker.py --shard N` are one
 * `python ×10` row. Largest groups first, `limit` of them.
 */
export function groupSpawnedProcesses(input: {
  readonly processes: ReadonlyArray<SampledProcess>;
  readonly serverPid: number;
  readonly commands: ReadonlyArray<{
    readonly command: string | null;
    readonly commandKind?: string;
  }>;
  readonly limit?: number;
}): {
  readonly groups: ReadonlyArray<ThreadProcessGroup>;
  readonly hiddenCount: number;
  /** Everything the commands run or spawned, each process once, before exclusions and the cap. */
  readonly usage: { readonly cpuPercent: number; readonly residentBytes: number };
} {
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
  const usage = { cpuPercent: 0, residentBytes: 0 };
  for (const pid of spawned) {
    usage.cpuPercent += byPid.get(pid)?.cpuPercent ?? 0;
    usage.residentBytes += byPid.get(pid)?.residentBytes ?? 0;
  }
  const groups = new Map<
    string,
    { count: number; cpuPercent: number; residentBytes: number; commandLine: string }
  >();
  for (const pid of spawned) {
    const process = byPid.get(pid);
    if (process === undefined || commandPids.has(pid)) continue;
    const label = shellProgramName(process.command);
    if (label === null || UNLISTED_PROGRAMS.has(label)) continue;
    const group = groups.get(label) ?? {
      count: 0,
      cpuPercent: 0,
      residentBytes: 0,
      commandLine: process.command.trim(),
    };
    group.count += 1;
    group.cpuPercent += process.cpuPercent;
    group.residentBytes += process.residentBytes;
    groups.set(label, group);
  }
  const listed = [...groups].map(([label, group]) => ({ label, ...group }));
  listed.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  const limit = input.limit ?? VISIBLE_PROCESS_GROUPS;
  return { groups: listed.slice(0, limit), hiddenCount: Math.max(0, listed.length - limit), usage };
}
