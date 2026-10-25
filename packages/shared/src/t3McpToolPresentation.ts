export type T3McpToolLogo = "t3-code";

export interface T3McpToolPresentation {
  readonly displayName: string;
  readonly logo: T3McpToolLogo;
}

export type T3McpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "workflow-stop"
  | "background-wait"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-ask"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render"
  | "issue-work";

export interface T3McpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "t3-code" | "browser" | "device" | "pull-request";
  readonly summaryAction: T3McpToolSummaryAction;
}

function tool(
  labels: T3McpToolDefinition["labels"],
  summaryAction: T3McpToolSummaryAction,
  icon: T3McpToolDefinition["icon"] = "t3-code",
  displayName = `${labels[0]} ${labels[3]}`,
): T3McpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

const T3_MCP_SERVER_ALIASES = new Set(["t3-code", "t3_code", "t3code"]);

const T3_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Unwatching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["Write", "Writing", "Started writing", "review guides"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["Read", "Reading", "Read", "a review guide"],
    "read-pr-guide",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  queue_issue: tool(["Queue", "Queuing", "Queued", "an issue"], "issue-work"),
  unqueue_issue: tool(["Remove", "Removing", "Removed", "an issue from the queue"], "issue-work"),
  work_through_milestone: tool(["Start", "Starting", "Started", "milestone work"], "issue-work"),
  get_repository_orchestration: tool(
    ["Check", "Checking", "Checked", "repository orchestration"],
    "issue-work",
  ),
  set_repository_worker_limit: tool(
    ["Update", "Updating", "Updated", "repository concurrency limit"],
    "issue-work",
  ),
  set_repository_work_paused: tool(
    ["Update", "Updating", "Updated", "repository pause state"],
    "issue-work",
  ),
  request_repository_handoff: tool(
    ["Request", "Requesting", "Requested", "an orchestrator handoff"],
    "issue-work",
  ),
  close_out_issue_attempt: tool(
    ["Close out", "Closing out", "Closed out", "an issue attempt"],
    "issue-work",
  ),
  cancel_issue_request: tool(
    ["Cancel", "Canceling", "Cancelled", "an issue start request"],
    "issue-work",
  ),
  restore_repository_root: tool(
    ["Change", "Changing", "Changed", "the repository orchestrator"],
    "issue-work",
  ),
  link_issue: tool(["Link", "Linking", "Linked", "an issue"], "issue-work"),
  unlink_issue: tool(["Unlink", "Unlinking", "Unlinked", "an issue"], "issue-work"),
  propose_issue_change: tool(["Propose", "Proposing", "Proposed", "an issue change"], "issue-work"),
  t3_issue_post: tool(["Post", "Posting", "Posted", "to a GitHub issue"], "issue-work"),
  request_owner_decision: tool(
    ["Request", "Requesting", "Requested", "an owner decision"],
    "issue-work",
  ),
  list_owner_decisions: tool(["List", "Listing", "Listed", "owner decisions"], "issue-work"),
  withdraw_owner_decision: tool(
    ["Withdraw", "Withdrawing", "Withdrew", "an owner decision"],
    "issue-work",
  ),
  t3_issue_inbox: tool(["Read", "Reading", "Read", "the issue inbox"], "issue-work"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  create_threads: tool(["Create", "Creating", "Created", "T3 threads"], "thread-create"),
  t3_thread_start: tool(["Start", "Starting", "Started", "a T3 thread"], "thread-create"),
  t3_thread_list: tool(["List", "Listing", "Listed", "T3 threads"], "thread-list"),
  t3_thread_read: tool(["Read", "Reading", "Read", "a T3 thread"], "thread-read"),
  t3_thread_send: tool(["Send", "Sending", "Sent", "to a T3 thread"], "thread-send"),
  t3_thread_wait: tool(["Wait", "Waiting", "Waited", "for a T3 thread"], "thread-wait"),
  t3_workflow_stop: tool(
    ["Stop", "Stopping", "Requested a stop for", "a workflow"],
    "workflow-stop",
  ),
  t3_background_wait: tool(
    ["Update", "Updating", "Updated", "background waits"],
    "background-wait",
  ),
  t3_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a T3 thread"],
    "thread-interrupt",
  ),
  t3_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  t3_worktree_return_to_root: tool(
    ["Move", "Moving", "Moved", "thread to the main checkout"],
    "worktree-handoff",
  ),
  t3_worktree_status: tool(["Get", "Getting", "Got", "thread worktree status"], "worktree-status"),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  t3_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  t3_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  t3_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  t3_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  t3_queue_reorder: tool(["Reorder", "Reordering", "Reordered", "a queued run"], "queue-reorder"),
  t3_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  t3_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  t3_request_user_input: tool(["Ask", "Asking", "Asked", "the user"], "question-ask"),
  t3_pending_request_read: tool(["Read", "Reading", "Read", "pending questions"], "question-read"),
  t3_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  t3_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  t3_thread_configure: tool(["Set", "Setting", "Set", "thread model"], "thread-configure"),
  t3_thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this thread"], "thread-fork"),
  t3_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  t3_thread_search: tool(["Search", "Searching", "Searched", "thread content"], "thread-search"),
  t3_thread_transfers: tool(["Read", "Reading", "Read", "thread transfers"], "thread-transfers"),
  t3_thread_organize: tool(["Organize", "Organizing", "Organized", "a thread"], "thread-organize"),
  t3_thread_update: tool(["Update", "Updating", "Updated", "T3 thread metadata"], "thread-update"),
  t3_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  t3_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  t3_preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  t3_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  t3_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  t3_thread_launch: tool(["Launch", "Launching", "Launched", "a project thread"], "thread-create"),
  t3_project_artifacts_list: tool(
    ["List", "Listing", "Listed", "project artifacts"],
    "project-read",
  ),
  t3_project_artifacts_add: tool(
    ["Pin", "Pinning", "Pinned", "project artifact"],
    "project-update",
  ),
  t3_project_artifacts_move: tool(
    ["Move", "Moving", "Moved", "project artifact"],
    "project-update",
  ),
  t3_project_artifacts_remove: tool(
    ["Remove", "Removing", "Removed", "project artifact"],
    "project-update",
  ),
  t3_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  t3_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  t3_project_create: tool(["Register", "Registering", "Registered", "a project"], "project-create"),
  t3_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  t3_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  t3_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  t3_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  t3_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  t3_thread_send_attachments: tool(["Send", "Sending", "Sent", "attachments"], "attachment-send"),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
};

