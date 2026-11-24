import { useGT, useMessages } from "gt-react";
import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  RepositoryIssueRef,
  RepositoryIssueSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { repositoryIssueEnvironment } from "~/state/repositoryIssues";
import { toastManager } from "../ui/toast";
import {
  handoffPrompt,
  issueComposerPrompt,
  issueImplementDestination,
  type IssueComposerAction,
} from "./issueDetailActions.logic";
import { findIssueProject } from "./issueWorktree.logic";

const lastHandoffByDraft = new Map<string, string>();

/**
 * Puts an issue prompt (ask, explain, implement) in a composer: the thread beside the panel, the
 * repository orchestrator for implement, or a new draft in the issue's project.
 */
export function useIssueComposerHandoff({
  environmentId,
  reference,
  issue,
  threadRef,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: RepositoryIssueRef;
  readonly issue: Pick<RepositoryIssueSummary, "number" | "title" | "url" | "parent">;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const projects = useProjects();
  const thread = useThreadShell(threadRef);
  const navigate = useNavigate();
  const configs = useServerConfigs();
  const capabilities = configs.get(environmentId)?.environment.capabilities;
  const { data: repositoryWork } = useEnvironmentQuery(
    capabilities?.issueMilestones === true
      ? repositoryIssueEnvironment.repositoryStatus({
          environmentId,
          input: { host: reference.host, repository: reference.repository },
        })
      : null,
  );
  const implementation = issueImplementDestination(
    {
      environmentId,
      rootThreadId: repositoryWork?.rootThreadId,
      hasParent: issue.parent != null,
      paused: repositoryWork?.phase === "draining",
    },
    resolve,
  );
  const project = findIssueProject(
    projects,
    { environmentId, ...reference },
    thread?.projectId ?? null,
  );
  const handleNewThread = useNewThreadHandler();
  const [pending, setPending] = useState(false);
  const paste = async (action: IssueComposerAction) => {
    setPending(true);
    try {
      const opened =
        action !== "implement" && threadRef === null && project !== null
          ? await handleNewThread(scopeProjectRef(project.environmentId, project.id))
          : null;
      const target =
        action === "implement" ? implementation.threadRef : (threadRef ?? opened?.draftId);
      if (!target) {
        toastManager.add({
          type: "error",
          title: gt("Could not prepare the composer"),
          description:
            implementation.disabledReason && action === "implement"
              ? implementation.disabledReason
              : gt("Add a project for this repository to open a thread."),
        });
        setPending(false);
        return;
      }
      const store = useComposerDraftStore.getState();
      const key = typeof target === "string" ? `draft:${target}` : scopedThreadKey(target);
      const prompt = issueComposerPrompt(action, issue);
      store.setPrompt(
        target,
        handoffPrompt(
          {
            prompt: store.getComposerDraft(target)?.prompt ?? "",
            lastHandoffPrompt: lastHandoffByDraft.get(key),
          },
          prompt,
        ),
      );
      lastHandoffByDraft.set(key, prompt);
      if (
        action === "implement" &&
        typeof target !== "string" &&
        (target.environmentId !== threadRef?.environmentId ||
          target.threadId !== threadRef?.threadId)
      ) {
        await navigate({ to: "/$environmentId/$threadId", params: target });
      }
      toastManager.add({
        type: "success",
        title: gt("Added to the composer"),
        description: gt("Read it over, then send."),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Could not prepare the composer"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
    setPending(false);
  };
  return {
    paste,
    pending,
    implementation,
    /** A thread beside the panel, or a project to open one in. */
    hasComposer: threadRef !== null || project !== null,
  };
}
