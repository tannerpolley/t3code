import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
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

const STATUS_NOTIFIER_WATCHER = "org.kde.StatusNotifierWatcher";

/**
 * Whether a session bus address names a plain socket. dbus-next runs the program
 * named by a `unixexec:` address and never reaps it, so anything else counts as
 * no bus, and closing the window quits.
 */
export function isSocketBusAddress(address: string | undefined): address is string {
  return address !== undefined && /^unix:(?:[^;,]*,)*(?:path|abstract)=[^;]*$/.test(address);
}

// Electron's Linux tray is a StatusNotifierItem. With no host to show it (GNOME
// without the AppIndicator extension, for one) the icon silently never appears,
// so ask over a fresh connection, closed again whatever the answer.
export async function isStatusNotifierHostRegistered(
  address: string,
  signal: AbortSignal,
): Promise<boolean> {
  const { Message, sessionBus } = await import("dbus-next");
  // A timeout during the import aborts before any connection exists; the listener below would never fire.
  if (signal.aborted) return false;
  const bus = sessionBus({ busAddress: address });
  signal.addEventListener("abort", () => bus.disconnect());
  try {
    const reply = await Promise.race([
      bus.call(
        new Message({
          destination: STATUS_NOTIFIER_WATCHER,
          path: "/StatusNotifierWatcher",
          interface: "org.freedesktop.DBus.Properties",
          member: "Get",
          signature: "ss",
          body: [STATUS_NOTIFIER_WATCHER, "IsStatusNotifierHostRegistered"],
        }),
      ),
      new Promise<never>((_, reject) => bus.on("error", reject)),
    ]);
    return reply?.body[0]?.value === true;
  } finally {
    bus.disconnect();
  }
}

/** False on no host, an error, or no answer within `timeout`. */
const statusNotifierHostPresent = (address: string, timeout: Duration.Input) =>
  Effect.promise((signal) =>
    isStatusNotifierHostRegistered(address, signal).catch(() => false),
  ).pipe(Effect.timeoutOption(timeout), Effect.map(Option.getOrElse(() => false)));

/**
 * Shows the main window, creating it if needed, unless a quit has started. The
 * tray's Open item and desktop notification clicks both come through here.
 */
export const showMainWindow = Effect.gen(function* () {
  const state = yield* DesktopState.DesktopState;
  if (yield* Ref.get(state.quitting)) return;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.activate;
}).pipe(Effect.withSpan("desktop.tray.showMainWindow"));

/**
 * Shows a tray icon on Linux and Windows. While it is shown, closing the main
 * window hides it instead of quitting, so the built-in server, agents, and
 * remote connections keep running. Reopening goes through the tray, a second
 * launch (`second-instance` reveals the hidden window), or `t3 app`.
 *
 * On Linux the tray host is checked at startup and again on each close; a
 * missing host quits as before. Nothing watches the host while the window is
 * hidden: if it vanishes then, launching T3 Code again brings the window back.
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
  // macOS already keeps the app running with no windows.
  if (environment.platform === "darwin") return;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const state = yield* DesktopState.DesktopState;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const assets = yield* DesktopAssets.DesktopAssets;
  const context = yield* Effect.context<DesktopState.DesktopState | DesktopWindow.DesktopWindow>();
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);

  const iconPath = (yield* assets.iconPaths)[environment.platform === "win32" ? "ico" : "png"];
  if (Option.isNone(iconPath)) {
    return yield* logWarning("no tray icon available; closing the window quits");
  }
  // Only Linux needs the session bus; on Windows the tray is always available.
  const busAddress =
    environment.platform === "linux" ? process.env.DBUS_SESSION_BUS_ADDRESS : undefined;
  if (environment.platform === "linux" && !isSocketBusAddress(busAddress)) {
    return yield* logInfo("no usable session bus for a tray icon; closing the window quits");
  }

  let tray: Electron.Tray | undefined;
  const destroyTray = Effect.sync(() => {
    tray?.destroy();
    tray = undefined;
  });
  yield* Effect.addFinalizer(() => destroyTray);

  const keepRunningInBackground = clientSettings.get.pipe(
    Effect.map(
      Option.match({
        onNone: () => DEFAULT_CLIENT_SETTINGS.keepRunningInBackground,
        onSome: (settings) => settings.keepRunningInBackground,
      }),
    ),
    Effect.orElseSucceed(() => DEFAULT_CLIENT_SETTINGS.keepRunningInBackground),
  );
  const closeToTray = (window: Electron.BrowserWindow) =>
    Effect.gen(function* () {
      const hide =
        (yield* keepRunningInBackground) &&
        (busAddress === undefined || (yield* statusNotifierHostPresent(busAddress, "1 second")));
      // A quit that started during the check owns the window from here.
      if (window.isDestroyed() || (yield* Ref.get(state.quitting))) return;
      if (hide) return window.hide();
      yield* destroyTray;
      yield* electronApp.quit;
    }).pipe(
      Effect.catchCause((cause) => logWarning("failed to handle the window close", { cause })),
    );

  // Electron needs the close cancelled synchronously, so hold the window open
  // while the setting and the tray host are checked, then hide it or quit.
  yield* electronApp.on(
    "browser-window-created",
    (_event: unknown, window: Electron.BrowserWindow) => {
      window.on("close", (event) => {
        if (tray === undefined || tray.isDestroyed() || runSync(Ref.get(state.quitting))) return;
        const main = runSync(electronWindow.main);
        if (Option.isNone(main) || main.value !== window) return;
        event.preventDefault();
        return runPromise(closeToTray(window));
      });
    },
  );

  const open = () =>
    void runPromise(
      showMainWindow.pipe(
        Effect.catchCause((cause) =>
          logWarning("failed to open the window from the tray", { cause }),
        ),
      ),
    );
  const quit = () => void runPromise(electronApp.quit);
  const showTray = Effect.gen(function* () {
    if (busAddress !== undefined && !(yield* statusNotifierHostPresent(busAddress, "3 seconds"))) {
      return yield* logInfo("no system tray host found; closing the window quits");
    }
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
    yield* logInfo("tray icon shown; closing the window keeps the app running");
  });
  // The host check can take a moment; startup does not wait for it.
  yield* Effect.forkScoped(
    showTray.pipe(
      Effect.catchCause((cause) =>
        logWarning("could not show the tray icon; closing the window quits", { cause }),
      ),
    ),
  );
}).pipe(Effect.withSpan("desktop.tray.start"));