export const T3_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(T3_MCP_TOOLS));

function normalizeT3McpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

// ACP tool prefixes vary; match loosely but require a known display-name entry.
function resolveT3McpToolName(value: string): string | null {
  const label = normalizeT3McpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      T3_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch = /^(?<server>t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
    label,
  );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  const prefixed = /^(?:mcp[-_]{1,2})?t3[-_ ]?code(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(T3_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 thread prefixes can contain underscores; choose the longest known tool-name suffix.
  if (!/^t3-code-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(T3_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

export function resolveT3McpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveT3McpToolName(toolName);
  return name !== null && Object.hasOwn(T3_MCP_TOOLS, name) ? name : null;
}

export function resolveT3McpToolDefinition(
  toolName: string | null | undefined,
): T3McpToolDefinition | null {
  const name = toolName == null ? null : resolveT3McpToolName(toolName);
  return name !== null && Object.hasOwn(T3_MCP_TOOLS, name) ? T3_MCP_TOOLS[name]! : null;
}

export function resolveT3McpToolPresentation(
  toolName: string | null | undefined,
): T3McpToolPresentation | null {
  const definition = resolveT3McpToolDefinition(toolName);
  return definition === null ? null : { displayName: definition.displayName, logo: "t3-code" };
}
