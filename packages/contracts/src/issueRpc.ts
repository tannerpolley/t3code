import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import {
  EnvironmentAuthorizationError,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
} from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  OwnerDecision,
  OwnerDecisionsListInput,
  OwnerDecisionChooseInput,
  OwnerDecisionError,
} from "./ownerDecision.ts";
import {
  IssueChange,
  IssueChangeError,
  IssueChangesListInput,
  IssueChangeDecisionInput,
} from "./issueChange.ts";
import {
  IssueInboxListResult,
  IssueInboxMarkReadInput,
  IssueInboxMarkReadResult,
  IssueInboxUnread,
} from "./issueInbox.ts";
import { IssueCleanupInput, IssueCleanupError, IssueCleanupResult } from "./issueCleanup.ts";
import { IssueLinkInput, IssueLinkResult, IssueLinkError } from "./issueLinks.ts";
import {
  IssueRef,
  IssueRepositoryRef,
  IssueDetailInput,
  IssueDetailResult,
  IssueListInput,
  IssueListResult,
  IssueReadError,
  IssueRepositoriesResult,
  IssueStatusBatchInput,
  IssueStatusBatchResult,
} from "./issue.ts";
import {
  IssueWorkError,
  IssueWorkStartInput,
  IssueQueueInput,
  IssueWorkStartResult,
  IssueWorkStatusInput,
  IssueWorkStatusResult,
  RepositoryWorkInput,
  RepositoryHandoffInput,
  RepositoryOrchestratorInput,
  RepositoryWorkControlInput,
  RepositoryWorkerLimitInput,
  RepositoryReadOnlyLimitInput,
  RepositoryWorkRestoreInput,
  IssueWorkCancelInput,
  IssueWorkCloseOutInput,
  IssueWorkRequested,
  RepositoryWorkResult,
} from "./issueWork.ts";

export const ISSUE_WS_METHODS = {
  issuesRepositories: "issues.repositories",
  issuesList: "issues.list",
  issuesDetail: "issues.detail",
  issuesStatusBatch: "issues.statusBatch",
  issuesSetState: "issues.setState",
  issuesCleanup: "issues.cleanup",
  issuesUnlink: "issues.unlink",
  issuesSubscribeLinkRefreshes: "issues.subscribeLinkRefreshes",
  issuesStart: "issues.start",
  issuesQueue: "issues.queue",
  issuesUnqueue: "issues.unqueue",
  issuesWorkStatus: "issues.workStatus",
  issuesWorkMilestone: "issues.workMilestone",
  issuesRepositoryStatus: "issues.repositoryStatus",
  issuesSetPaused: "issues.setPaused",
  issuesCloseOut: "issues.closeOut",
  issuesSetWorkerLimit: "issues.setWorkerLimit",
  ownerDecisionsList: "issues.decisions.list",
  ownerDecisionsChoose: "issues.decisions.choose",
  ownerDecisionsSubscribe: "issues.decisions.subscribe",
  issuesSetReadOnlyLimit: "issues.setReadOnlyLimit",
  issueChangesList: "issues.changes.list",
  issueChangesDecide: "issues.changes.decide",
  issueChangesSubscribe: "issues.changes.subscribe",
  issuesHandoff: "issues.handoff",
  issuesAssignOrchestrator: "issues.assignOrchestrator",
  issuesCancelRequest: "issues.cancelRequest",
  issuesRestoreRoot: "issues.restoreRoot",
  issuesInboxList: "issues.inbox.list",
  issuesInboxMarkRead: "issues.inbox.markRead",
  issuesInboxSubscribeUnread: "issues.inbox.subscribeUnread",
} as const;

const IssueRpcError = Schema.Union([
  IssueReadError,
  IssueWorkError,
  IssueChangeError,
  EnvironmentAuthorizationError,
]);

const WsIssuesRepositoriesRpc = Rpc.make(ISSUE_WS_METHODS.issuesRepositories, {
  payload: Schema.Struct({}),
  success: IssueRepositoriesResult,
  error: IssueRpcError,
});

const WsIssuesSubscribeLinkRefreshesRpc = Rpc.make(ISSUE_WS_METHODS.issuesSubscribeLinkRefreshes, {
  payload: Schema.Struct({}),
  success: Schema.Number,
  stream: true,
  error: IssueRpcError,
});

const WsIssuesListRpc = Rpc.make(ISSUE_WS_METHODS.issuesList, {
  payload: IssueListInput,
  success: IssueListResult,
  error: IssueRpcError,
});

const WsIssuesDetailRpc = Rpc.make(ISSUE_WS_METHODS.issuesDetail, {
  payload: IssueDetailInput,
  success: IssueDetailResult,
  error: IssueRpcError,
});

