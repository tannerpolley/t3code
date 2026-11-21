import { THREAD_ROLES, THREAD_ROLE_LABELS } from "@t3tools/contracts";
import type {
  OrchestratorMcpModelNote,
  OrchestratorMcpModelRole,
  OrchestratorMcpProviderCredits,
  ProviderInteractionMode,
} from "@t3tools/contracts";

import type { ManagedIssueRole, McpOrchestrationPolicy } from "./mcpSession.ts";

const T3_CODE_NATIVE_SUBAGENT_GUIDANCE = `- Subagents: use your native tool when the child uses your provider, a model it offers and no settings beyond yours (Claude \`Agent\`, \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), or \`delegate_task\` by name. A native type on another provider's model counts too. Background agent: \`delegate_task\`, never a background \`Agent\`. Workflow only when asked.`;

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

${T3_CODE_NATIVE_SUBAGENT_GUIDANCE}
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked or fall back to native tools, Workflow or CLIs. Never make a child's checkout in the shell or in \`task\`.
- The orchestrator delegates an independent Reviewer only when the owner or plan asks. Start each review or re-check with \`delegate_task\`. Fix small findings yourself. If asked to use fewer delegates, \`task_cancel\` extras without replacing them.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start subagents only when your task or role calls for it.`,
  `- Multiple selections: use \`t3_request_user_input\`. Writers ask the owner directly through their question tool, and the owner can message their thread directly. Parents must not answer Writer questions; final results still return to the parent. Other children ask decisions through their question tool; parents read and respond with \`t3_pending_request\` with action \`read\` or \`respond\` (answers or approval decision). Approve only delegated descendants within task authority. Never message ancestors; final results return automatically.
- Inherited options apply only to the same provider and model; explicit values override, [] or {} clears. Implementors default to worktree; Writers and read-only roles share.
- Cross-project issues: \`t3_issue_post\` notifies the repository owner.
- \`t3_thread_launch\` opens a top-level thread only at the user's request. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`; shell worktrees do not bind it, and no checkout setup in its prompt. Without \`workspaceStrategy\`, the thread opens at the project root.
- Given a thread id, \`t3_thread_read\` it before you answer about it. Asked to settle a thread, this one too: \`t3_thread_organize\`.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` and that machine's \`threadId\` to T3 tools.
- Unlinked ("delegate this to my vps"): \`t3_environment_link\` with a \`hint\` from the user's words, never a pairing code in chat. No link tools: say to enable Settings → Labs → Linked environments.
- In your reply, mention a thread by its \`link\`, verbatim, never a plain title or bare id.
- A login, token, PIN, pairing code or sudo password only the user can give: call \`request_secret\`, not a chat ask or a handoff. Not for access you have. Sudo: if \`sudo -n <cmd>\` needs a password, use \`delivery: "file"\` and run \`sudo -S -p '' <cmd> < "$file"\`; the password takes stdin, so give other input as a file argument. Asked only to schedule: \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart and show any visual the user asks for here: pass an HTML file path or inline HTML to \`html_preview\`, then \`html_render\`. A screenshot on disk or a text description doesn't show it. Never start a server for it. Page tools write only on user request. Never use them to show results. Asked for an image to post, send or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` unasked to verify or show your own edit. Use them when the current request asks for browser work, including recording edits, or names a page or tab. Don't repeat preview calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

// Codex caps each additional-context entry at 4,000 UTF-8 bytes.
const MODEL_INSTRUCTIONS_MAX_BYTES = 4_000;

const MODEL_ROLES_HEADER = `

### Model roles

Read \`orchestrator_capabilities\` for current choices. Each role has two levels. Pass \`level: "routine"\` for bounded, well-specified work, evidence gathering or sanity checks. Use \`complex\` (the default) for broad changes, correctness-critical work or decisions.

Pass \`role\` and omit \`target\` to use the first choice at that level. To use another choice at the same level, pass only \`target.providerInstanceId\`. Choices below 0.8 weekly headroom are demoted, ordered by headroom. Unknown usage keeps its place and unavailable choices go last.

`;

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

function oneLine(text: string, maxBytes: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (byteLength(flat) <= maxBytes) return flat;
  let shortened = "";
  let remaining = maxBytes - byteLength("…");
  for (const character of flat) {
    remaining -= byteLength(character);
    if (remaining < 0) break;
    shortened += character;
  }
  return shortened + "…";
}

function modelChoiceLabel(
  {
    providerInstanceId,
    model,
    options,
    unavailableReason,
  }: OrchestratorMcpModelRole["targets"][number],
  compact: boolean,
) {
  const traits = options?.map((option) => option.value).join(" ");
  const modelLabel = `${model}${traits ? ` ${traits}` : ""}`;
  const label = compact ? oneLine(modelLabel, 105) : modelLabel;
  const provider = compact ? oneLine(providerInstanceId, 40) : providerInstanceId;
  return `${label} (${provider}).${
    unavailableReason === null
      ? ""
      : compact
        ? " Unavailable."
        : ` Unavailable: ${oneLine(unavailableReason, 200)}`
  }`;
}

