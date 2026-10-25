import { PROJECT_ARTIFACT_METHODS } from "./projectArtifactRpc.ts";
import { type ServerSettingsPatch, requiredScopesForServerSettingsPatch } from "./settings.ts";
import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [PROJECT_ARTIFACT_METHODS.add]: AuthOrchestrationOperateScope,
  [PROJECT_ARTIFACT_METHODS.remove]: AuthOrchestrationOperateScope,
  [PROJECT_ARTIFACT_METHODS.move]: AuthOrchestrationOperateScope,
  [PROJECT_ARTIFACT_METHODS.renameSection]: AuthOrchestrationOperateScope,
  [PROJECT_ARTIFACT_METHODS.reorderSections]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpdateSettings]: AuthSettingsWriteScope,
  [WS_METHODS.sidebarLayoutUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.projectsCreateNew]: AuthOrchestrationOperateScope,
  [WS_METHODS.terminalRunInline]: AuthTerminalOperateScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.worktreeReturnToRoot]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [WS_METHODS.issuesSetState]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesCleanup]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesUnlink]: AuthOrchestrationOperateScope,
  [WS_METHODS.issuesCloseOut]: AuthOrchestrationOperateScope,
  [WS_METHODS.issuesCancelRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.issuesRestoreRoot]: AuthOrchestrationOperateScope,
  [WS_METHODS.issuesAssignOrchestrator]: AuthOrchestrationOperateScope,
  [WS_METHODS.issuesSetWorkerLimit]: AuthOrchestrationOperateScope,
  [WS_METHODS.issuesSetReadOnlyLimit]: AuthOrchestrationOperateScope,
  [WS_METHODS.issuesQueue]: AuthOrchestrationOperateScope,
  [WS_METHODS.issuesUnqueue]: AuthOrchestrationOperateScope,
  [WS_METHODS.ownerDecisionsChoose]: AuthOrchestrationOperateScope,
  [WS_METHODS.issuesInboxMarkRead]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.serverUpdateSettings && input !== undefined) {
    const payload = (typeof input === "object" && input !== null ? input : {}) as {
      patch?: unknown;
      providerInstanceMutation?: unknown;
    };
    const patch = (
      typeof payload.patch === "object" && payload.patch !== null ? payload.patch : {}
    ) as ServerSettingsPatch;
    const scopes = requiredScopesForServerSettingsPatch(patch);
    if (payload.providerInstanceMutation === undefined) return scopes;
    return Object.values(patch).every((value) => value === undefined)
      ? [AuthProvidersManageScope]
      : [...new Set([...scopes, AuthProvidersManageScope])];
  }
  if (method === WS_METHODS.projectCloneStart && input !== undefined) {
    const payload = (typeof input === "object" && input !== null ? input : {}) as {
      sectionId?: unknown;
      sidebarExpanded?: unknown;
    };
    return payload.sectionId !== undefined || payload.sidebarExpanded !== undefined
      ? [AuthSourceControlWriteScope, AuthSettingsWriteScope]
      : [AuthSourceControlWriteScope];
  }
  if (method === WS_METHODS.projectsCreateNew && input !== undefined) {
    const payload = (typeof input === "object" && input !== null ? input : {}) as {
      sectionId?: unknown;
      sidebarExpanded?: unknown;
    };
    return payload.sectionId !== undefined || payload.sidebarExpanded !== undefined
      ? [AuthOrchestrationOperateScope, AuthSettingsWriteScope]
      : [AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