const WsIssuesStatusBatchRpc = Rpc.make(ISSUE_WS_METHODS.issuesStatusBatch, {
  payload: IssueStatusBatchInput,
  success: IssueStatusBatchResult,
  error: IssueRpcError,
});

const WsIssuesSetStateRpc = Rpc.make(ISSUE_WS_METHODS.issuesSetState, {
  payload: Schema.Struct({ ...IssueRef.fields, state: Schema.Literals(["open", "closed"]) }),
  success: Schema.Void,
  error: IssueRpcError,
});
const WsIssuesCleanupRpc = Rpc.make(ISSUE_WS_METHODS.issuesCleanup, {
  payload: IssueCleanupInput,
  success: IssueCleanupResult,
  error: Schema.Union([IssueCleanupError, EnvironmentAuthorizationError]),
});
const WsIssuesUnlinkRpc = Rpc.make(ISSUE_WS_METHODS.issuesUnlink, {
  payload: Schema.Struct({ ...IssueLinkInput.fields, threadId: ThreadId }),
  success: IssueLinkResult,
  error: Schema.Union([IssueLinkError, EnvironmentAuthorizationError]),
});

const WsIssuesQueueRpc = Rpc.make(ISSUE_WS_METHODS.issuesQueue, {
  payload: IssueQueueInput,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});
const WsIssuesUnqueueRpc = Rpc.make(ISSUE_WS_METHODS.issuesUnqueue, {
  payload: IssueQueueInput,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});

const WsIssuesStartRpc = Rpc.make(ISSUE_WS_METHODS.issuesStart, {
  payload: IssueWorkStartInput,
  success: IssueWorkStartResult,
  error: IssueRpcError,
});

const WsIssuesWorkStatusRpc = Rpc.make(ISSUE_WS_METHODS.issuesWorkStatus, {
  payload: IssueWorkStatusInput,
  success: IssueWorkStatusResult,
  error: IssueRpcError,
});
const WsIssuesWorkMilestoneRpc = Rpc.make(ISSUE_WS_METHODS.issuesWorkMilestone, {
  payload: RepositoryWorkInput,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});
const WsIssuesRepositoryStatusRpc = Rpc.make(ISSUE_WS_METHODS.issuesRepositoryStatus, {
  payload: IssueRepositoryRef,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});
const WsIssuesSetWorkerLimitRpc = Rpc.make(ISSUE_WS_METHODS.issuesSetWorkerLimit, {
  payload: RepositoryWorkerLimitInput,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});
const WsIssuesSetReadOnlyLimitRpc = Rpc.make(ISSUE_WS_METHODS.issuesSetReadOnlyLimit, {
  payload: RepositoryReadOnlyLimitInput,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});
const WsIssuesCloseOutRpc = Rpc.make(ISSUE_WS_METHODS.issuesCloseOut, {
  payload: IssueWorkCloseOutInput,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});
const WsIssuesSetPausedRpc = Rpc.make(ISSUE_WS_METHODS.issuesSetPaused, {
  payload: RepositoryWorkControlInput,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});
const WsOwnerDecisionsListRpc = Rpc.make(ISSUE_WS_METHODS.ownerDecisionsList, {
  payload: OwnerDecisionsListInput,
  success: Schema.Array(OwnerDecision),
  error: Schema.Union([OwnerDecisionError, EnvironmentAuthorizationError]),
});
const WsOwnerDecisionsChooseRpc = Rpc.make(ISSUE_WS_METHODS.ownerDecisionsChoose, {
  payload: OwnerDecisionChooseInput,
  success: OwnerDecision,
  error: Schema.Union([OwnerDecisionError, EnvironmentAuthorizationError]),
});
const WsOwnerDecisionsSubscribeRpc = Rpc.make(ISSUE_WS_METHODS.ownerDecisionsSubscribe, {
  payload: Schema.Struct({}),
  success: Schema.Number,
  stream: true,
  error: EnvironmentAuthorizationError,
});
const WsIssueChangesListRpc = Rpc.make(ISSUE_WS_METHODS.issueChangesList, {
  payload: IssueChangesListInput,
  success: Schema.Array(IssueChange),
  error: IssueRpcError,
});
const WsIssueChangesDecideRpc = Rpc.make(ISSUE_WS_METHODS.issueChangesDecide, {
  payload: IssueChangeDecisionInput,
  success: IssueChange,
  error: IssueRpcError,
});
const WsIssueChangesSubscribeRpc = Rpc.make(ISSUE_WS_METHODS.issueChangesSubscribe, {
  payload: IssueChangesListInput,
  success: Schema.Number,
  stream: true,
  error: IssueRpcError,
});
const WsIssuesCancelRequestRpc = Rpc.make(ISSUE_WS_METHODS.issuesCancelRequest, {
  payload: IssueWorkCancelInput,
  success: IssueWorkRequested,
  error: IssueRpcError,
});
const WsIssuesRestoreRootRpc = Rpc.make(ISSUE_WS_METHODS.issuesRestoreRoot, {
  payload: RepositoryWorkRestoreInput,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});

