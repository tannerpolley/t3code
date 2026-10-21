import type { OrchestratorMcpModelRole, ProviderInteractionMode } from "@t3tools/contracts";

/**
 * Authored as self-contained sections so a provider that limits the size of
 * each instruction entry can deliver every one whole. Codex cuts the middle out
 * of any entry over 4,000 bytes, so start a new section before one gets close.
 */
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

The \`t3-code\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

For questions that need multiple selections, use \`t3_request_user_input\` when available because Codex's native \`request_user_input\` only supports single selection; otherwise use a native tool that supports multiple selections or ask separate single-selection questions.

App-owned delegated children send all questions and permission approvals to their parent orchestrator first, including native question tools. As a child, ask your orchestrator through your question tool; do not message ancestors. As the parent, use \`t3_pending_request_read\` for the full request and \`t3_pending_request_respond\` with the child threadId and requestId: pass \`answers\` for questions or \`decision: "accept"\` / \`"decline"\` for approvals. You may approve only your delegated descendants. A blocking delegation's legacy \`waitingOnUser\` result means waiting on you. Answer from the task's authority, or ask the owner with your own question tool and relay their answer. This routing applies recursively when you are also a delegated child.

- A delegated task/subagent is child work owned by the current thread. Use \`orchestrator_capabilities\` to discover the current provider/model IDs from the same live catalog as the composer, including configured custom models. Do not treat a native tool's model list as the full list of available subagent models. Prefer native subagent tools for same-provider work only when they support the chosen model and no model options are requested or inherited. Use \`delegate_task\` with that provider instance and model when native tools cannot, including for same-provider work. Also use \`delegate_task\` for cross-provider or explicitly T3-owned child tasks. For a child task that needs a separate checkout, use \`delegate_task\` with \`isolation:"worktree"\` across any provider or model. It starts from the parent local commit and runs project setup; uncommitted edits are not copied. Implementor children default to it; pass \`isolation:"shared"\` to keep one in this checkout. Retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it. The returned \`childThreadId\` is backing storage for the subagent, not the target for starting another delegated review round.

- \`t3_thread_launch\` and \`create_threads\` create ordinary top-level T3 conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work.
- For every T3 delegated review round, call \`delegate_task\` again. Include the original brief, prior findings, responses, and unresolved objections in each new task prompt. Track each round by its own \`taskId\`. Use a distinct \`clientRequestId\` per round, stable across retries of that round. Do not use \`t3_thread_send\` on \`childThreadId\` to continue a delegated review.`,
  `- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule, or \`{"type":"webhook"}\` to run on each request to the returned \`webhookUrl\` (the run sees the request only through \`{{body.path}}\`-style placeholders in the prompt). By default runs return to the current thread, which suits orchestrating: each trigger arrives here and you delegate or dedupe; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling a timer, report the returned cadence and next run time; for a webhook, report its \`webhookUrl\`, or say T3 Connect remote access is needed if it is missing.
- When you need a secret from the user (a token, API key, or webhook signing secret), call \`request_secret\` so they enter it privately, then pass the returned \`secretRef\` to the tool that needs it, e.g. \`signature.secretRef\` on a webhook task for a sender that signs requests such as GitHub. A \`secretRef\` works once. Never ask for a secret in chat, never invent one, and never repeat one.
- To create or comment on an issue in another project's GitHub repository, use \`t3_issue_post\` instead of raw \`gh\`: it marks and labels the write so that repository's orchestrator is notified.
- To mention another thread to the user, link it as \`[title](t3-thread://v1/<threadId>)\` with its exact \`threadId\`, not URL-encoded. T3 Code opens the thread in the app and shows its current title.`,
  `### Choose the workspace before starting a new thread


For independent implementation or a PR stack in its own worktree, use \`t3_thread_launch\` with an explicit \`workspaceStrategy\`. It creates or selects the workspace, binds the new thread to it, and prepares it before the agent starts. Put the task in \`message\`, not \`prompt\`:

- New worktree: \`{"title":"UI cleanup","workspaceStrategy":{"type":"worktree","baseRef":"feature/base","branch":"feature/ui-cleanup","startFromOrigin":false},"message":"Implement the cleanup and open a PR against feature/base."}\`
- Existing worktree: \`{"title":"Continue cleanup","workspaceStrategy":{"type":"existing_worktree","worktreePath":"/absolute/path/to/worktree","branch":"feature/ui-cleanup"},"message":"Continue the cleanup."}\`
- Project's main checkout: \`workspaceStrategy:{"type":"root"}\`. Omitting workspaceStrategy also selects root; it does not inherit the caller's worktree.

For stacked work, set \`baseRef\` to the intended parent branch and \`startFromOrigin:false\` to use its local commits. Use \`startFromOrigin:true\` when you intend to fetch the base branch's remote and start from it. Uncommitted edits are not copied. Use \`t3_worktree_list\` to discover existing checkout paths. Project, model selection, and modes inherit unless supplied; a launched thread may not run with broader modes than yours.

\`t3_thread_launch\` is the single-thread launch tool. Use \`create_threads\` only for a batch of threads intentionally sharing the caller's checkout: it always inherits the caller's project, branch, and worktree and has no workspace override. Asking an agent to run \`git worktree add\` or \`cd\` in its prompt does not update T3's thread binding. Select the workspace in the launch call instead. \`t3_worktree_handoff\` moves the calling thread, not another thread, and cannot move a thread already attached to a worktree.

\`t3_thread_launch\` has no idempotency key. Retain its returned threadId and inspect it with \`t3_thread_read\` / \`t3_thread_wait\`; preparation can still be running after acceptance. If a launch fails or its response is lost, inspect \`t3_thread_list\` before retrying, since a thread may already exist.`,
  `Tool names may include a harness-normalized MCP prefix, such as \`mcp__t3_code__delegate_task\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show T3 tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt using the known T3 tool name on the next tool step. In Codex code mode, for example, call \`tools.mcp__t3_code__orchestrator_capabilities({})\` before reporting that the capability is absent. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying tools that accept them.

ACP fallback: some ACP agents accept the injected MCP server but fail to expose its tools. When the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset when T3 runs as a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.

### Showing visuals

When a chart, table, diagram, image collage, or mockup would say more than prose, build a self-contained HTML page, check it with \`html_preview\`, then publish it with \`html_render\` before your final reply. The reader sees the page above that reply, so don't announce or restate it; add only what it doesn't say.`,
  `- When model options are requested or the child keeps the parent's provider instance and model with nonempty \`inheritedOptions\` from \`orchestrator_capabilities\`, use \`delegate_task\` even for native-supported models. Native subagents cannot reliably apply T3 model options. Read the selected model's descriptors from \`orchestrator_capabilities\` and put settings in \`target.options\`, not only in the prompt. Claude commonly uses {"effort":"max","fastMode":true}; Codex uses {"reasoningEffort":"max","serviceTier":"priority"}. Do not translate max to high or ignore unsupported settings: report a capability mismatch. Options inherit only for the same provider instance and model; explicit entries override individual values, and [] or {} clears them. Check the returned providerInstanceId, model, and options against the requested selection.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

/** Upper bound on the model roles block, which is sent with every turn. */
export const MAX_MODEL_ROLES_INSTRUCTIONS_LENGTH = 6_000;

const MODEL_ROLES_HEADER = `

