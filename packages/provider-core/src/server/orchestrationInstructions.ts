import type { OrchestratorMcpModelRole, ProviderInteractionMode } from "@t3tools/contracts";

import type { ManagedIssueRole } from "./mcpSession.ts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: use your native tool when the child uses your provider, a model it offers, and no settings beyond yours, and you wait in this turn (Claude \`Agent\` always with \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), background work, or \`delegate_task\` by name. A native type running another provider's model counts too. Workflow only when asked.
- Before \`delegate_task\`, call \`orchestrator_capabilities\` once. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, \`task_cancel\` it. Start no replacement.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- Multiple selections: use \`t3_request_user_input\`. Children ask decisions through their question tool; parents read and respond with \`t3_pending_request_read\` and \`t3_pending_request_respond\` (answers or approval decision). Approve only delegated descendants within task authority. Never message ancestors; final results return automatically.
- Inherited options apply only to the same provider and model; explicit values override, [] or {} clears. Implementors default to worktree; read-only roles share.
- Cross-project issues: \`t3_issue_post\` notifies the repository owner.
- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`; shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it.
- In your reply, a thread's first mention is its \`link\` verbatim. No \`link\`: \`[title](t3-thread://v1/<exact id>)\`. Never a plain title or bare id.
- A secret: call \`request_secret\` yourself. Pass its \`secretRef\` to a T3 tool, or use \`delivery: "file"\` for a shell command. Never ask in chat or invent one. When asked only to schedule, \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Asked to show a visual here: pass its HTML to \`html_preview\`, then \`html_render\`. If the visual is a file, pass that file's HTML. A screenshot on disk or a text description does not show it. Never start a server for it. Tools a web page exposes give data only. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` to verify or show your own edit, even a frontend edit or an open tab. Do not repeat preview calls from an earlier turn. Use them only when the current request asks for browser work or names a page or tab. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

/** Upper bound on the model roles block, which providers deliver with their orchestration instructions. */
export const MAX_MODEL_ROLES_INSTRUCTIONS_LENGTH = 6_000;

const MODEL_ROLES_HEADER = `

### Model roles

The user can switch worker providers (All Claude / Mixed / All Codex) at any time, so read \`orchestrator_capabilities\` before choosing a worker model because its roles are current.

The user's choices for delegated work follow configured order, with the Default first. Choices with weekly headroom below 0.8 are demoted behind the others, ordered by headroom. Unknown usage is not demoted, and unavailable targets go last. You may override this order for task fit; explicit user instructions win. Weekly usage shows quota left, reset time, and pace against elapsed window time when reported. Pass a choice's Target JSON as \`delegate_task\`'s \`target\` (not its \`role\` field); \`orchestrator_capabilities\` lists all choices and their availability again.

`;

const oneLine = (text: string, maxLength: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
};

function modelRoleLine(role: OrchestratorMcpModelRole, maxLength: number): string {
  const description = oneLine(role.description, 200);
  const head = `- ${oneLine(role.name, 60)}${role.role ? ` (role: ${role.role})` : ""}${description.length > 0 ? `: ${description}` : ""}.`;
  const choices = role.targets.map(
    ({ providerInstanceId, model, options, unavailableReason, weeklyUsage }) => {
      const traits = options?.map((option) => oneLine(String(option.value), 60)).join(" ");
      const label = `${oneLine(model, 100)}${traits ? ` ${traits}` : ""} (${providerInstanceId})`;
      const usage = weeklyUsage
        ? ` Weekly usage: ${weeklyUsage.remainingPercent}% left; resets ${weeklyUsage.resetsAt ?? "unknown"}; pace ${weeklyUsage.pace ?? "unknown"}.`
        : "";
      if (unavailableReason !== null) {
        return `${label}.${usage} Unavailable: ${oneLine(unavailableReason, 200)}`;
      }
      const target = {
        providerInstanceId,
        model,
        ...(options === undefined || options.length === 0
          ? {}
          : { options: Object.fromEntries(options.map((option) => [option.id, option.value])) }),
      };
      return `${label}.${usage} Target JSON: \`${JSON.stringify(target)}\``;
    },
  );
  const full = `${head} ${choices.join(" or ")}`;
  if (full.length <= maxLength) return full;
  const suffix = " More choices: call `orchestrator_capabilities`.";
  let line = oneLine(head, maxLength - suffix.length);
  for (const choice of choices) {
    const next = `${line} ${choice}`;
    if (next.length + suffix.length > maxLength) break;
    line = next;
  }
  return line + suffix;
}

/** Budget model-role lines without cutting target JSON or omitting a role. */
export function t3ModelRolesInstructions(roles: ReadonlyArray<OrchestratorMcpModelRole>): string {
  if (roles.length === 0) return "";
  const budget = MAX_MODEL_ROLES_INSTRUCTIONS_LENGTH - MODEL_ROLES_HEADER.length - roles.length - 1;
  const full = roles.map((role) => modelRoleLine(role, Number.POSITIVE_INFINITY));
  const perRole = Math.floor(budget / roles.length);
  const lines =
    full.join("\n").length <= budget ? full : roles.map((role) => modelRoleLine(role, perRole));
  return `${MODEL_ROLES_HEADER}${lines.join("\n")}\n`;
}

