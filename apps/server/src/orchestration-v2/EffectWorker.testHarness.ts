import {
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueChangeService from "../issues/IssueChangeService.ts";
import * as ServerSettings from "../serverSettings.ts";

const threadId = ThreadId.make("thread:effect-worker-restart");

const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");

const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");

const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");

const runId = RunId.make("run:effect-worker-restart");

function layerExecutorFor(input: {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  readonly failFirstStart?: Ref.Ref<boolean>;
  readonly threads?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
  readonly continueAfterRestart?: boolean;
  readonly changes?: Partial<IssueChangeService.IssueChangeService["Service"]>;
  readonly interrupt?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["interrupt"];
  readonly rollback?: CheckpointRollbackService.CheckpointRollbackServiceV2Shape["execute"];
}) {
  const record = (event: string) => Ref.update(input.events, (events) => [...events, event]);
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(
      ProviderTurnControlService.ProviderTurnControlServiceV2,
      ProviderTurnControlService.ProviderTurnControlServiceV2.of({
        interrupt: input.interrupt ?? (() => Effect.void),
        steer: Effect.fn("ProviderTurnControlService.ProviderTurnControlServiceV2.steer")(
          () => Effect.void,
        ),
        interruptAndAwaitTerminal: Effect.fn(
          "ProviderTurnControlService.ProviderTurnControlServiceV2.interruptAndAwaitTerminal",
        )((request) =>
          record(
            request.replacementProviderSessionId === undefined
              ? "interrupt"
              : `interrupt:${request.replacementProviderSessionId}`,
          ),
        ),
      }),
    ),
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      ProviderSessionManager.ProviderSessionManagerV2.of({
        shutdown: Effect.void,
        releaseUnlessBusy: Effect.fn(
          "ProviderSessionManager.ProviderSessionManagerV2.releaseUnlessBusy",
        )(() => Effect.succeed(true)),
        otherWorkingThreads: Effect.fn(
          "ProviderSessionManager.ProviderSessionManagerV2.otherWorkingThreads",
        )(() => Effect.succeed([])),
        open: Effect.fn("ProviderSessionManager.ProviderSessionManagerV2.open")(() =>
          Effect.die("unused open"),
        ),
        get: Effect.fn("ProviderSessionManager.ProviderSessionManagerV2.get")(
          () => Effect.succeedNone,
        ),
        isLive: Effect.fn("ProviderSessionManager.ProviderSessionManagerV2.isLive")(() =>
          Effect.succeed(false),
        ),
        close: Effect.fn("ProviderSessionManager.ProviderSessionManagerV2.close")(
          () => Effect.void,
        ),
        closeInstance: Effect.fn("ProviderSessionManager.ProviderSessionManagerV2.closeInstance")(
          () => Effect.void,
        ),
        release: Effect.fn("ProviderSessionManager.ProviderSessionManagerV2.release")(() =>
          record("release"),
        ),
        detach: Effect.fn("ProviderSessionManager.ProviderSessionManagerV2.detach")(() =>
          record("detach"),
        ),
      }),
    ),
    Layer.succeed(
      ProviderTurnStartService.ProviderTurnStartServiceV2,
      ProviderTurnStartService.ProviderTurnStartServiceV2.of({
        start: Effect.fn("EffectWorkerTestHarness.start")(function* () {
          yield* record("start");
          if (
            input.failFirstStart !== undefined &&
            (yield* Ref.getAndSet(input.failFirstStart, false))
          ) {
            return yield* new ProviderTurnStartService.ProviderTurnStartError({
              runId,
              cause: "simulated first start failure",
            });
          }
        }),
      }),
    ),
    Layer.succeed(
      RunFinalizationService.RunFinalizationService,
      RunFinalizationService.RunFinalizationService.of({
        finalize: Effect.fn("RunFinalizationService.RunFinalizationService.finalize")(
          () => Effect.void,
        ),
      }),
    ),
    Layer.succeed(
      CheckpointRollbackService.CheckpointRollbackServiceV2,
      CheckpointRollbackService.CheckpointRollbackServiceV2.of({
        execute: input.rollback ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      RuntimeRequestService.RuntimeRequestServiceV2,
      RuntimeRequestService.RuntimeRequestServiceV2.of({
        respond: Effect.fn("RuntimeRequestService.RuntimeRequestServiceV2.respond")(
          () => Effect.void,
        ),
      }),
    ),
    Layer.succeed(
      ThreadTitleRegenerationService.ThreadTitleRegenerationService,
      ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
        execute: Effect.fn("ThreadTitleRegenerationService.ThreadTitleRegenerationService.execute")(
          () => Effect.void,
        ),
      }),
    ),
  );
  return EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDependencies,
        Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)(input.threads ?? {}),
        Layer.mock(IssueService.IssueService)({
          writeManagedComment: () => Effect.die("Issue comments are unused in this test"),
        }),
        Layer.mock(IssueChangeService.IssueChangeService)(input.changes ?? {}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getIssueWorkCommentState: () => Effect.succeed(null),
          getIssueCommentReceipt: () => Effect.succeed(null),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: () => Effect.die("Issue comment receipts are unused in this test"),
        }),
        IdAllocator.layer,
        ServerSettings.layerTest(
          input.continueAfterRestart === true ? { continueThreadsAfterServerUpdate: true } : {},
        ),
      ),
    ),
  );
}
export { layerExecutorFor, oldSessionId, providerThreadId, providerTurnId, runId, threadId };
