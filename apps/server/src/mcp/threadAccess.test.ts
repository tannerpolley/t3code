import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it } from "vite-plus/test";

import {
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { readThread, readWritableThread } from "./threadAccess.ts";

const callerId = ThreadId.make("thread-access-caller");
const otherId = ThreadId.make("thread-access-other");
const callerProjectId = ProjectId.make("project-access-caller");
const otherProjectId = ProjectId.make("project-access-other");
const instanceId = ProviderInstanceId.make("codex");

const shell = (id: ThreadId, projectId: ProjectId) =>
  ({
    id,
    projectId,
    providerInstanceId: instanceId,
    runtimeMode: "full-access",
    interactionMode: "default",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    activeRunId: "run-active",
    archivedAt: null,
    deletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const shells = new Map([
  [callerId, shell(callerId, callerProjectId)],
  [otherId, shell(otherId, otherProjectId)],
]);

it("the cross-project read allowance reaches reads but never writes", async () => {
  const program = Effect.gen(function* () {
    const read = yield* readThread(otherId);
    expect(read.projection.thread.projectId).toBe(otherProjectId);
    const write = yield* readWritableThread(otherId).pipe(Effect.flip);
    expect(write.code).toBe("thread_not_found");
  });

  await program.pipe(
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-access"),
      threadId: callerId,
      providerSessionId: "provider-session-access",
      providerInstanceId: instanceId,
      capabilities: new Set(["orchestration"] as const),
      issuedAt: 1,
    }),
    Effect.provideService(ThreadManagementService, {
      getThreadShell: (threadId: ThreadId) => Effect.succeed(shells.get(threadId) ?? null),
      getProjectThreadRecords: (input: { projectId: ProjectId; threadId: ThreadId }) => {
        const thread = shells.get(input.threadId);
        return thread?.projectId === input.projectId
          ? Effect.succeed({ thread })
          : Effect.fail(new ThreadManagementThreadNotFoundError(input));
      },
    } as unknown as ThreadManagementService["Service"]),
    Effect.provideService(ServerSettingsService, {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        topLevelThreadsReadAllProjects: true,
      }),
    } as unknown as ServerSettingsService["Service"]),
    Effect.runPromise,
  );
});