export function t3ModelRolesInstructions(
  roles: ReadonlyArray<OrchestratorMcpModelRole>,
  providerCredits: ReadonlyArray<OrchestratorMcpProviderCredits> = [],
): string {
  if (roles.length === 0) return "";
  const creditLines = providerCredits.map(
    ({ providerInstanceId, approved, resetCreditCount, balance, extraUsageRemainingPercent }) =>
      [
        `${providerInstanceId} credits ${approved ? "approved" : "require approval"}.`,
        resetCreditCount === undefined ? "" : `Banked resets: ${resetCreditCount}.`,
        balance === undefined ? "" : `Balance: ${oneLine(balance, 48)}.`,
        extraUsageRemainingPercent === undefined
          ? ""
          : `Extra usage: ${extraUsageRemainingPercent}% left.`,
      ]
        .filter(Boolean)
        .join(" "),
  );
  const credits =
    creditLines.length === 0
      ? ""
      : `Approved credits keep a choice in its usual order even when weekly usage is low. In that case, use the provider without asking. Ask if the role's choice is unavailable. ${creditLines.join(" ")}\n\n`;
  const header = MODEL_ROLES_HEADER + credits;
  const byRole = THREAD_ROLES.map((role) => ({
    role,
    levels: roles.filter((entry) => entry.role === role),
  })).filter(({ levels }) => levels.length > 0);
  const lines = (mode: "full" | "first" | "compact") =>
    byRole
      .map(({ role, levels }) => {
        const summaries = levels.map(({ level, description, targets }) => {
          const choices =
            mode === "full"
              ? targets.map((target) => modelChoiceLabel(target, false)).join(" or ")
              : modelChoiceLabel(targets[0], mode === "compact");
          const detail = mode === "full" && description ? `${oneLine(description, 600)} → ` : "";
          return `${level ?? "complex"}: ${detail}${choices}`;
        });
        return `- ${THREAD_ROLE_LABELS[role]} (${role}): ${summaries.join(" | ")}`;
      })
      .join("\n");

  const usage = new Map<string, string>();
  for (const role of roles) {
    for (const { providerInstanceId, model, weeklyUsage } of role.targets) {
      if (weeklyUsage === undefined) continue;
      const label = `${model} (${providerInstanceId})`;
      usage.set(
        label,
        `${label}: ${weeklyUsage.remainingPercent}% left, resets ${weeklyUsage.resetsAt ?? "unknown"}, pace ${weeklyUsage.pace ?? "unknown"}`,
      );
    }
  }
  const weekly = usage.size === 0 ? "" : `\n\nWeekly usage\n${[...usage.values()].join("\n")}`;
  const full = `${header}${lines("full")}${weekly}\n`;
  if (byteLength(full) <= MODEL_INSTRUCTIONS_MAX_BYTES) return full;
  const firstChoices = `${header}${lines("first")}${weekly}\n`;
  if (byteLength(firstChoices) <= MODEL_INSTRUCTIONS_MAX_BYTES) return firstChoices;
  return `${header}${lines("compact")}\nSee orchestrator_capabilities for full choices and weekly usage.\n`;
}

export function t3ModelNotesInstructions(notes: ReadonlyArray<OrchestratorMcpModelNote>): string {
  if (notes.length === 0) return "";
  const header =
    "\n\n### Model notes\n\nThe owner's notes on each model. Weigh them when you pick a role or ask the owner for a model outside a role.\n\n";
  const lines = notes.map(({ model, note }) => `- ${model}: ${note.replace(/\s+/g, " ").trim()}`);
  const full = lines.join("\n");
  const budget = MODEL_INSTRUCTIONS_MAX_BYTES - byteLength(header) - notes.length;
  return (
    header +
    (byteLength(full) <= budget
      ? full
      : lines.map((line) => oneLine(line, Math.floor(budget / notes.length))).join("\n"))
  );
}

/** The one place a managed role decides a session's instructions and native subagents. */
export function t3OrchestrationPolicy(
  managedIssue: ManagedIssueRole | undefined,
  modelRoles: string,
  modelNotes = "",
): McpOrchestrationPolicy {
  return {
    sections: t3OrchestrationSections(managedIssue),
    modelRoles,
    modelNotes,
    // The repository root keeps native subagents for its own work between orchestration runs.
    nativeSubagents: managedIssue === undefined || managedIssue === "root",
  };
}

/** Orchestration instructions as one block, followed by the user's model roles. */
export function t3OrchestrationText(policy: McpOrchestrationPolicy | undefined): string {
  return policy === undefined
    ? T3_CODE_ORCHESTRATION_INSTRUCTIONS
    : `\n\n${policy.sections.join("\n\n")}\n${policy.modelRoles}${policy.modelNotes}`;
}

