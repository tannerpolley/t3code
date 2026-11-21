import type {
  OrchestrationV2AppThread,
  OrchestrationV2SkillPreload,
  ThreadRole,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as IssueService from "../issue/IssueService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import { delegatedSkillRole, resolveRoleSkillSelection } from "../provider/roleSkills.ts";
import { prepareSkillPreload } from "../provider/skillPreload.ts";
import { withInlineContext } from "./ContextHandoffDelivery.ts";
import * as EventSink from "./EventSink.ts";

export const makeRoleSkillTurn = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const projects = yield* ProjectService.ProjectService;
  const projectFiles = yield* T3ProjectFileLoader.make;
  const issues = Option.getOrUndefined(yield* Effect.serviceOption(IssueService.IssueService));
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const selectForExistingThread = Effect.fn("RoleSkillDelivery.selectForExistingThread")(function* (
    thread: OrchestrationV2AppThread,
    role: ThreadRole,
    brief: string,
  ) {
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.catch(() => Effect.succeedNone));
    if (Option.isNone(project)) return null;
    return yield* resolveRoleSkillSelection({
      projectId: thread.projectId,
      workspaceRoot: project.value.workspaceRoot,
      projectFiles,
      issues,
      issueRefs: thread.issues ?? [],
      role,
      brief,
    });
  });

  return Effect.fn("RoleSkillDelivery.startTurn")(
    function* (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      input: ProviderAdapter.ProviderAdapterV2TurnInput,
      brief: string,
      refusedBeforePrompt: (error: unknown) => boolean,
    ) {
      const { appThread, attemptId, threadId, runId, modelSelection, runtimePolicy } = input;
      const role = delegatedSkillRole(appThread);
      const catalogueForCwd = session.installedSkillsForPreload;
      if (role === undefined || catalogueForCwd === undefined || runtimePolicy.cwd === null) {
        return yield* session.startTurn(input);
      }
      const selection =
        appThread.roleSkillSelection === undefined
          ? yield* selectForExistingThread(appThread, role, brief)
          : appThread.roleSkillSelection;
      if (selection === null) return yield* session.startTurn(input);
      const { requests, issueLookupFailed } = selection;
      if (requests.length === 0 && issueLookupFailed === undefined)
        return yield* session.startTurn(input);
      const catalogue = requests.length === 0 ? [] : yield* catalogueForCwd(runtimePolicy.cwd);
      const { context, skills } = yield* prepareSkillPreload(requests, catalogue).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const event = Effect.fn("RoleSkillDelivery.makeEvent")(function* (
        records: OrchestrationV2SkillPreload["skills"],
      ) {
        return {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "run-attempt.skill-preload-recorded" as const,
          threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: yield* DateTime.now,
          payload: {
            attemptId,
            record: {
              skills: records,
              ...(issueLookupFailed === undefined ? {} : { issueLookupFailed }),
            },
          },
        };
      });
      // A lost acknowledgement leaves the durable delivery outcome unknown.
      const stored = yield* eventSink.writeIfRunCurrent({
        threadId,
        runId,
        activeAttemptId: attemptId,
        expectedStatus: "running",
        events: [yield* event(skills)],
      });
      if (!stored.committed) return;
      if (context === "") return yield* session.startTurn(input);

      const recordDelivery = (outcome: "loaded" | "refused") =>
        event(
          skills.map((skill) =>
            skill.outcome !== "delivery_unknown"
              ? skill
              : outcome === "loaded"
                ? { ...skill, outcome: "loaded" }
                : { ...skill, outcome: "skipped", reason: "delivery_refused" },
          ),
        ).pipe(
          Effect.flatMap((event) => eventSink.write({ events: [event] })),
          Effect.catch(() => Effect.logWarning("Failed to record role skill delivery", { runId })),
        );
      const text = withInlineContext(context, input.message.text);
      yield* session
        .startTurn({
          ...input,
          message: { ...input.message, text },
          inlineContextLength:
            (input.inlineContextLength ?? 0) + text.length - input.message.text.length,
        })
        .pipe(
          Effect.tap(() => recordDelivery("loaded")),
          Effect.tapError((error) =>
            refusedBeforePrompt(error) ? recordDelivery("refused") : Effect.void,
          ),
        );
    },
    (effect, session, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProviderAdapterTurnStartError"
            ? cause
            : new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: input.threadId,
                providerThreadId: input.providerThread.id,
                runId: input.runId,
                cause,
              }),
        ),
      ),
  );
});
