import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logError: logLifecycleError } = makeComponentLogger("desktop-lifecycle");

export const startForkShutdownDeadline = Effect.fn("desktop.lifecycle.startForkShutdownDeadline")(
  function* (exitCode: number) {
    const electronApp = yield* ElectronApp.ElectronApp;
    // A wedged uninterruptible provider finalizer must not prevent the deadline.
    yield* Effect.sleep("20 seconds").pipe(
      Effect.andThen(electronApp.exit(exitCode)),
      Effect.forkDetach,
    );
  },
);

export const prepareForkShutdown = Effect.fn("desktop.lifecycle.prepareForkShutdown")(function* (
  exitCode: number,
  flushBounds: Effect.Effect<void>,
) {
  yield* startForkShutdownDeadline(exitCode);
  const windowService = yield* Effect.serviceOption(ElectronWindow.ElectronWindow);
  yield* flushBounds;
  if (Option.isNone(windowService)) return;
  const electronWindow = windowService.value;
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
    Effect.catchCause((cause) => logLifecycleError("failed to show shutdown progress", { cause })),
  );
});
