import {
  OrchestratorMcpCapabilitiesResult,
  OrchestrationV2StopWorkflowInput,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksInput,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpUpdateScheduledTaskInput,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
  RepositoryWorkInput,
  RepositoryWorkControlInput,
  RepositoryHandoffRequestInput,
  RepositoryWorkResult,
  IssueRepositoryRef,
  IssueWorkCancelInput,
  IssueWorkRequested,
  RepositoryWorkRestoreInput,
  IssueChangeProposeInput,
  IssueChange,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

import { LinkIssueTool, UnlinkIssueTool } from "../../../issues/IssueMcpTools.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
];
const threadMetadataDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadMetadataMcpService.ThreadMetadataMcpService,
];
const ProposeIssueChangeTool = Tool.make("propose_issue_change", {
  description:
    "Propose an exact GitHub issue change from a repository-managed thread. Use a stable clientRequestId on retries. Create/split and milestone moves execute automatically unless the user requires approval. A change needing approval (body edits, close/reopen, standalone parent changes) returns at once as pending while the owner is asked in this thread; do not ask them yourself. Their Approve or Decline arrives here as a message and the server applies it; Don't ask mode declines. Proposing again with the same clientRequestId returns the current decision and status. The returned change includes the exact preview, decision and result. Agents cannot approve or answer these questions. A conflict needs a new proposal and preview. Labels and assignees are outside this tool's scope.",
  parameters: IssueChangeProposeInput,
  success: IssueChange,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Propose an issue change")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "List the V2 provider instances and their current models from the same live catalog as the composer, including configured custom models, inherited runtime settings, and app-owned orchestration features available to this caller, plus the user's model role alternatives with exact targets, weekly quota headroom, and why any is unavailable. Choices are ordered by current headroom; choose for task fit. For a separate top-level thread in a new or existing worktree, use t3_thread_launch with workspaceStrategy.",
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Needs an agent running inside a T3 thread. Delegate one task to a T3-owned child agent/subagent of THIS thread and run it with only the supplied task prompt, without copying parent conversation history. Choose providers and models from orchestrator_capabilities, which uses the same live catalog as the composer. Prefer native subagent tools for same-provider work only when they support the chosen model. Use this for any model missing from the native tool, including same-provider work, for cross-provider work, or for explicitly T3-owned child tasks. For every T3 delegated review round, call delegate_task again with the original brief, prior findings, responses, and unresolved objections in the task prompt. Track each round by its own taskId and use a distinct clientRequestId per round, stable across retries of that round. The childThreadId is backing storage, not the target for starting another delegated review round through t3_thread_send. Provider, model, model options (see orchestrator_capabilities), runtime mode, and interaction mode inherit unless target overrides them. A requested runtimeMode must be one the target provider lists in orchestrator_capabilities runtimeModes; an inherited one steps down to the broadest mode it offers. Prefer mode='async' for long work; mode='wait' blocks until completion or timeout. timeoutMs on mode=wait is only the parent's wait budget and does not cancel the child. waitTimedOut on that wait call means the timeout fired; keep that taskId and read status on later task_status. An async child's completion wakes this thread through a notification, steered into active turns where supported or queued otherwise, so end the turn instead of polling or spawning watchers; use task_status only when the result is needed mid-turn. For repository-managed issue work, supply issue and use async mode: this starts an eligible issue directly or returns its current claimed worker. Managed issue workers always get a new issue worktree on a fresh branch from the repository default branch. The workspace argument applies only to other tasks. For other tasks, pass workspace='worktree' for a child that edits code in parallel with you or its siblings: T3 creates a new git worktree on a new branch cut from this thread's branch, or the branch its checkout is on (committed work only), runs the project's setup script there, and starts the child in it; branch and worktreePath come back in the result and task_status. Implementation and test roles default to worktree, falling back to inherit with a workspaceNote when this checkout is on a detached HEAD or outside git; other roles default to inherit. Set workspace='inherit' to keep a code-editing child in this checkout. The child's commits stay on its branch until you merge or cherry-pick them, and its worktree is not removed automatically.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskStatusTool = Tool.make("task_status", {
  description:
    "Needs an agent running inside a T3 thread. Read a T3-owned delegated task created by this parent thread. childRunId identifies the original delegated run. workState distinguishes working, waiting_for_children, and result_available; a completed turn with live nested work is not a completed task. summary is the final task result, including provider errors on failure, and remains stable after publication. hasPendingChildRuns reports later queued or executing turns in the backing child thread, even after the task is terminal; it does not reopen the task, and task_cancel stops those turns too. Turns held in a stopped queue wait for the user and do not count. latestTerminal* provides later non-monitor turn results. Reading a terminal result acknowledges its automatic parent delivery.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Needs an agent running inside a T3 thread. Stop a T3-owned delegated task and dispose its automatic parent delivery. Its child thread stops like a user Stop: the running turn is interrupted, queued turns are held, pull request watches end, and the tasks it delegated stop too. This includes later child-thread runs, even after the task is terminal. A terminal task returns its existing status, and published task results remain available.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

const WorkflowStopTool = Tool.make("t3_workflow_stop", {
  description:
    "Stop one running Claude workflow in a T3 thread. Use the workflow coordinator's subagentId returned by t3_thread_read with view='activity'. Stops the whole workflow, including its phases and agents. Does not stop the parent thread or other workflows. Individual workflow phases and agents cannot be stopped separately.",
  parameters: OrchestrationV2StopWorkflowInput,
  success: Schema.Struct({}),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop a workflow")
  .annotate(Tool.Destructive, true);

export const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create persistent work in the app scheduler that runs even when no turn is active. Pass schedule as a STRUCTURED OBJECT, never JSON text. Timers: {type:'interval', everyMs:3600000} is hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} is weekday mornings; report the returned nextRunAt. Webhooks: {type:'webhook'} runs once per request to a generated URL. The run sees the request ONLY through prompt placeholders: {{body.path}} (e.g. {{body.action}}, {{body.release.tag_name}}), {{headers.name}}, {{query.name}}, {{body}}, or {{request}} (method, headers with credentials redacted, and body). For a sender that signs requests, first call request_secret so the user enters the secret privately (never ask for it in chat or invent one), then set signature with the returned secretRef, e.g. GitHub: {type:'webhook', signature:{header:'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secretRef}}. The result's webhookUrl is the public URL to give the user; if it is absent, this environment has no T3 Connect managed tunnel, so tell the user to enable T3 Connect remote access rather than sharing a path. Omit projectId for this thread's project. In this thread's project, runs post into THIS thread by default (bindToCurrentThread=true), which suits an orchestrator that sees every trigger, delegates work, and can dedupe against what is in flight; use false only when the user wants a fresh top-level thread per run. Elsewhere each run launches a fresh thread. Provider, model, and runtime settings inherit from this thread, or from the project default when there is no calling thread.",
  parameters: OrchestratorMcpScheduleTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Schedule a recurring task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  parameters: OrchestratorMcpListScheduledTasksInput,
  description:
    "List recurring scheduled tasks in a project (omit projectId for the calling thread's project, or every project when there is no calling thread), including their id, schedule, prompt, enabled state, bound thread, next run time, and last run status. Use the returned scheduledTaskId with update_scheduled_task or delete_scheduled_task.",
  success: OrchestratorMcpListScheduledTasksResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List scheduled tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UpdateScheduledTaskTool = Tool.make("update_scheduled_task", {
  description:
    "Update an existing scheduled task by scheduledTaskId (from list_scheduled_tasks). Only the provided fields change; omit a field to leave it as-is. Use enabled=false to pause a task without deleting it. Set bindToCurrentThread to move the task between posting into this thread and launching a fresh thread per run.",
  parameters: OrchestratorMcpUpdateScheduledTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a scheduled task")
  .annotate(Tool.Destructive, true);

const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Permanently delete a scheduled task by scheduledTaskId (from list_scheduled_tasks). The task stops running immediately. To keep it but stop runs, use update_scheduled_task with enabled=false instead.",
  parameters: OrchestratorMcpDeleteScheduledTaskInput,
  success: OrchestratorMcpDeleteScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a scheduled task")
  .annotate(Tool.Destructive, true);

const RequestSecretTool = Tool.make("request_secret", {
  description:
    "Ask the user for a secret (a token, API key, signing secret, password) through a private card in this thread, and wait for them to answer. The value is kept by the app and NEVER returned to you or shown in the transcript. When saved, the result carries a secretRef: pass it to a tool that accepts one (e.g. schedule_task's signature.secretRef). It works once. Never ask for secrets in chat, and never invent one.",
  parameters: OrchestratorMcpRequestSecretInput,
  success: OrchestratorMcpRequestSecretResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a secret from the user")
  .annotate(Tool.Destructive, false);

export const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Needs an agent running inside a T3 thread. Create one or more ORDINARY TOP-LEVEL T3 conversations. This is not delegation and does not create child agents/subagents. For delegated work, choose models from orchestrator_capabilities. Prefer native subagents only when they support the chosen model; otherwise call delegate_task, including for same-provider work. Use create_threads for a batch of separate top-level threads sharing this checkout. Prefer t3_thread_launch for a single thread. Both require the user to request separate/new/top-level threads or conversations. Each entry may override provider, model, options, runtime mode, and interaction mode; omitted settings inherit. Project, branch, and worktree always inherit and cannot be overridden here. For independent implementation or a PR stack in its own worktree, use t3_thread_launch with workspaceStrategy instead of asking the agent to create a worktree in its prompt.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create T3 threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadListTool = Tool.make("t3_thread_list", {
  description:
    "List T3 threads in a project, newest first. Omit projectId for the calling thread's project. Filter by durable run status, title, or settled state (settled=true lists threads the user or auto-settlement moved out of the active list), or snoozed state, and paginate with the returned cursor. A snoozed thread wakes early when it asks for something, fails, or completes. To link a thread for the user, write `[title](t3-thread://v1/<threadId>)` with the threadId exactly as returned, not URL-encoded; T3 Code shows the thread's current title.",
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List T3 threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadReadTool = Tool.make("t3_thread_read", {
  description:
    "Read durable state and a paginated timeline from any T3 thread in this environment. The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Reading an untruncated terminal assistant result from this parent thread's direct app-owned child acknowledges that child's automatic completion delivery. Continue with afterPosition=nextPosition. Recover long item text with itemId and textOffset=nextTextOffset until nextTextOffset is null; offsets count UTF-16 code units. The thread also reports its snooze state. To link a thread for the user, write `[title](t3-thread://v1/<threadId>)` with the threadId exactly as returned, not URL-encoded; T3 Code shows the thread's current title.",
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a T3 thread")
  // Strict so a misspelled paging param fails instead of silently reading from position 0.
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadUpdateTool = Tool.make("t3_thread_update", {
  description:
    "Update metadata for a thread. Omit threadId to update this thread. Use action='rename' with title, action='regenerate_title' with no extra field, action='link_pull_request' with pullRequest, or action='unlink_pull_request'. Workspace and branch changes are not supported here; use t3_worktree_handoff to move into a worktree and t3_worktree_return_to_root to move back to the main checkout. clientRequestId makes retries idempotent.",
  parameters: ThreadMetadataMcpUpdateInput,
  success: ThreadMetadataMcpUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: threadMetadataDependencies,
})
  .annotate(Tool.Title, "Update T3 thread metadata")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const ThreadSendTool = Tool.make("t3_thread_send", {
  description:
    "Send a message to any T3 thread in this environment. The target cannot have broader permission modes than the caller. A delegated task cannot message its parent or ancestor threads: its final message is delivered to the parent automatically, and it asks for decisions with the question tool. Use delegate_task with the full review context and a new clientRequestId for independent review rounds. For a follow-up that needs the same child's conversation, send to its childThreadId. After the original task completes, a requested follow-up creates a fresh task in that child thread and returns taskId; its completion notifies the parent, and the original result stays unchanged. mode='auto' starts an idle thread, steers a fully active turn, or queues behind a turn that is not yet steerable. Use queue for a separate follow-up turn, steer for an in-flight update, or restart to interrupt-and-restart the active turn. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a T3 thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadWaitTool = Tool.make("t3_thread_wait", {
  description:
    "Wait for a T3 thread run to reach a terminal durable state. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use t3_thread_read/list after timedOut=true. Waiting reports status only and does not acknowledge a delegated result.",
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a T3 thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadInterruptTool = Tool.make("t3_thread_interrupt", {
  description:
    "Request interruption of a running turn in any T3 thread in this environment. Without runId, the newest interruptible run is selected. Terminal runs and threads without an active turn return without another side effect. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a T3 thread")
  .annotate(Tool.Destructive, true);

export const OrchestratorToolkit = Toolkit.make(
  ProposeIssueChangeTool,
  Tool.make("request_repository_handoff", {
    description:
      "Request a fresh-thread handoff of this repository's registered root. Read get_repository_orchestration for its ownership revision, and supply a recovery summary. Only the current root may request it. The user must approve in the repository controls; this tool does not approve or transfer ownership. After approval T3 pauses new admissions, drains existing workers and final deliveries, gives the fresh thread a server recovery inventory, then atomically replaces the owner. Routine model changes should keep the current thread.",
    parameters: RepositoryHandoffRequestInput,
    success: RepositoryWorkResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Destructive, false),
  Tool.make("work_through_milestone", {
    description:
      "Authorize the registered repository orchestrator to work through this milestone. Every issue worker gets its own new issue worktree and branch from the repository default branch. Parent ownership, blockers and shared worker capacity are enforced by the server.",
    parameters: RepositoryWorkInput,
    success: RepositoryWorkResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Destructive, true),
  Tool.make("get_repository_orchestration", {
    description: "Read repository ownership, pause state and milestone progress.",
    parameters: IssueRepositoryRef,
    success: RepositoryWorkResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("set_repository_work_paused", {
    description: "Pause new worker admissions or resume after rechecking GitHub eligibility.",
    parameters: RepositoryWorkControlInput,
    success: RepositoryWorkResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Destructive, true),
  Tool.make("cancel_issue_request", {
    description:
      "Cancel an unclaimed issue Start request (one no worker has picked up), including duplicate requests for the same attempt. A stopped repository root with unclaimed requests cannot be archived or replaced until they are cancelled. Claimed worker work is refused.",
    parameters: IssueWorkCancelInput,
    success: IssueWorkRequested,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Destructive, true),
  Tool.make("restore_repository_root", {
    description:
      "Make another existing top-level thread in the repository's project the repository orchestrator. Read get_repository_orchestration for the current root and revision and pass them as expectations. Pause repository work first. Restore keeps it paused; use set_repository_work_paused to resume. The target must use the main checkout on the repository default branch. The current root must be idle: no unfinished runs or subagents, no unclaimed requests (see cancel_issue_request), and no handoff.",
    parameters: RepositoryWorkRestoreInput,
    success: RepositoryWorkResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Destructive, true),
  LinkIssueTool,
  UnlinkIssueTool,
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskCancelTool,
  WorkflowStopTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  DeleteScheduledTaskTool,
  RequestSecretTool,
  CreateThreadsTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadUpdateTool,
  ThreadSendTool,
  ThreadWaitTool,
  ThreadInterruptTool,
);
