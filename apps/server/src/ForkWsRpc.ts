/**
 * WebSocket handlers for the fork's own RPCs (`ForkWsRpcGroup`): issues, issue work, issue
 * changes and background-task output. `ws.ts` merges this layer next to upstream's handlers.
 */
import { ForkWsRpcGroup, ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as SidebarLayout from "./sidebarLayout.ts";
import type * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as IssueChangeService from "./issues/IssueChangeService.ts";
import * as IssueRoadmap from "./issues/IssueRoadmap.ts";
import * as IssueService from "./issues/IssueService.ts";
import * as IssueWorkService from "./issues/IssueWorkService.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import * as ThreadWorkspaceService from "./orchestration-v2/ThreadWorkspaceService.ts";
import * as BackgroundTasks from "./orchestration-v2/backgroundTaskOutput.ts";
import { InlineShellRuns } from "./terminal/InlineShellRuns.ts";

export const layerForkWsRpc = (currentSession: EnvironmentAuth.AuthenticatedSession) =>
  ForkWsRpcGroup.middleware(RpcInstrumentation).toLayer(
    Effect.gen(function* () {
      const backgroundTasks = yield* BackgroundTasks.BackgroundTasks.pipe(
        Effect.provide(BackgroundTasks.layer),
      );
      const inlineShell = yield* InlineShellRuns;
      const workspace = yield* ThreadWorkspaceService.ThreadWorkspaceService;
      const issues = yield* IssueService.IssueService;
      const roadmap = yield* IssueRoadmap.IssueRoadmap;
      const issueWork = yield* IssueWorkService.IssueWorkService;
      const issueChanges = yield* IssueChangeService.IssueChangeService;
      const sidebarLayout = yield* SidebarLayout.SidebarLayoutService;
      return {
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
        [WS_METHODS.terminalFollowBackgroundTask]: (input) =>
          backgroundTasks.followInTerminal(input),
        [ORCHESTRATION_V2_WS_METHODS.stopBackgroundTask]: (input) => backgroundTasks.stop(input),
        [ORCHESTRATION_V2_WS_METHODS.subscribeBackgroundTaskOutput]: (input) =>
          Stream.unwrap(backgroundTasks.subscribeOutput(input)),
        [WS_METHODS.issuesStart]: (input) => issueWork.start(input),
        [WS_METHODS.issuesWorkStatus]: (input) => issueWork.workStatus(input),
        [WS_METHODS.issuesWorkMilestone]: (input) => issueWork.workMilestone(input),
        [WS_METHODS.issuesRepositoryStatus]: (input) => issueWork.repositoryStatus(input),
        [WS_METHODS.issuesSetPaused]: (input) => issueWork.setPaused(input),
        [WS_METHODS.issuesCancelRequest]: (input) => issueWork.cancelRequest(input),
        [WS_METHODS.issuesRestoreRoot]: (input) => issueWork.restoreRoot(input),
        [WS_METHODS.issuesHandoff]: (input) => issueWork.handoff(input),
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
        [WS_METHODS.issuesDetail]: (input) => issues.detail(input),
      };
    }),
  );
