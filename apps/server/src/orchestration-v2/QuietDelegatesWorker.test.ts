import { it } from "@effect/vitest";
import { OrchestrationV2ThreadShellJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

import { Scheduler } from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { workerLive } from "./QuietDelegatesWorker.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const decodeShell = Schema.decodeSync(OrchestrationV2ThreadShellJson);

it.effect("wakes the parent once per quiet stretch", () =>
  Effect.gen(function* () {
    const child = decodeShell({
      createdBy: "agent",
      creationSource: "server",
      id: "child",
      projectId: "project",
      title: "Worker",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      lineage: {
        parentThreadId: "parent",
        rootThreadId: "parent",
        relationshipToParent: "subagent",
      },
      forkedFrom: null,
      latestRunId: "run",
      activeRunId: "run",
      status: "running",
      lastProviderActivityAt: 0,
      activeProviderThreadId: null,
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      branch: null,
      worktreePath: null,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: "1970-01-01T00:00:00Z",
      updatedAt: "1970-01-01T00:00:00Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    });
    let latestActivityAt = 0;
    let sweep = Effect.void;
    const dispatch = vi.fn<ThreadManagementService["Service"]["dispatch"]>(() =>
      Effect.succeed({ sequence: 1, storedEvents: [] }),
    );
    yield* Layer.build(
      workerLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(Scheduler)({
              register: (_name, work) =>
                Effect.context<Effect.Services<typeof work>>().pipe(
                  Effect.tap((context) =>
                    Effect.sync(() => {
                      sweep = work.pipe(Effect.provideContext(context), Effect.orDie);
                    }),
                  ),
                  Effect.asVoid,
                ),
            }),
            Layer.mock(ProjectionStoreV2)({
              getShellSnapshot: () =>
                Effect.sync(() => ({
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  threads: [{ ...child, lastProviderActivityAt: latestActivityAt }],
                  archivedThreads: [],
                })),
            }),
            Layer.mock(ThreadManagementService)({ dispatch }),
            ServerSettings.layerTest({}),
          ),
        ),
      ),
    );
    yield* TestClock.setTime(599_999);
    yield* sweep;
    expect(dispatch).toHaveBeenCalledTimes(0);
    yield* TestClock.setTime(600_000);
    yield* sweep;
    yield* sweep;
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        threadId: "parent",
        type: "message.dispatch",
        dispatchMode: { type: "queue_after_active" },
      }),
    );
    latestActivityAt = 600_001;
    yield* TestClock.setTime(latestActivityAt);
    yield* sweep;
    expect(dispatch).toHaveBeenCalledTimes(1);
    yield* TestClock.setTime(latestActivityAt + 600_000);
    yield* sweep;
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0].commandId).not.toBe(dispatch.mock.calls[1]?.[0].commandId);
  }),
);
