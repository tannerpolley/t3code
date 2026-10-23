import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export class DesktopLifecycleRelaunchError extends Schema.TaggedError<DesktopLifecycleRelaunchError>()(
  "DesktopLifecycleRelaunchError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop relaunch failed for reason "${this.reason}".`;
  }
}

export type DesktopLifecycleRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

type DesktopLifecycleRegistrationServices =
  | DesktopLifecycleRuntimeServices
  | ElectronWindow.ElectronWindow;

/**
 * @effect-expect-leaking DesktopEnvironment | DesktopShutdown | DesktopState | DesktopWindow | ElectronApp | ElectronTheme | ElectronWindow
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly relaunch: (
      reason: string,
    ) => Effect.Effect<void, never, DesktopLifecycleRuntimeServices>;
    readonly register: Effect.Effect<
      void,
      never,
      Scope.Scope | DesktopLifecycleRegistrationServices
    >;
  }
>()("@t3tools/desktop/app/DesktopLifecycle") {}

const { logInfo: logLifecycleInfo, logError: logLifecycleError } =
  makeComponentLogger("desktop-lifecycle");

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

const QUIT_DEADLINE_MS = 20_000;

const requestDesktopShutdownAndWait = Effect.fn("desktop.lifecycle.requestShutdownAndWait")(
  function* (): Effect.fn.Return<
    void,
    never,
    DesktopShutdown.DesktopShutdown | DesktopWindow.DesktopWindow | ElectronWindow.ElectronWindow
  > {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    yield* desktopWindow.flushMainWindowBounds;
    yield* electronWindow.destroyAll.pipe(
      Effect.catchCause((cause) =>
        logLifecycleError("failed to destroy windows before shutdown", { cause }),
      ),
    );
    yield* Effect.gen(function* () {
      const progress = yield* electronWindow.create({
        width: 360,
        height: 180,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        autoHideMenuBar: true,
        title: "Stopping T3 Code…",
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      progress.on("close", (event) => event.preventDefault());
      yield* Effect.sync(() => {
        void progress
          .loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:14px system-ui;background:#18181b;color:#fafafa;display:grid;place-content:center;height:100vh;margin:0;text-align:center}p{color:#a1a1aa;font-size:12px}</style></head><body><strong>Stopping T3 Code…</strong><p>Waiting for active agents to stop…</p></body></html>`)}`,
          )
          .catch(() => {});
      });
    }).pipe(
      Effect.catchCause((cause) =>
        logLifecycleError("failed to show shutdown progress", { cause }),
      ),
    );
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  },
);

/** @public Service construction is part of the canonical Effect module API. */
export const make = () => {
  let relaunchExitCode = 0;
  return DesktopLifecycle.of({
    relaunch: Effect.fn("desktop.lifecycle.relaunch")(function* (reason) {
      const electronApp = yield* ElectronApp.ElectronApp;
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      yield* logLifecycleInfo("desktop relaunch requested", { reason });
      yield* Effect.gen(function* () {
        yield* Effect.yieldNow;
        if (environment.isDevelopment) relaunchExitCode = 75;
        if (!environment.isDevelopment) {
          yield* electronApp.relaunch({
            execPath: process.execPath,
            args: process.argv.slice(1),
          });
        }
        yield* electronApp.quit;
      }).pipe(
        Effect.catchCause((cause) => {
          const error = new DesktopLifecycleRelaunchError({ reason, cause });
          return logLifecycleError(error.message, { error });
        }),
        Effect.forkDetach,
        Effect.asVoid,
      );
    }),
    register: Effect.gen(function* () {
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronTheme = yield* ElectronTheme.ElectronTheme;
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const context = yield* Effect.context<DesktopLifecycleRegistrationServices>();
      const runEffect = Effect.runPromiseWith(context);
      let quitAllowed = false;
      let quitStarted = false;
      const startQuitDeadline = () => {
        // Detached from shutdown: interrupting a wedged finalizer must not delay the exit.
        void runEffect(
          Effect.sleep(QUIT_DEADLINE_MS).pipe(
            Effect.andThen(electronApp.exit(relaunchExitCode)),
            Effect.forkDetach,
          ),
        );
      };
      let updaterQuitAllowed = false;
      yield* electronTheme.onUpdated(() => {
        void runEffect(
          desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
        );
      });
      yield* electronApp.onBeforeQuitForUpdate(() => {
        // Electron's updater owns the remaining quit/install/relaunch sequence.
        // Cancelling the following app "before-quit" event breaks that sequence,
        // most visibly on macOS where the native updater performs the relaunch.
        updaterQuitAllowed = true;
        if (!quitStarted) {
          quitStarted = true;
          startQuitDeadline();
        }
        Effect.runSyncWith(context)(
          Effect.gen(function* () {
            const state = yield* DesktopState.DesktopState;
            yield* Ref.set(state.quitting, true);
          }),
        );
        // This event is synchronous and the updater's quit proceeds as soon as
        // the listener returns, so a forked destroyAll would race the quit
        // and windows could still be open when the process exits (visible on
        // macOS). Destroy them inline.
        Effect.runSyncWith(context)(
          electronWindow.destroyAll.pipe(
            Effect.andThen(logLifecycleInfo("allowing updater-controlled quit")),
            Effect.catchCause((cause) =>
              logLifecycleError("failed to destroy windows before updater quit", { cause }),
            ),
            Effect.withSpan("desktop.lifecycle.beforeQuitForUpdate"),
          ),
        );
      });
      yield* electronApp.on("before-quit", (event: Electron.Event) => {
        if (quitAllowed || updaterQuitAllowed) return;
        event.preventDefault();
        if (quitStarted) return;
        quitStarted = true;
        startQuitDeadline();
        void runEffect(
          Effect.gen(function* () {
            const state = yield* DesktopState.DesktopState;
            yield* Ref.set(state.quitting, true);
            yield* logLifecycleInfo("before-quit received");
            yield* requestDesktopShutdownAndWait();
          }).pipe(
            Effect.catchCause((cause) => logLifecycleError("desktop shutdown failed", { cause })),
            Effect.andThen(
              Effect.sync(() => {
                quitAllowed = true;
              }),
            ),
            Effect.andThen(electronWindow.destroyAll),
            Effect.andThen(
              Effect.suspend(() =>
                relaunchExitCode === 75 ? electronApp.exit(75) : electronApp.quit,
              ).pipe(Effect.withSpan("desktop.lifecycle.quitAfterShutdown")),
            ),
            Effect.withSpan("desktop.lifecycle.beforeQuit"),
          ),
        );
      });
      yield* electronApp.on("activate", () => {
        void runEffect(
          Effect.gen(function* () {
            const state = yield* DesktopState.DesktopState;
            if (yield* Ref.get(state.quitting)) return;
            yield* desktopWindow.activate;
          }).pipe(Effect.withSpan("desktop.lifecycle.activate")),
        );
      });
      yield* electronApp.on("window-all-closed", () => {
        void runEffect(
          Effect.gen(function* () {
            const app = yield* ElectronApp.ElectronApp;
            const state = yield* DesktopState.DesktopState;
            if (environment.platform !== "darwin" && !(yield* Ref.get(state.quitting))) {
              yield* app.quit;
            }
          }).pipe(Effect.withSpan("desktop.lifecycle.windowAllClosed")),
        );
      });

      if (environment.platform !== "win32") {
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          yield* addScopedListener(process, signal, () => {
            void runEffect(
              Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({ signal });
                yield* electronApp.quit;
                yield* logLifecycleInfo("process signal received", { signal });
              }).pipe(Effect.withSpan("desktop.lifecycle.processSignal")),
            );
          });
        }
      }
    }).pipe(Effect.withSpan("desktop.lifecycle.register")),
  });
};

export const layer = Layer.sync(DesktopLifecycle, make);
