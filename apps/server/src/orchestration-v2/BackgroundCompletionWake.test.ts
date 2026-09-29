import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationV2Command,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerSettingsService } from "../serverSettings.ts";
import { workerLive } from "./BackgroundCompletionWake.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const THREAD = ThreadId.make("thread:engine-161-papers");
const START_MS = Date.parse("2026-09-29T17:25:13.380Z");

type Task = OrchestrationV2PendingBackgroundTask;
type DispatchedWake = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const compare: Task = { taskId: "b2vqhgpgg", description: "Wait for compare reruns" };
const calibrated: Task = {
  taskId: "bggh8r4aa",
  description: "Wait for calibrated rerun then start chloride.py",
};

interface Run {
  readonly status: string;
  readonly requestedAtMs: number;
}

/**
 * The worker against a scripted projection: tests set what the shell lists and which runs exist,
 * then publish the events that changed it. Every shell read is a receipt that one event was
 * checked.
 */
const makeHarness = Effect.fn("makeBackgroundWakeHarness")(function* (options?: {
  readonly seededTasks?: ReadonlyArray<Task>;
  readonly continueAfterRestart?: boolean;
}) {
  const state = {
    pending: [...(options?.seededTasks ?? [])] as ReadonlyArray<Task>,
    activityRunStatus: null as string | null,
    runs: [{ status: "completed", requestedAtMs: START_MS - 90_000 }] as Array<Run>,
    shellReads: 0,
    dispatched: [] as Array<DispatchedWake>,
  };
  const streams = {
    "run.updated": yield* Queue.unbounded<OrchestrationV2StoredEvent>(),
    "provider-thread.updated": yield* Queue.unbounded<OrchestrationV2StoredEvent>(),
    "turn-item.updated": yield* Queue.unbounded<OrchestrationV2StoredEvent>(),
  };
  let sequence = 0;
  const layer = workerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(EventSinkV2)({
          latestSequence: () => Effect.succeed(0),
          stream: (input) => Stream.fromQueue(streams[input!.eventType as keyof typeof streams]),
        }),
        Layer.mock(ProjectionStoreV2)({
          getRecoveryThreadIds: () =>
            Effect.succeed(options?.seededTasks === undefined ? [] : [THREAD]),
          getThreadShell: () =>
            Effect.sync(() => {
              state.shellReads++;
              return {
                activityRunStatus: state.activityRunStatus,
                pendingBackgroundTasks: state.pending,
              } as never;
            }),
        }),
        Layer.mock(ThreadManagementService)({
          getThreadRecords: (() =>
            Effect.sync(() => ({
              thread: {
                id: THREAD,
                projectId: ProjectId.make("project:epc-saft"),
                archivedAt: null,
                deletedAt: null,
                settledAt: null,
              },
              runs: state.runs.map((run) => ({
                status: run.status,
                requestedAt: DateTime.makeUnsafe(run.requestedAtMs),
              })),
              subagents: [],
              providerSessions: [{ status: "ready" }],
            }))) as unknown as ThreadManagementService["Service"]["getThreadRecords"],
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type !== "message.dispatch") throw new Error(command.type);
              // Receipts make a repeated command id a no-op.
              if (!state.dispatched.some((wake) => wake.commandId === command.commandId)) {
                state.dispatched.push(command);
              }
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            continueThreadsAfterServerUpdate: options?.continueAfterRestart ?? true,
          }),
        }),
      ),
    ),
  );
  yield* Layer.build(layer);

  const publish = Effect.fn("publish")(function* (
    type: keyof typeof streams,
    payload: Record<string, unknown>,
    commandId: string | null = null,
  ) {
    const reads = state.shellReads;
    yield* Queue.offer(streams[type], {
      sequence: ++sequence,
      commandId,
      event: {
        type,
        threadId: THREAD,
        occurredAt: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
        payload,
      },
    } as unknown as OrchestrationV2StoredEvent);
    return reads;
  });
  const awaitUntil = (predicate: () => boolean, label: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 5000; attempt++) {
        if (predicate()) return;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(`Timed out waiting for ${label}.`);
    });
  /** Publishes an event and waits for the worker to check the thread against it. */
  const publishChecked = (
    type: keyof typeof streams,
    payload: Record<string, unknown>,
    commandId?: string,
  ) =>
    publish(type, payload, commandId).pipe(
      Effect.flatMap((reads) => awaitUntil(() => state.shellReads > reads, `${type} checked`)),
    );
  /** Publishes an event the worker handles without reading the thread. */
  const publishUnchecked = (type: keyof typeof streams, payload: Record<string, unknown>) =>
    publish(type, payload).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          for (let quiet = 0; quiet < 200; quiet++) yield* Effect.yieldNow;
        }),
      ),
    );
  /** The roster changing, as the provider reported it. */
  const rosterIs = (tasks: ReadonlyArray<Task>, commandId?: string) => {
    state.pending = tasks;
    return publishChecked("provider-thread.updated", { pendingBackgroundTasks: tasks }, commandId);
  };
  /** Lets the grace window pass and any wake it scheduled run. */
  const passGrace = Effect.gen(function* () {
    yield* TestClock.adjust("90 seconds");
    for (let quiet = 0; quiet < 200; quiet++) yield* Effect.yieldNow;
  });
  return { state, publish, publishChecked, publishUnchecked, rosterIs, passGrace, awaitUntil };
});

