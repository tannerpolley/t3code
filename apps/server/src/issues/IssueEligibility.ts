import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import {
  ISSUE_ADMISSION_HOLD_LABELS,
  type IssueSuspension,
  isManagedIssueImplementor,
  resolveThreadRole,
  THREAD_ROLE_NAMES,
  type IssueWorkRead,
  type OrchestrationV2AppThread,
  type ProviderDriverKind,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import type { ManagedIssueRole } from "@t3tools/provider-core/server/mcpSession";

export const isReadOnlyIssueRole = (role: string | undefined) => {
  const resolved = role === undefined ? undefined : resolveThreadRole(role);
  return resolved === "designer" || resolved === "reviewer";
};

export const readOnlyIssueRoles = THREAD_ROLE_NAMES.filter(isReadOnlyIssueRole);

export const isUnmanagedIssueRole = (role: string | undefined) =>
  resolveThreadRole(role ?? "") === "writer" || isReadOnlyIssueRole(role);

export const requiresManagedIssueAdmission = (
  role: string | undefined,
  parent: Pick<OrchestrationV2AppThread, "repositoryOrchestration" | "linkedIssue">,
  root: Pick<OrchestrationV2AppThread, "repositoryOrchestration">,
) =>
  !isUnmanagedIssueRole(role) &&
  (parent.repositoryOrchestration !== undefined ||
    parent.linkedIssue !== undefined ||
    root.repositoryOrchestration !== undefined);

/** Linked issue workers and the repository root get managed orchestration instructions. */
export const managedIssueRole = (
  thread: Pick<
    OrchestrationV2AppThread,
    "linkedIssue" | "repositoryOrchestration" | "role" | "lineage"
  >,
): ManagedIssueRole | undefined =>
  thread.linkedIssue !== undefined
    ? isManagedIssueImplementor(thread)
      ? "implementor"
      : "worker"
    : thread.repositoryOrchestration !== undefined
      ? "root"
      : undefined;

/** Codex and Claude drivers; IssueEligibility.test.ts ties these names to the real drivers. */
export const supportsManagedIssueWork = (driver: ProviderDriverKind) =>
  driver === "codex" || driver === "claudeAgent";

export const managedIssueProviderError =
  "Managed issue work requires Codex or Claude; other adapters allow untracked native children.";

export const sameIssueRepository = (
  left: Pick<ThreadLinkedIssue, "host" | "repositoryId">,
  right: Pick<ThreadLinkedIssue, "host" | "repositoryId">,
) =>
  left.host.toLowerCase() === right.host.toLowerCase() && left.repositoryId === right.repositoryId;

export const issueScopeExpansionError =
  "The ancestor owner needs approval to expand the repository scope.";

export const openBlockerSuspensionReason =
  "An issue host blocker is open. Resolve it before resuming.";

export const unreadableRelationshipsSuspensionReason =
  "Issue relationships are unreadable. Restore access before resuming.";

export const isOpenBlockerSuspension = (entry: Pick<IssueSuspension, "kind"> | undefined) =>
  entry?.kind === "blocked";
export const isAutomaticIssueSuspension = (entry: Pick<IssueSuspension, "kind"> | undefined) =>
  isOpenBlockerSuspension(entry) || entry?.kind === "unreadable";

/** Failed or partial relationship reads never authorize a worker. */
export function issueEligibility(
  read: IssueWorkRead,
): "eligible" | "closed" | "blocked" | "unknown" {
  if (!read.parentComplete || !read.subIssuesComplete || !read.blockersComplete) return "unknown";
  if (read.state !== "open") return "closed";
  return read.blockedBy.some((blocker) => blocker.state === "open") ? "blocked" : "eligible";
}

export const admitsTodo = (status: string | undefined, labels: readonly string[] | undefined) =>
  status?.toLowerCase() === "todo" &&
  labels !== undefined &&
  !labels.some((label) =>
    ISSUE_ADMISSION_HOLD_LABELS.some((hold) => hold.toLowerCase() === label.toLowerCase()),
  );

export const issueAdmissionEligible = (read: IssueWorkRead) =>
  issueEligibility(read) === "eligible" && admitsTodo(read.planningStatus, read.labels);

// The fork preview uses real GitHub issues with synthetic work.
export const issueAutomationEnabled = Config.Boolean("T3CODE_ISSUE_AUTOMATION").pipe(
  Config.withDefault(true),
  Effect.orDie,
);