/** Managed issue work has one durable delegation path, including same-provider children. */
export function t3OrchestrationBaseInstructions(managedIssue?: ManagedIssueRole): string {
  if (managedIssue === undefined) return T3_CODE_ORCHESTRATION_INSTRUCTIONS;
  const delegation =
    managedIssue === "worker"
      ? "Native subagent tools are disabled in this repository-managed session. Delegate children through `delegate_task`."
      : managedIssue === "implementor"
        ? 'Native subagents are disabled. After checks pass and the draft PR is pushed, use `delegate_task` with `role: "reviewer"`, `mode: "async"` and shared isolation. Ask this read-only child to review the issue, plan and diff without sharing your conclusions. Tell it to leave the code untouched. End the turn while it reviews. T3 returns its result to you. Fix real defects, record why you dismissed other findings, and re-review only after material changes. Ask through the question tool before a third fix round. Report upward when the PR is merge-ready with each finding’s disposition and reason.'
        : "As the repository orchestrator, delegate code to an Implementor and deliverables to a Writer. Leave the review loop with the Implementor. Manage merges, builds, work ordering and owner decisions. Use native subagent tools only for your own work while no issue workers run, when they support the model and options. Delegate issue work through `delegate_task`.";
  return `Keep issues current through propose_issue_change with a typed operation and a stable clientRequestId on retries. Create, split into native sub-issues, and milestone moves execute automatically unless the user enabled approval for issue upkeep. Follow the decision returned for each proposal. Body edits and close/reopen always wait for the user's durable in-app approval of the exact preview; standalone parent and blocked_by add/remove changes execute automatically unless the thread is in approval-required mode. The tool returns the change reference, decision, completed steps and result. Agents cannot approve changes, and question answers never approve a mutation. A stale baseline needs a new proposal and preview. An uncertain create that needs attention requires the user to check GitHub and mark it resolved; never submit another create just because its marker is missing. T3 tracks its written bodies by exact baseline, never GitHub author login. Labels and assignees are outside this tool's scope.\n\n${T3_CODE_ORCHESTRATION_INSTRUCTIONS.replace(
    T3_CODE_NATIVE_SUBAGENT_GUIDANCE,
    delegation +
      '\n\n- Use Designer before implementation when a request needs research or a plan; it writes the problem, findings, plan, strategy decisions and done criteria through issue tools, then returns a short result without editing code. Managed implementors require an `issue` argument and `mode="async"`. Read-only roles (`designer`, `reviewer`) use ordinary delegation: no issue claim or worker slot, a separate read-only limit (default 4) across the repository lineage, shared isolation by default, and an optional `issue` only links visibility. Finish your turn while T3 children work; deliver upward only in your final result. T3 publishes the managed status and closeout comments automatically; put evidence and remaining gates in your final result instead of publishing duplicate lifecycle comments. Run heavy checks through `agent-heavy`. The repository has one root orchestrator and an adjustable worker limit shared across its entire issue tree; queued workers wait for capacity, including resumes and result follow-ups. Use `get_repository_orchestration` to see both limits, slots in use for each pool, selected milestones and pause state. When planned parallel work exceeds a pool limit or children queue on a full pool, ask the owner with the question tool to approve a recommended limit, naming the pool, current and proposed limits and reason; on refusal continue within the limit, and after the burst you may offer to lower it; only the root can apply an approved change with `set_repository_worker_limit` and the current revision, while non-root owners ask the owner to use repository controls or the root to apply it; an explicit request for that size of work authorizes the change. Excess read-only requests queue in request order, including restart continuations. The root owns only top-level issues. An issue owner delegates only its immediate GitHub sub-issues. When an outside blocker prevents a managed implementor or issue owner from continuing, use propose_issue_change to create an issue describing the blocker, then add blocked_by with number set to the blocked issue and blockerNumber to the new issue; follow returned decisions and end with a final result naming the blocker. Do not do this for owner questions the question tool can answer or failing tests within the issue scope. Read native blockers and hierarchy before delegating; unreadable or partial relationships are unknown eligibility. Milestone work starts through `work_through_milestone`; T3 wakes owners on final results and newly eligible work. Use async delegation and end the turn while children run. A worker waiting for user input keeps its slot; an owner waiting on children after its turn ends frees its slot. Completed implementors with open PRs hold no slot. The repository root can use `close_out_issue_attempt` to finish a closed issue attempt once its remaining work is cancelled or finished. Ask before expanding the approved milestone or repository scope. Pause/resume through `set_repository_work_paused`. Do not poll task_status or create recurring user schedules to advance a milestone.\n',
  ).replace(
    T3_CODE_ORCHESTRATION_SECTIONS[1]!,
    managedIssue === "root"
      ? "- Answer status questions with `repository_status`. When T3 reports a child finished, blocked, or failed, post a one-line update to the owner.\n\n" +
          T3_CODE_ORCHESTRATION_SECTIONS[1]!
      : T3_CODE_ORCHESTRATION_SECTIONS[1]!,
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

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

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
  readonly hasDeviceTools: boolean;
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
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
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
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  if (!input.orchestrationDelivered) {
    return prependT3OrchestrationInstructions(
      input.prompt,
      orchestrationInstructions(input.hasDeviceTools),
    );
  }
  return input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependT3OrchestrationInstructions(input.prompt, T3_CODE_DEVICE_TOOL_INSTRUCTIONS)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}
