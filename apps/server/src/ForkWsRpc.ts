import { NOTEBOOK_METHODS } from "@t3tools/contracts";
import * as NotebookService from "./notebook/NotebookService.ts";
/**
 * WebSocket handlers for the fork's own RPCs (`ForkWsRpcGroup`): issues, issue work, issue
 * changes and background-task output. This module joins them with upstream handlers for `ws.ts`.
 */
import {
  PROJECT_ARTIFACT_METHODS,
  ForkWsRpcGroup,
  UpstreamWsRpcGroup,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectArtifacts from "./project/ProjectArtifacts.ts";
import * as SidebarLayout from "./sidebarLayout.ts";
import type * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as OwnerDecisions from "./issues/OwnerDecisions.ts";
import * as IssueCleanup from "./issues/IssueCleanup.ts";
import * as IssueChangeService from "./issues/IssueChangeService.ts";
import * as IssueLinks from "./issues/IssueLinks.ts";
import * as IssueInbox from "./issues/IssueInbox.ts";
import * as IssueRoadmap from "./issues/IssueRoadmap.ts";
import * as IssueService from "./issues/IssueService.ts";
import * as IssueWorkService from "./issues/IssueWorkService.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import * as ThreadWorkspaceService from "./orchestration-v2/ThreadWorkspaceService.ts";
import * as BackgroundTasks from "./orchestration-v2/backgroundTaskOutput.ts";
import { InlineShellRuns } from "./terminal/InlineShellRuns.ts";

const UpstreamServerWsRpcGroup = UpstreamWsRpcGroup.middleware(RpcInstrumentation);

export const upstreamWsRpcHandlers = UpstreamServerWsRpcGroup.of;

export const layerWsRpcWithFork = <Services, E, R>(
  currentSession: EnvironmentAuth.AuthenticatedSession,
  handlers: Effect.Effect<Context.Context<Services>, E, R>,
) => Layer.merge(Layer.effectContext(handlers), layerForkWsRpc(currentSession));

const layerForkWsRpc = (currentSession: EnvironmentAuth.AuthenticatedSession) =>
  ForkWsRpcGroup.middleware(RpcInstrumentation).toLayer(
    Effect.gen(function* () {
      const backgroundTasks = yield* BackgroundTasks.BackgroundTasks.pipe(
        Effect.provide(BackgroundTasks.layer),
      );
      const inlineShell = yield* InlineShellRuns;
      const workspace = yield* ThreadWorkspaceService.ThreadWorkspaceService;
      const issues = yield* IssueService.IssueService;
      const issueLinks = yield* IssueLinks.IssueLinks;
      const cleanup = yield* IssueCleanup.IssueCleanup;
      const roadmap = yield* IssueRoadmap.IssueRoadmap;
      const issueWork = yield* IssueWorkService.IssueWorkService;
      const issueChanges = yield* IssueChangeService.IssueChangeService;
      const sidebarLayout = yield* SidebarLayout.SidebarLayoutService;
      const decisions = yield* OwnerDecisions.OwnerDecisions;
      const inbox = yield* IssueInbox.IssueInbox;
      const artifacts = yield* ProjectArtifacts.ProjectArtifacts;
      const notebook = yield* NotebookService.NotebookService;
      return {
        [NOTEBOOK_METHODS.save]: (input) => notebook.save(input, currentSession),
        [NOTEBOOK_METHODS.edit]: (input) => notebook.edit(input, currentSession),
        [NOTEBOOK_METHODS.create]: (input) => notebook.create(input, currentSession),
        [NOTEBOOK_METHODS.acquire]: (input) => notebook.acquire(input, currentSession),
        [NOTEBOOK_METHODS.close]: (input) => notebook.close(input, currentSession),
        [NOTEBOOK_METHODS.open]: (input) => notebook.open(input, currentSession),
        [NOTEBOOK_METHODS.snapshot]: (input) => notebook.snapshot(input, currentSession),
        [NOTEBOOK_METHODS.execute]: (input) => notebook.execute(input, currentSession),
        [NOTEBOOK_METHODS.interrupt]: (input) => notebook.interrupt(input, currentSession),
        [NOTEBOOK_METHODS.restart]: (input) => notebook.restart(input, currentSession),
        [NOTEBOOK_METHODS.shutdown]: (input) => notebook.shutdown(input, currentSession),
        [NOTEBOOK_METHODS.subscribe]: (input) => notebook.subscribe(input, currentSession),
        [PROJECT_ARTIFACT_METHODS.list]: (input) => artifacts.list(input.projectId),
        [PROJECT_ARTIFACT_METHODS.add]: (input) => artifacts.add(input, "user"),
        [PROJECT_ARTIFACT_METHODS.remove]: (input) => artifacts.remove(input),
        [PROJECT_ARTIFACT_METHODS.move]: (input) => artifacts.move(input),
        [PROJECT_ARTIFACT_METHODS.update]: (input) => artifacts.update(input),
        [PROJECT_ARTIFACT_METHODS.renameSection]: (input) => artifacts.renameSection(input),
        [PROJECT_ARTIFACT_METHODS.reorderSections]: (input) => artifacts.reorderSections(input),
        [PROJECT_ARTIFACT_METHODS.subscribe]: (input) => artifacts.subscribe(input.projectId),
        [WS_METHODS.sidebarLayoutUpdate]: (input) => sidebarLayout.update(input),
        [WS_METHODS.subscribeSidebarLayout]: () => sidebarLayout.stream,
        [WS_METHODS.terminalRunInline]: (input) => inlineShell.run(input),
        [WS_METHODS.terminalGetInlineRun]: (input) => inlineShell.latest(input),
        [WS_METHODS.terminalWatchInlineRun]: (input) => inlineShell.observe(input),
        [WS_METHODS.worktreeReturnToRoot]: (input) =>
          workspace.returnToRoot(input.threadId, input, {
            createdBy: "user",
            creationSource: "web",
          }),
        [WS_METHODS.serverGetBackgroundTaskResourceUsage]: (input) =>
          backgroundTasks.resourceUsage(input),
        [WS_METHODS.serverGetThreadProcesses]: (input) => backgroundTasks.processes(input),
        [ORCHESTRATION_V2_WS_METHODS.stopBackgroundTask]: (input) => backgroundTasks.stop(input),
        [ORCHESTRATION_V2_WS_METHODS.subscribeBackgroundTaskOutput]: (input) =>
          Stream.unwrap(backgroundTasks.subscribeOutput(input)),
        [WS_METHODS.issuesQueue]: (input) => issueWork.queueIssue(input),
        [WS_METHODS.issuesUnqueue]: (input) => issueWork.unqueueIssue(input),
        [WS_METHODS.issuesStart]: (input) => issueWork.start(input),
        [WS_METHODS.issuesWorkStatus]: (input) => issueWork.workStatus(input),
        [WS_METHODS.issuesWorkMilestone]: (input) => issueWork.workMilestone(input),
        [WS_METHODS.issuesRepositoryStatus]: (input) => issueWork.repositoryStatus(input),
        [WS_METHODS.issuesCloseOut]: (input) => issueWork.closeOut(input),
        [WS_METHODS.issuesSetPaused]: (input) => issueWork.setPaused(input),
        [WS_METHODS.issuesSetWorkerLimit]: (input) => issueWork.setWorkerLimit(input),
        [WS_METHODS.issuesSetReadOnlyLimit]: (input) => issueWork.setReadOnlyLimit(input),
        [WS_METHODS.issuesCancelRequest]: (input) => issueWork.cancelRequest(input),
        [WS_METHODS.issuesRestoreRoot]: (input) => issueWork.restoreRoot(input),
        [WS_METHODS.issuesHandoff]: (input) => issueWork.handoff(input),
        [WS_METHODS.ownerDecisionsList]: (input) => decisions.list(input),
        [WS_METHODS.ownerDecisionsSubscribe]: () => decisions.changes,
        [WS_METHODS.ownerDecisionsChoose]: (input) =>
          decisions.choose(input, {
            kind: "user",
            subject: currentSession.subject,
            scopes: currentSession.scopes,
          }),
        [WS_METHODS.issuesAssignOrchestrator]: (input) => issueWork.assignOrchestrator(input),
        [WS_METHODS.issueChangesList]: (input) => issueChanges.list(input),
        [WS_METHODS.issueChangesSubscribe]: (input) => issueChanges.subscribe(input),
        [WS_METHODS.issueChangesDecide]: (input) =>
          issueChanges.decide(input, {
            kind: "user",
            subject: currentSession.subject,
            scopes: currentSession.scopes,
          }),
        [WS_METHODS.issuesRepositories]: () => issues.repositories(),
        [WS_METHODS.issuesList]: (input) => roadmap.list(input),
        [WS_METHODS.issuesCleanup]: (input) => cleanup.cleanup(input),
        [WS_METHODS.issuesSetState]: (input) => issues.setState(input),
        [WS_METHODS.issuesUnlink]: (input) => issueLinks.link(input, undefined, true),
        [WS_METHODS.issuesDetail]: (input) => roadmap.detail(input),
        [WS_METHODS.issuesStatusBatch]: (input) => roadmap.statusBatch(input),
        [WS_METHODS.issuesSubscribeLinkRefreshes]: () => roadmap.linkRefreshes,
        [WS_METHODS.issuesInboxList]: (input) => inbox.list(input),
        [WS_METHODS.issuesInboxMarkRead]: (input) => inbox.markRead(input),
        [WS_METHODS.issuesInboxSubscribeUnread]: () => inbox.unread,
      };
    }),
  );