### Model roles

The user's choices for delegated work are equal alternatives, ordered by current weekly headroom, with more quota left relative to time remaining first. You may override this order for task fit; explicit user instructions win. Unknown usage keeps the configured order after known choices, and unavailable targets go last. Weekly usage shows quota left, reset time, and pace against elapsed window time when reported. Pass a choice's Target JSON as \`delegate_task\`'s \`target\` (not its \`role\` field); \`orchestrator_capabilities\` lists all choices and their availability again.

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

/**
 * The user's model roles as one line each: name, when to use it, and
 * exact `delegate_task` targets, or why choices are unavailable. Only when the
 * full list exceeds the budget does each role get an equal share; long
 * descriptions and choices are then shortened without cutting a Target JSON
 * value or dropping a role entirely.
 */
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
  managedIssue = false,
): string {
  return `${t3OrchestrationBaseInstructions(managedIssue)}${t3ModelRolesInstructions(roles)}`;
}

/** Managed issue work has one durable delegation path, including same-provider children. */
export function t3OrchestrationBaseInstructions(managedIssue = false): string {
  if (!managedIssue) return T3_CODE_ORCHESTRATION_INSTRUCTIONS;
  return `Keep issues current through propose_issue_change with a typed operation and a stable clientRequestId on retries. Create, split into native sub-issues, and milestone moves execute automatically unless the user enabled approval for issue upkeep. Follow the decision returned for each proposal. Body edits and close/reopen always wait for the user's durable in-app approval of the exact preview; standalone parent changes also ask. The tool returns the change reference, decision, completed steps and result. Agents cannot approve changes, and question answers never approve a mutation. A stale baseline needs a new proposal and preview. An uncertain create that needs attention requires the user to check GitHub and mark it resolved; never submit another create just because its marker is missing. T3 tracks its written bodies by exact baseline, never GitHub author login. Labels and assignees are outside this tool's scope.\n\n${T3_CODE_ORCHESTRATION_INSTRUCTIONS.replace(
    "Prefer native subagent tools for same-provider work only when they support the chosen model and no model options are requested or inherited.",
    'Native subagent tools are disabled in this repository-managed session. Delegate children through `delegate_task`. Managed implementors require an `issue` argument and `mode="async"`. Read-only roles (`checker`, `reviewer`, `investigator`) use ordinary delegation: no issue claim or worker slot, shared isolation by default, and an optional `issue` only links visibility. Finish your turn while children work; deliver upward only in your final result. T3 publishes the managed status and closeout comments automatically; put evidence and remaining gates in your final result instead of publishing duplicate lifecycle comments. Run heavy checks through `agent-heavy`. The repository has one root orchestrator and an adjustable worker limit shared across its entire issue tree; queued workers wait for capacity, including resumes and result follow-ups. Use `get_repository_orchestration` to see the worker limit, slots in use, selected milestones and pause state. The root can change the limit with `set_repository_worker_limit`. The root owns only top-level issues. An issue owner delegates only its immediate GitHub sub-issues. Read native blockers and hierarchy before delegating; unreadable or partial relationships are unknown eligibility. Milestone work starts through `work_through_milestone`; T3 wakes owners on final results and newly eligible work. Use async delegation and end the turn while children run. A worker waiting for user input keeps its slot; an owner waiting on children after its turn ends frees its slot. Completed implementors with open PRs hold no slot. The repository root can use `close_out_issue_attempt` to finish a closed issue attempt once its remaining work is cancelled or finished. Ask before expanding the approved milestone or repository scope. Pause/resume through `set_repository_work_paused`. Do not poll task_status or create recurring user schedules to advance a milestone.',
  )}`;
}

/** Keep Codex's capped context entries while reusing the managed-issue wording above. */
export function t3OrchestrationSections(managedIssue = false): ReadonlyArray<string> {
  if (!managedIssue) return T3_CODE_ORCHESTRATION_SECTIONS;
  const instructions = t3OrchestrationBaseInstructions(true);
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

## T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

\`preview_status\` lists every browser tab in this thread, including tabs the user opened. When the user asks about "this page" or a page they have open, read their tab: pass its \`tabId\` to \`preview_snapshot\` or \`preview_wait_for\`, or omit \`tabId\` when you have no tab of your own. You may act on the user's tab, including \`preview_evaluate\`, only while its owner is \`unclaimed\`; while it is \`human\`, the user is driving, so read it with \`preview_snapshot\` or open your own tab. To use a browser profile (a set of saved logins), pass \`profileId\` from \`preview_status\` profiles to \`preview_open\`.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Inspect a failed preview call and retry with corrected arguments when the error is actionable. Use another browser system when:
- the T3 preview tools are absent, or \`preview_open\` returns an explicit unsupported/unavailable error;
- the user asks for another browser, or invokes a skill or documented repository workflow that names one; follow that workflow and report any prerequisite it is missing;
- preview calls on an open tab have failed twice on the same step (timeouts, \`chrome-error://\` pages, a different client answering). Quote the raw error and switch without asking the user which browser to use.
`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
}

/**
 * ACP has no system/developer prompt field, so send T3-owned context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
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
      ? [T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Keep the wrapper explicit so it cannot be mistaken for text authored by the user.
 */
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
