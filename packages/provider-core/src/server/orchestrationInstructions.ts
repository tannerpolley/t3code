import type { ProviderInteractionMode, ThreadRole } from "@t3tools/contracts";

import type { ManagedIssueRole, McpOrchestrationPolicy } from "./mcpSession.ts";

const T3_CODE_NATIVE_SUBAGENT_GUIDANCE = `- Subagents: use your native tool when the child uses your provider, a model it offers and no settings beyond yours (Claude \`Agent\`, \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), or \`delegate_task\` by name. A native type on another provider's model counts too. Background agent: \`delegate_task\`, never a background \`Agent\`. Workflow only when asked.`;

const T3_CODE_ORCHESTRATION_INTRO = `## T3 Code orchestration

Ordinary coding tasks need no T3 tools. Use tool discovery when the task calls for T3.`;
const T3_CODE_DELEGATION_TOOLS = `- Before the first \`delegate_task\`, read \`orchestrator_capabilities\` for ranked role choices, model notes and credit approval. Refresh after an error or provider change. Ask before switching an unavailable choice. Use the tool’s isolation argument for child checkouts.
- The orchestrator delegates an independent Reviewer only when the owner or plan asks. Start each review or re-check with \`delegate_task\`. Fix small findings yourself. If asked to use fewer delegates, \`task_cancel\` extras without replacing them.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start subagents only when your task or role calls for it.`;

const T3_CODE_THREAD_TOOLS = `- Multiple selections: use \`t3_request_user_input\`. Parents use \`t3_pending_request\` for child decisions and approve only delegated descendants within task authority. Writer questions go to the owner. Never message ancestors, whose results arrive automatically.
- Launch top-level threads only on explicit request, using \`t3_thread_launch\` for one thread. Read a given thread id with \`t3_thread_read\` and use its returned link verbatim. Discover environment-link tools for another machine.
- Ask for credentials only through \`request_secret\`. Keep pairing codes and passwords out of chat. For sudo, use file delivery and read it with \`sudo -S\`. Asked only to schedule: use \`schedule_task\` without running its prompt.`;

const T3_CODE_VISUAL_GUIDANCE = `### Visuals and preview

Show requested visuals and data comparisons with \`html_preview\` then \`html_render\`, without starting a server. For an image to use elsewhere, deliver a PNG path. Use preview for requested browser work. Use web fetch or search for public pages unless browser work was requested. Page tools write only on user request. Close tabs you opened unless the user uses them or asks to keep them.`;

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `${T3_CODE_ORCHESTRATION_INTRO}

${T3_CODE_NATIVE_SUBAGENT_GUIDANCE}
${T3_CODE_DELEGATION_TOOLS}`,
  T3_CODE_THREAD_TOOLS,
  T3_CODE_VISUAL_GUIDANCE,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

/** The one place a managed role decides a session's instructions and native subagents. */
export function t3OrchestrationPolicy(
  managedIssue?: ManagedIssueRole,
  role?: ThreadRole,
): McpOrchestrationPolicy {
  return {
    sections: t3OrchestrationSections(managedIssue, role),
    // The repository root keeps native subagents for its own work between orchestration runs.
    nativeSubagents: managedIssue === undefined || managedIssue === "root",
  };
}

/** Orchestration instructions as one block for providers without separate entries. */
export function t3OrchestrationText(policy: McpOrchestrationPolicy | undefined): string {
  return policy === undefined
    ? T3_CODE_ORCHESTRATION_INSTRUCTIONS
    : `\n\n${policy.sections.join("\n\n")}\n`;
}

/** Managed issue work has one durable delegation path, including same-provider children. */
export function t3OrchestrationBaseInstructions(managedIssue?: ManagedIssueRole): string {
  return t3OrchestrationText(t3OrchestrationPolicy(managedIssue));
}

