import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopState from "./DesktopState.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-tray");

/**
 * What closing the main window does. It hides into the tray only while a tray
 * icon offers the way back; otherwise it closes and the app quits as before.
 * macOS already keeps the app running with no windows, and a quit in progress
 * must always be able to close it.
 */
export function mainWindowCloseAction(input: {
  readonly platform: NodeJS.Platform;
  readonly quitting: boolean;
  readonly trayShown: boolean;
  readonly keepRunningInBackground: boolean;
}): "hide" | "close" {
  return input.platform !== "darwin" &&
    !input.quitting &&
    input.trayShown &&
    input.keepRunningInBackground
    ? "hide"
    : "close";
}

// Electron's Linux tray is a StatusNotifierItem. With no host to show it (GNOME
// without the AppIndicator extension, for one) the icon silently never appears,
// so ask the session bus before hiding the only window behind it.
async function statusNotifierHostRegistered(signal: AbortSignal): Promise<boolean> {
  try {
    const { Message, sessionBus } = await import("dbus-next");
    const bus = sessionBus();
    signal.addEventListener("abort", () => bus.disconnect());
    try {
      const reply = await Promise.race([
        bus.call(
          new Message({
            destination: "org.kde.StatusNotifierWatcher",
            path: "/StatusNotifierWatcher",
            interface: "org.freedesktop.DBus.Properties",
            member: "Get",
            signature: "ss",
            body: ["org.kde.StatusNotifierWatcher", "IsStatusNotifierHostRegistered"],
          }),
        ),
        new Promise<never>((_, reject) => bus.on("error", reject)),
      ]);
      return reply?.body[0]?.value === true;
    } finally {
      bus.disconnect();
    }
  } catch {
    return false;
  }
}

/**
 * Shows a tray icon on Linux and Windows and, while it is shown, hides the main
 * window on close instead of quitting, so the built-in server, agents, and
 * remote connections keep running. Reopening goes through the tray, a second
 * launch (`second-instance` reveals the hidden window), or `t3 app`.
 */
export const start: Effect.Effect<
  void,
  never,
  | Scope.Scope
  | DesktopAssets.DesktopAssets
  | DesktopClientSettings.DesktopClientSettings
  | DesktopEnvironment.DesktopEnvironment
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronWindow.ElectronWindow
> = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform === "darwin") return;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const state = yield* DesktopState.DesktopState;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const assets = yield* DesktopAssets.DesktopAssets;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);

  let tray: Electron.Tray | undefined;
  const allowedToClose = new WeakSet<Electron.BrowserWindow>();
  const keepRunningInBackground = clientSettings.get.pipe(
    Effect.map(
      Option.match({
        onNone: () => DEFAULT_CLIENT_SETTINGS.keepRunningInBackground,
        onSome: (settings) => settings.keepRunningInBackground,
      }),
    ),
    Effect.orElseSucceed(() => DEFAULT_CLIENT_SETTINGS.keepRunningInBackground),
  );
  const closeAction = (keepRunning: boolean) =>
    mainWindowCloseAction({
      platform: environment.platform,
      quitting: runSync(Ref.get(state.quitting)),
      trayShown: tray !== undefined,
      keepRunningInBackground: keepRunning,
    });

  // The close event cannot wait for the settings file, so hold the window open,
  // read the setting, then hide it or let the close go through as before.
  yield* electronApp.on(
    "browser-window-created",
    (_event: unknown, window: Electron.BrowserWindow) => {
      window.on("close", (event) => {
        if (allowedToClose.has(window) || closeAction(true) === "close") return;
        const main = runSync(electronWindow.main);
        if (Option.isNone(main) || main.value !== window) return;
        event.preventDefault();
        void runPromise(
          keepRunningInBackground.pipe(
            Effect.map((keepRunning) => {
              if (window.isDestroyed()) return;
              if (closeAction(keepRunning) === "hide") {
                window.hide();
                return;
              }
              allowedToClose.add(window);
              window.close();
            }),
          ),
        );
      });
    },
  );

  const open = () =>
    void runPromise(
      Effect.gen(function* () {
        if (yield* Ref.get(state.quitting)) return;
        yield* desktopWindow.activate;
      }).pipe(
        Effect.catchCause((cause) =>
          logWarning("failed to open the window from the tray", { cause }),
        ),
      ),
    );
  const quit = () => void runPromise(electronApp.quit);

  const iconPath = (yield* assets.iconPaths)[environment.platform === "win32" ? "ico" : "png"];
  const showTray = Effect.gen(function* () {
    if (Option.isNone(iconPath)) {
      return yield* logWarning("no tray icon available; closing the window quits");
    }
    if (
      environment.platform === "linux" &&
      !(yield* Effect.promise(statusNotifierHostRegistered).pipe(
        Effect.timeoutOption("3 seconds"),
        Effect.map(Option.getOrElse(() => false)),
      ))
    ) {
      return yield* logInfo("no system tray host found; closing the window quits");
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        let image = Electron.nativeImage.createFromPath(iconPath.value);
        // The Linux icon is the 1024px app icon; panels draw it at about 24px.
        if (environment.platform === "linux") image = image.resize({ width: 64, height: 64 });
        const created = new Electron.Tray(image);
        created.setToolTip(environment.displayName);
        created.setContextMenu(
          Electron.Menu.buildFromTemplate([
            { label: `Open ${environment.displayName}`, click: open },
            { type: "separator" },
            { label: `Quit ${environment.displayName}`, click: quit },
          ]),
        );
        created.on("click", open);
        tray = created;
      }),
      () =>
        Effect.sync(() => {
          tray?.destroy();
          tray = undefined;
        }),
    );
    yield* logInfo("tray icon shown; closing the window keeps the app running");
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("could not show the tray icon; closing the window quits", { cause }),
    ),
  );
  // The bus probe can take a moment; startup does not wait for it.
  yield* Effect.forkScoped(showTray);
}).pipe(Effect.withSpan("desktop.tray.start"));