const WsIssuesAssignOrchestratorRpc = Rpc.make(ISSUE_WS_METHODS.issuesAssignOrchestrator, {
  payload: RepositoryOrchestratorInput,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});

const WsIssuesHandoffRpc = Rpc.make(ISSUE_WS_METHODS.issuesHandoff, {
  payload: RepositoryHandoffInput,
  success: RepositoryWorkResult,
  error: IssueRpcError,
});
const WsIssuesInboxListRpc = Rpc.make(ISSUE_WS_METHODS.issuesInboxList, {
  payload: IssueRepositoryRef,
  success: IssueInboxListResult,
  error: IssueRpcError,
});
const WsIssuesInboxMarkReadRpc = Rpc.make(ISSUE_WS_METHODS.issuesInboxMarkRead, {
  payload: IssueInboxMarkReadInput,
  success: IssueInboxMarkReadResult,
  error: IssueRpcError,
});
const WsIssuesInboxSubscribeUnreadRpc = Rpc.make(ISSUE_WS_METHODS.issuesInboxSubscribeUnread, {
  payload: Schema.Struct({}),
  success: Schema.Array(IssueInboxUnread),
  stream: true,
  error: IssueRpcError,
});

export const issueRpcs = [
  WsIssuesRepositoriesRpc,
  WsIssuesListRpc,
  WsIssuesDetailRpc,
  WsIssuesStatusBatchRpc,
  WsIssuesSetStateRpc,
  WsIssuesCleanupRpc,
  WsIssuesUnlinkRpc,
  WsIssuesSubscribeLinkRefreshesRpc,
  WsIssuesStartRpc,
  WsIssuesQueueRpc,
  WsIssuesUnqueueRpc,
  WsIssuesWorkStatusRpc,
  WsIssuesWorkMilestoneRpc,
  WsIssuesRepositoryStatusRpc,
  WsIssuesSetPausedRpc,
  WsIssuesCloseOutRpc,
  WsIssuesSetWorkerLimitRpc,
  WsIssuesSetReadOnlyLimitRpc,
  WsIssuesHandoffRpc,
  WsIssuesAssignOrchestratorRpc,
  WsIssuesCancelRequestRpc,
  WsIssuesRestoreRootRpc,
  WsOwnerDecisionsListRpc,
  WsOwnerDecisionsChooseRpc,
  WsOwnerDecisionsSubscribeRpc,
  WsIssueChangesListRpc,
  WsIssueChangesDecideRpc,
  WsIssueChangesSubscribeRpc,
  WsIssuesInboxListRpc,
  WsIssuesInboxMarkReadRpc,
  WsIssuesInboxSubscribeUnreadRpc,
] as const;

export const ISSUE_CLIENT_GUARDED_RPC_SCOPES = {
  [ISSUE_WS_METHODS.issuesSetState]: AuthSourceControlWriteScope,
  [ISSUE_WS_METHODS.issuesCleanup]: AuthSourceControlWriteScope,
  [ISSUE_WS_METHODS.issuesUnlink]: AuthOrchestrationOperateScope,
  [ISSUE_WS_METHODS.issuesCloseOut]: AuthOrchestrationOperateScope,
  [ISSUE_WS_METHODS.issuesCancelRequest]: AuthOrchestrationOperateScope,
  [ISSUE_WS_METHODS.issuesRestoreRoot]: AuthOrchestrationOperateScope,
  [ISSUE_WS_METHODS.issuesAssignOrchestrator]: AuthOrchestrationOperateScope,
  [ISSUE_WS_METHODS.issuesSetWorkerLimit]: AuthOrchestrationOperateScope,
  [ISSUE_WS_METHODS.issuesSetReadOnlyLimit]: AuthOrchestrationOperateScope,
  [ISSUE_WS_METHODS.issuesQueue]: AuthOrchestrationOperateScope,
  [ISSUE_WS_METHODS.issuesUnqueue]: AuthOrchestrationOperateScope,
  [ISSUE_WS_METHODS.ownerDecisionsChoose]: AuthOrchestrationOperateScope,
  [ISSUE_WS_METHODS.issuesInboxMarkRead]: AuthOrchestrationOperateScope,
} as const;
