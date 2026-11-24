import { msg, useGT } from "gt-react";
import { m } from "~/i18n/messages";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { releaseProjectDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { readThreadShells, waitForProjectRemoval } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { readEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

/** Confirms, then removes every checkout of a grouped project and their threads. */
export function useRemoveSidebarProject(): (group: SidebarProjectSnapshot) => Promise<void> {
  const gt = useGT();
  const navigate = useNavigate();
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });

  return async (group: SidebarProjectSnapshot) => {
    const members = group.memberProjects;
    if (deniedProjectAccess(members)) return;
    const api = readLocalApi();
    if (!api) return;

    const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
    // Read at removal time: a list subscription would re-render the sidebar on every thread change.
    const projectThreads = readThreadShells().filter((thread) =>
      memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
    );
    const singleMember = members.length === 1 ? members[0]! : null;
    const targetLabel = singleMember?.title ?? group.displayName;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        [
          projectThreads.length > 0
            ? gt(
                '{count, plural, one {Remove project "{name}" and delete its {count} thread?} other {Remove project "{name}" and delete its {count} threads?}}',
                { name: targetLabel, count: projectThreads.length },
              )
            : gt('Remove project "{name}"?', { name: targetLabel }),
          ...(singleMember
            ? [
                gt("Path: {path}", { path: singleMember.workspaceRoot }),
                ...(singleMember.environmentLabel
                  ? [
                      gt("Environment: {environment}", {
                        environment: singleMember.environmentLabel,
                      }),
                    ]
                  : []),
              ]
            : [gt("This removes {count} grouped project entries.", { count: members.length })]),
          ...(projectThreads.length > 0
            ? [
                gt(
                  "This permanently clears conversation history for those threads and any archived threads.",
                ),
              ]
            : [gt("This permanently clears any archived conversation history.")]),
          gt("This removes only the project entries, not the files on disk."),
          gt("This action cannot be undone."),
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    if (deniedProjectAccess(members)) return;

    const draftStore = useComposerDraftStore.getState();
    for (const member of members) {
      if (deniedProjectAccess([member])) return;
      const memberThreads = projectThreads.filter(
        (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
      );
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, force: true },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: gt('Failed to remove "{title}"', { title: member.title }),
              description: error instanceof Error ? error.message : gt("An error occurred."),
            }),
          );
        }
        return;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      await waitForProjectRemoval(projectRef);
      releaseProjectDraftUploads(
        projectRef,
        memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(projectRef);
    }

    void navigate({ to: "/", replace: true });
  };
}

/** Reports and returns true when this connection cannot change one of the projects. */
function deniedProjectAccess(members: ReadonlyArray<SidebarProjectGroupMember>): boolean {
  const denied = members.find(
    (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
  );
  if (!denied) return false;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(msg("Failed to remove project")),
      description: denied.environmentLabel
        ? m(
            msg("This connection cannot change projects in {environment}.", {
              environment: denied.environmentLabel,
            }),
          )
        : m(msg("This connection cannot change projects in this environment.")),
    }),
  );
  return true;
}
