import type {
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ProviderUserInputAnswers,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";

/** Shells read per poll. A page is at most 20, so the extra rows are threads still working. */
export const ATTENTION_SCAN = 40;
const ATTENTION_TEXT_LIMIT = 240;

export type AttentionKind = "question" | "approval" | "blocked" | "finished";

const SECRET_TEXT =
  /(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_\S+|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})/g;

/** Cursor text is `updatedAt`, then a newline, then `threadId`. An ISO time alone starts after that instant. */
export function decodeAttentionCursor(
  since: string,
): { readonly updatedAt: string; readonly threadId: string } | undefined {
  const split = since.indexOf("\n");
  const updatedAt = split === -1 ? since : since.slice(0, split);
  const threadId = split === -1 ? "" : since.slice(split + 1);
  if (split === 0 || Number.isNaN(Date.parse(updatedAt))) return undefined;
  return { updatedAt, threadId };
}

export function encodeAttentionCursor(updatedAt: string, threadId: string): string {
  return `${updatedAt}\n${threadId}`;
}

export function presentAttentionText(text: string | null | undefined): string | null {
  if (text == null) return null;
  const redacted = text
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[withheld]@")
    .replace(SECRET_TEXT, "[withheld]")
    .trim();
  if (redacted.length === 0) return null;
  const chars = Array.from(redacted);
  if (chars.length <= ATTENTION_TEXT_LIMIT) return redacted;
  return `${chars.slice(0, ATTENTION_TEXT_LIMIT - 3).join("")}...`;
}

type AttentionShell = Pick<
  OrchestrationV2ThreadShell,
  | "archivedAt"
  | "deletedAt"
  | "lineage"
  | "settledOverride"
  | "pendingRuntimeRequest"
  | "status"
  | "activityRunStatus"
  | "blockedOnThreadWait"
  | "pendingBackgroundTasks"
  | "snoozedUntil"
  | "snoozedAt"
  | "latestRunCompletedAt"
  | "pendingGuestMessageCount"
>;

function listedStatus(shell: AttentionShell) {
  if (shell.activityRunStatus != null) return shell.activityRunStatus;
  if (shell.status === "failed") return shell.status;
  if (backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? [])) return "waiting" as const;
  return shell.status;
}

/**
 * What a watcher should surface. A thread that is still working, settled, snoozed, or hidden
 * in its parent's view is omitted. A pending request wins over a terminal run.
 */
export function classifyAttention(
  shell: AttentionShell,
  nowMs: number,
  includeSubagents: boolean,
): AttentionKind | null {
  if (shell.deletedAt !== null || shell.archivedAt !== null) return null;
  if (shell.lineage.sideChat === true || shell.lineage.workflowStep === true) return null;
  if (!includeSubagents && shell.lineage.relationshipToParent === "subagent") return null;
  if (isSnoozed(shell, nowMs)) return null;
  const pending = shell.pendingRuntimeRequest;
  if (pending?.userOnly === true || pending?.kind === "auth_refresh") return "blocked";
  if (pending != null && pending.kind !== "user_input") return "approval";
  if (pending?.kind === "user_input") return "question";
  if (shell.settledOverride === "settled") return null;
  const status = listedStatus(shell);
  if (status === "failed" || status === "interrupted" || status === "cancelled") return "blocked";
  if (shell.blockedOnThreadWait === true) return "blocked";
  if (status === "completed") return "finished";
  return null;
}

export function pageAttention<
  T extends { readonly id: string; readonly updatedAt: string },
>(input: {
  readonly candidates: ReadonlyArray<T>;
  readonly hasMoreCandidates: boolean;
  readonly limit: number;
  readonly classify: (candidate: T) => AttentionKind | null;
}): {
  readonly matches: ReadonlyArray<{ readonly candidate: T; readonly attention: AttentionKind }>;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
} {
  const matches: Array<{ readonly candidate: T; readonly attention: AttentionKind }> = [];
  let last: T | undefined;
  for (const candidate of input.candidates) {
    last = candidate;
    const attention = input.classify(candidate);
    if (attention === null) continue;
    matches.push({ candidate, attention });
    if (matches.length === input.limit) break;
  }
  if (last === undefined) return { matches, hasMore: false, nextCursor: null };
  const filled = matches.length === input.limit;
  const consumedWindow = last === input.candidates.at(-1);
  const hasMore = filled
    ? !consumedWindow || input.hasMoreCandidates
    : consumedWindow && input.hasMoreCandidates;
  const cursorOf = filled ? matches.at(-1)!.candidate : last;
  return {
    matches,
    hasMore,
    nextCursor: hasMore ? encodeAttentionCursor(cursorOf.updatedAt, cursorOf.id) : null,
  };
}