describe("BackgroundCompletionWake", () => {
  it.effect("wakes an idle agent once for a burst the provider never reported", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START_MS);
      const harness = yield* makeHarness();
      // Run #4 ends with both tasks pending; one was started by a native subagent.
      const subagentShell = { ...calibrated, childThreadId: ThreadId.make("thread:subagent") };
      harness.state.pending = [compare, subagentShell];
      yield* harness.publishChecked("run.updated", { status: "completed" });

      // 16 minutes later both finish 5 s apart, and the idle disconnect ends the session.
      yield* TestClock.adjust("16 minutes");
      yield* harness.rosterIs([subagentShell]);
      yield* TestClock.adjust("5 seconds");
      yield* harness.rosterIs([]);
      assert.lengthOf(harness.state.dispatched, 0);

      yield* harness.passGrace;
      assert.lengthOf(harness.state.dispatched, 1);
      const wake = harness.state.dispatched[0]!;
      assert.equal(wake.commandId, `server:background-wake:${THREAD}:${compare.taskId}`);
      assert.include(wake.text, compare.taskId);
      assert.include(wake.text, calibrated.taskId);
      assert.deepEqual(wake.notification?.source, { kind: "background_task" });
      assert.equal(wake.creationSource, "server");

      // A replayed roster update owes nothing more.
      yield* harness.publishUnchecked("provider-thread.updated", { pendingBackgroundTasks: [] });
      yield* harness.passGrace;
      assert.lengthOf(harness.state.dispatched, 1);
    }),
  );

  it.effect("stays out of the way when the provider wakes the agent itself", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START_MS);
      const harness = yield* makeHarness();
      harness.state.pending = [compare];
      yield* harness.publishChecked("run.updated", { status: "completed" });
      yield* TestClock.adjust("16 minutes");
      yield* harness.rosterIs([]);

      // Claude's wake turn becomes a continuation run a few seconds later.
      yield* TestClock.adjust("7 seconds");
      harness.state.runs.push({
        status: "running",
        requestedAtMs: yield* Clock.currentTimeMillis,
      });
      harness.state.activityRunStatus = "running";
      yield* harness.publishChecked("run.updated", { status: "running" });

      yield* harness.passGrace;
      assert.lengthOf(harness.state.dispatched, 0);
    }),
  );

  it.effect("owes nothing for a monitor ending or for work the user stopped", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START_MS);
      const harness = yield* makeHarness();
      const monitor: Task = { taskId: "bfscpwrr6", taskType: "monitor" };
      harness.state.pending = [monitor, compare];
      yield* harness.publishChecked("run.updated", { status: "completed" });
      yield* harness.rosterIs([compare]);
      yield* harness.passGrace;
      assert.lengthOf(harness.state.dispatched, 0);

      yield* harness.publishUnchecked("turn-item.updated", { type: "run_interrupt_request" });
      harness.state.pending = [];
      yield* harness.publishUnchecked("provider-thread.updated", { pendingBackgroundTasks: [] });
      yield* harness.passGrace;
      assert.lengthOf(harness.state.dispatched, 0);
    }),
  );

  it.effect("wakes a Codex agent whose background command item ended while idle", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START_MS);
      const harness = yield* makeHarness();
      const command: Task = { taskId: "call-build", taskType: "command_execution" };
      harness.state.pending = [command];
      yield* harness.publishChecked("run.updated", { status: "completed" });
      harness.state.pending = [];
      yield* harness.publishChecked("turn-item.updated", { type: "command_execution" });
      yield* harness.passGrace;
      assert.lengthOf(harness.state.dispatched, 1);
    }),
  );

  it.effect.each([true, false])(
    "after a restart, tells the agent its work stopped only when continuing is on (%s)",
    (continueAfterRestart) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(START_MS);
        // The server stopped while the agent waited on a live session's shell.
        const harness = yield* makeHarness({ seededTasks: [compare], continueAfterRestart });
        yield* harness.rosterIs([], "command:runtime-reconcile:startup:thread:1");
        yield* harness.passGrace;
        assert.lengthOf(harness.state.dispatched, continueAfterRestart ? 1 : 0);
        if (continueAfterRestart) {
          assert.include(harness.state.dispatched[0]!.text, "stopped when T3 restarted");
        }
      }),
  );
});
