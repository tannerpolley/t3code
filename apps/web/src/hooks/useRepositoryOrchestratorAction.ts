import { useAtomValue } from "@effect/atom-react";
import { threadIssueRepository } from "@t3tools/client-runtime/state/issue-work";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CommandId,
  isRepositoryOrchestratorEligible,
  type ContextMenuItem,
  type RepositoryWorkResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { useEnvironmentProviders } from "~/state/environments";
import { useProjects, useServerConfigs } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { randomUUID } from "~/lib/utils";
import { toastManager } from "~/components/ui/toast";

export function useRepositoryOrchestratorAction(
  activeThread: EnvironmentThreadShell | null = null,
) {
  const projects = useProjects();
  const configs = useServerConfigs();
  const providers = useEnvironmentProviders();
  const targetFor = (thread: EnvironmentThreadShell | null) => {
    if (
      thread === null ||
      configs.get(thread.environmentId)?.environment.capabilities.issueWork !== true
    )
      return null;
    const project = projects.find(
      (project) =>
        project.id === thread.projectId && project.environmentId === thread.environmentId,
    );
    const repository = threadIssueRepository(project?.repositoryIdentity);
    return repository === null ||
      project === undefined ||
      !isRepositoryOrchestratorEligible(
        thread.source,
        providers
          .get(thread.environmentId)
          ?.find((provider) => provider.instanceId === thread.modelSelection.instanceId)?.driver,
        { ...repository, projectId: project.id },
      )
      ? null
      : { thread, repository };
  };
  const activeTarget = targetFor(activeThread);
  const activeStatus = useEnvironmentQuery(
    activeTarget === null
      ? null
      : issueEnvironment.repositoryStatus({
          environmentId: activeTarget.thread.environmentId,
          input: activeTarget.repository,
        }),
  );
  useAtomValue(
    issueEnvironment.assignOrchestrator.permissionAtom(activeThread?.environmentId ?? null),
  );
  const actionFor = (
    target: NonNullable<ReturnType<typeof targetFor>>,
    status: RepositoryWorkResult | null,
  ) => {
    const { thread, repository } = target;
    const current = status?.rootThreadId === thread.id;
    const item: ContextMenuItem<"make-repository-orchestrator"> = {
      id: "make-repository-orchestrator",
      label: current ? "Repository orchestrator (current)" : "Make repository orchestrator",
      disabled:
        current ||
        status === null ||
        !appAtomRegistry.get(
          issueEnvironment.assignOrchestrator.permissionAtom(thread.environmentId),
        ),
    };
    return {
      item,
      run: async () => {
        const result = await issueEnvironment.assignOrchestrator.run(appAtomRegistry, {
          environmentId: thread.environmentId,
          input: {
            ...repository,
            projectId: thread.projectId,
            targetThreadId: thread.id,
            clientRequestId: CommandId.make(randomUUID()),
          },
        });
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "Could not assign repository orchestrator",
            description: formatEnvironmentQueryError(result.cause),
          });
          return;
        }
        toastManager.add({
          type: "success",
          title:
            result.value.rootThreadId === thread.id
              ? "Repository orchestrator assigned"
              : "Repository handoff is draining live work",
        });
      },
    };
  };
  return {
    active: activeTarget === null ? null : actionFor(activeTarget, activeStatus.data),
    forThread: async (thread: EnvironmentThreadShell) => {
      const target = targetFor(thread);
      if (target === null) return null;
      const atom = issueEnvironment.repositoryStatus({
        environmentId: thread.environmentId,
        input: target.repository,
      });
      const status = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* AtomRegistry.mount(appAtomRegistry, atom);
            return yield* AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true });
          }),
        ).pipe(Effect.timeout(2_000), Effect.option),
      );
      return actionFor(target, status._tag === "Some" ? status.value : null);
    },
  };
}