const APPROVAL_KINDS = new Set([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
  "dynamic_tool_call",
]);

export type ThreadReplyPlan =
  | { readonly _tag: "Refuse"; readonly message: string }
  | {
      readonly _tag: "Answer";
      readonly requestId: RuntimeRequestId;
      readonly answers: ProviderUserInputAnswers;
    }
  | {
      readonly _tag: "Decide";
      readonly requestId: RuntimeRequestId;
      readonly decision: "accept" | "decline";
    }
  | { readonly _tag: "Send"; readonly message: string };

type ReplyShell = Pick<
  OrchestrationV2ThreadShell,
  | "archivedAt"
  | "activityRunStatus"
  | "status"
  | "pendingRuntimeRequest"
  | "blockedOnThreadWait"
  | "pendingBackgroundTasks"
>;

const followUpAllowed = (shell: ReplyShell): boolean =>
  shell.archivedAt === null &&
  shell.pendingRuntimeRequest === null &&
  shell.activityRunStatus == null &&
  shell.blockedOnThreadWait !== true &&
  !backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []) &&
  (shell.status === "completed" ||
    shell.status === "failed" ||
    shell.status === "interrupted" ||
    shell.status === "cancelled" ||
    shell.status === "idle" ||
    shell.status === "rolled_back");

/**
 * What `t3_thread_reply` may do. A running turn is refused, and so is a secret or link card:
 * only the user answers those. Approving is accept or decline, never a saved permission.
 */
export function planThreadReply(input: {
  readonly shell: ReplyShell;
  readonly requests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "id" | "kind" | "status">>;
  readonly turnItems: ReadonlyArray<Pick<OrchestrationV2TurnItem, "id" | "type" | "status">>;
  readonly action: "answer" | "approve" | "deny" | "message";
  readonly requestId: RuntimeRequestId | undefined;
  readonly answers: ProviderUserInputAnswers | undefined;
  readonly message: string | undefined;
}): ThreadReplyPlan {
  if (input.shell.archivedAt !== null) {
    return { _tag: "Refuse", message: "This thread is archived." };
  }
  if (input.action === "message") {
    if (input.message === undefined)
      return { _tag: "Refuse", message: "This action needs `message`." };
    if (input.shell.pendingRuntimeRequest !== null) {
      return {
        _tag: "Refuse",
        message:
          "This thread is waiting on a question or an approval. Answer that instead of sending a follow-up.",
      };
    }
    if (input.shell.activityRunStatus != null) {
      return {
        _tag: "Refuse",
        message:
          "This thread is still running. Reply only answers a waiting thread or follows up on a finished one.",
      };
    }
    if (!followUpAllowed(input.shell)) {
      return { _tag: "Refuse", message: "This thread is still working." };
    }
    return { _tag: "Send", message: input.message };
  }
  if (input.requestId === undefined) {
    return { _tag: "Refuse", message: "This action needs `requestId`." };
  }
  const requestId = input.requestId;
  const userOnly =
    (input.shell.pendingRuntimeRequest?.userOnly === true &&
      input.shell.pendingRuntimeRequest.id === requestId) ||
    input.turnItems.some(
      (item) =>
        (item.type === "secret_request" || item.type === "link_request") &&
        item.status === "waiting" &&
        (item.id as string) === (requestId as string),
    );
  if (userOnly) {
    return { _tag: "Refuse", message: "Only the user can answer this in the app." };
  }
  const request = input.requests.find((candidate) => candidate.id === requestId);
  if (request === undefined) {
    return { _tag: "Refuse", message: "The pending request was not found." };
  }
  if (request.status !== "pending") {
    return {
      _tag: "Refuse",
      message:
        request.status === "resolved"
          ? "The request was already answered."
          : `The request is no longer pending (${request.status}).`,
    };
  }
  if (input.action === "answer") {
    if (request.kind !== "user_input") {
      return { _tag: "Refuse", message: "This is an approval. Use action `approve` or `deny`." };
    }
    if (input.answers === undefined)
      return { _tag: "Refuse", message: "This action needs `answers`." };
    return { _tag: "Answer", requestId, answers: input.answers };
  }
  if (request.kind === "user_input" || !APPROVAL_KINDS.has(request.kind)) {
    return { _tag: "Refuse", message: "This is a question. Use action `answer`." };
  }
  return {
    _tag: "Decide",
    requestId,
    decision: input.action === "approve" ? "accept" : "decline",
  };
}