/** Orchestration instructions followed by the user's model roles. */
export function t3OrchestrationInstructions(
  roles: ReadonlyArray<OrchestratorMcpModelRole> = [],
  managedIssue?: ManagedIssueRole,
): string {
  return `${t3OrchestrationBaseInstructions(managedIssue)}${t3ModelRolesInstructions(roles)}`;
}

/** Managed issue work has one durable delegation path, including same-provider children. */
export function t3OrchestrationBaseInstructions(managedIssue?: ManagedIssueRole): string {
  if (managedIssue === undefined) return T3_CODE_ORCHESTRATION_INSTRUCTIONS;
  const nativeSubagents =
    managedIssue === "worker"
      ? "Native subagent tools are disabled in this repository-managed session. Delegate children through `delegate_task`."
      : "As the repository orchestrator, use native subagent tools only for your own work while no issue workers run, and only when they support the chosen model and no model options are requested or inherited. Delegate issue work through `delegate_task`.";
  return `Keep issues current through propose_issue_change with a typed operation and a stable clientRequestId on retries. Create, split into native sub-issues, and milestone moves execute automatically unless the user enabled approval for issue upkeep. Follow the decision returned for each proposal. Body edits and close/reopen always wait for the user's durable in-app approval of the exact preview; standalone parent changes also ask. The tool returns the change reference, decision, completed steps and result. Agents cannot approve changes, and question answers never approve a mutation. A stale baseline needs a new proposal and preview. An uncertain create that needs attention requires the user to check GitHub and mark it resolved; never submit another create just because its marker is missing. T3 tracks its written bodies by exact baseline, never GitHub author login. Labels and assignees are outside this tool's scope.\n\n${T3_CODE_ORCHESTRATION_INSTRUCTIONS.replace(
    T3_CODE_ORCHESTRATION_SECTIONS[0]!.slice(
      T3_CODE_ORCHESTRATION_SECTIONS[0]!.indexOf("- Subagents:"),
      T3_CODE_ORCHESTRATION_SECTIONS[0]!.indexOf("\n- Before"),
    ),
    nativeSubagents +
      ' Managed implementors require an `issue` argument and `mode="async"`. Read-only roles (`checker`, `reviewer`, `investigator`) use ordinary delegation: no issue claim or worker slot, a separate read-only limit (default 4) across the repository lineage, shared isolation by default, and an optional `issue` only links visibility. Finish your turn while children work; deliver upward only in your final result. T3 publishes the managed status and closeout comments automatically; put evidence and remaining gates in your final result instead of publishing duplicate lifecycle comments. Run heavy checks through `agent-heavy`. The repository has one root orchestrator and an adjustable worker limit shared across its entire issue tree; queued workers wait for capacity, including resumes and result follow-ups. Use `get_repository_orchestration` to see both limits, slots in use for each pool, selected milestones and pause state. The root can change either limit with `set_repository_worker_limit`, passing `workerLimit` or `readOnlyLimit` and the current revision. Excess read-only requests queue in request order, including restart continuations. The root owns only top-level issues. An issue owner delegates only its immediate GitHub sub-issues. Read native blockers and hierarchy before delegating; unreadable or partial relationships are unknown eligibility. Milestone work starts through `work_through_milestone`; T3 wakes owners on final results and newly eligible work. Use async delegation and end the turn while children run. A worker waiting for user input keeps its slot; an owner waiting on children after its turn ends frees its slot. Completed implementors with open PRs hold no slot. The repository root can use `close_out_issue_attempt` to finish a closed issue attempt once its remaining work is cancelled or finished. Ask before expanding the approved milestone or repository scope. Pause/resume through `set_repository_work_paused`. Do not poll task_status or create recurring user schedules to advance a milestone.',
  )}`;
}

/** Keep Codex's capped context entries while reusing the managed-issue wording above. */
export function t3OrchestrationSections(managedIssue?: ManagedIssueRole): ReadonlyArray<string> {
  if (managedIssue === undefined) return T3_CODE_ORCHESTRATION_SECTIONS;
  const instructions = t3OrchestrationBaseInstructions(managedIssue);
  const firstSectionStart = instructions.indexOf("## T3 Code orchestration");
  const secondSectionStart = instructions.indexOf(
    T3_CODE_ORCHESTRATION_SECTIONS[1]!,
    firstSectionStart,
  );
  const managedIssueSection = instructions
    .slice(firstSectionStart, secondSectionStart)
    .trim()
    .split(/\n\n(?=- )/);
  return [
    instructions.slice(0, firstSectionStart).trim(),
    ...managedIssueSection,
    ...T3_CODE_ORCHESTRATION_SECTIONS.slice(1),
  ];
}

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

function prependT3OrchestrationInstructions(prompt: string): string {
  return `<t3_code_orchestration_instructions>${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