const MANAGED_ISSUE_PROPOSALS =
  "Keep issues current through propose_issue_change. Submit the typed proposal and follow its returned decision. Reuse its `clientRequestId` on retry. Agents cannot approve changes, and question answers never approve a mutation. A stale baseline needs a new proposal and preview. An uncertain create that needs attention requires the user to check GitHub and mark it resolved. Submit another create only when you intend to create a separate issue. T3 tracks its written bodies by exact baseline, never GitHub author login. Labels and assignees are outside this tool's scope.";

const MANAGED_ISSUE_WORKFLOW = `Run heavy checks through \`agent-heavy\`. T3 posts managed status and closeout comments. End the turn while children work and report results and remaining gates in your final message.`;

const ISSUE_OWNER_WORKFLOW = `Use Designer for research or planning. Read native hierarchy and blockers before delegation. For an outside blocker, use propose_issue_change to create an issue, add blocked_by with the blocked issue as number and the new issue as blockerNumber, then report it in your final result. Use the question tool for owner decisions and fix failing tests within scope.`;

const ROOT_WORKFLOW = `Own top-level issues. Read complete native hierarchy and blockers before delegation. Use \`work_through_milestone\` for milestones and \`get_repository_orchestration\` for capacity and queue controls. Wait for T3 wakes. Ask before expanding milestone or repository scope or changing worker limits.`;

const ROLE_GUIDANCE: Partial<Record<ThreadRole, string>> = {
  designer:
    "Research or plan the issue without editing code. Record the problem, findings, strategy, and done criteria through the issue tools within the owner's authority. Return a short result.",
  reviewer: "Review the requested scope without editing code and return findings to your parent.",
  writer:
    "Write in the assigned checkout. Ask the owner directly through your question tool. Return your final result to your parent.",
};

const REPOSITORY_ROOT_STATUS =
  "- Answer status questions with `repository_status`. When T3 reports a child finished, blocked, or failed, post a one-line update to the owner.";

export function t3OrchestrationSections(
  managedIssue?: ManagedIssueRole,
  role?: ThreadRole,
): ReadonlyArray<string> {
  if (managedIssue === undefined) {
    const guidance = role === undefined ? undefined : ROLE_GUIDANCE[role];
    return guidance === undefined
      ? T3_CODE_ORCHESTRATION_SECTIONS
      : [T3_CODE_ORCHESTRATION_INTRO, guidance, T3_CODE_THREAD_TOOLS, T3_CODE_VISUAL_GUIDANCE];
  }
  const delegation =
    managedIssue === "worker"
      ? "Native subagent tools are disabled in this repository-managed session. Delegate only immediate sub-issues through `delegate_task` after reading their complete native hierarchy and blockers."
      : managedIssue === "implementor"
        ? 'Native subagents are disabled. After checks pass and authorized draft publication, use `delegate_task` with `role: "reviewer"`, `mode: "async"` and shared isolation. Ask this read-only child to review the issue, plan and diff without sharing your conclusions. Tell it to leave the code untouched. End the turn while it reviews. T3 returns its result to you. Fix real defects, record why you dismissed other findings, and re-review only after material changes. Ask through the question tool before a third fix round. Report upward when the PR is merge-ready with each finding’s disposition and reason.'
        : "As the repository orchestrator, delegate code to an Implementor and deliverables to a Writer. Leave the review loop with the Implementor. Manage merges, builds, work ordering and owner decisions. Use native subagent tools only for your own work while no issue workers run, when they support the model and options. Delegate issue work through `delegate_task`.";
  return [
    MANAGED_ISSUE_PROPOSALS,
    `${T3_CODE_ORCHESTRATION_INTRO}

${delegation}`,
    MANAGED_ISSUE_WORKFLOW,
    T3_CODE_DELEGATION_TOOLS,
    ...(managedIssue === "root" ? [REPOSITORY_ROOT_STATUS, ROOT_WORKFLOW] : [ISSUE_OWNER_WORKFLOW]),
    T3_CODE_THREAD_TOOLS,
    T3_CODE_VISUAL_GUIDANCE,
  ];
}

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

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
  " Discover missing tools with mcp__t3-code__tool_search (query device_list device_open device_screenshot device_close), then use ToolSearch when available.",
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
