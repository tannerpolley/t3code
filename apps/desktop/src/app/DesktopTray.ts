import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
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

const STATUS_NOTIFIER_WATCHER = "org.kde.StatusNotifierWatcher";

/**
 * Whether a session bus address names a plain socket. dbus-next runs the program
 * named by a `unixexec:` address and never reaps it, so anything else counts as
 * no bus, and closing the window quits.
 */
export function isSocketBusAddress(address: string | undefined): address is string {
  return address !== undefined && /^unix:(?:[^;,]*,)*(?:path|abstract)=[^;]*$/.test(address);
}

interface StatusNotifierHost {
  readonly registered: () => Promise<boolean>;
  readonly close: () => void;
}

// Electron's Linux tray is a StatusNotifierItem. With no host to show it (GNOME
// without the AppIndicator extension, for one) the icon silently never appears.
// The host is asked directly, and `onChange` runs whenever it may have come or gone.
async function connectStatusNotifierHost(
  address: string,
  signal: AbortSignal,
  onChange: () => void,
): Promise<StatusNotifierHost> {
  const { Message, MessageType, sessionBus } = await import("dbus-next");
  const bus = sessionBus({ busAddress: address });
  let closed = false;
  const close = () => {
    closed = true;
    bus.disconnect();
  };
  signal.addEventListener("abort", close);
  const disconnected = new Promise<never>((_, reject) => {
    bus.on("error", (error) => {
      reject(error);
      if (!closed) onChange();
    });
  });
  disconnected.catch(() => undefined);
  const call = (message: ConstructorParameters<typeof Message>[0]) =>
    Promise.race([bus.call(new Message(message)), disconnected]);
  bus.on("message", (message) => {
    if (closed || message.type !== MessageType.SIGNAL) return;
    if (
      (message.member === "NameOwnerChanged" && message.body[0] === STATUS_NOTIFIER_WATCHER) ||
      (message.interface === STATUS_NOTIFIER_WATCHER &&
        message.member.startsWith("StatusNotifierHost"))
    ) {
      onChange();
    }
  });
  try {
    for (const rule of [
      `type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${STATUS_NOTIFIER_WATCHER}'`,
      `type='signal',interface='${STATUS_NOTIFIER_WATCHER}'`,
    ]) {
      await call({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "AddMatch",
        signature: "s",
        body: [rule],
      });
    }
  } catch (error) {
    close();
    throw error;
  }
  return {
    registered: () =>
      call({
        destination: STATUS_NOTIFIER_WATCHER,
        path: "/StatusNotifierWatcher",
        interface: "org.freedesktop.DBus.Properties",
        member: "Get",
        signature: "ss",
        body: [STATUS_NOTIFIER_WATCHER, "IsStatusNotifierHostRegistered"],
      }).then(
        (reply) => reply?.body[0]?.value === true,
        () => false,
      ),
    close,
  };
}

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
 * Shows a tray icon on Linux and Windows and, while it is shown, hides the main
 * window on close instead of quitting, so the built-in server, agents, and
 * remote connections keep running. Reopening goes through the tray, a second
 * launch (`second-instance` reveals the hidden window), or `t3 app`. If the
 * Linux tray host goes away, the icon goes with it and a hidden window comes back.
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
  const state = yield* DesktopState.DesktopState;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const assets = yield* DesktopAssets.DesktopAssets;
  const context = yield* Effect.context<DesktopState.DesktopState | DesktopWindow.DesktopWindow>();
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

  const iconPath = (yield* assets.iconPaths)[environment.platform === "win32" ? "ico" : "png"];
  if (Option.isNone(iconPath)) {
    return yield* logWarning("no tray icon available; closing the window quits");
  }
  // Only Linux needs the session bus; elsewhere the tray is always available.
  const busAddress =
    environment.platform === "linux" ? process.env.DBUS_SESSION_BUS_ADDRESS : undefined;
  if (environment.platform === "linux" && !isSocketBusAddress(busAddress)) {
    return yield* logInfo("no usable session bus for a tray icon; closing the window quits");
  }

  const open = () =>
    void runPromise(
      showMainWindow.pipe(
        Effect.catchCause((cause) =>
          logWarning("failed to open the window from the tray", { cause }),
        ),
      ),
    );
  const quit = () => void runPromise(electronApp.quit);
  const destroyTray = Effect.sync(() => {
    tray?.destroy();
    tray = undefined;
  });
  yield* Effect.addFinalizer(() => destroyTray);

  const setTrayShown = Effect.fn("desktop.tray.setShown")(function* (shown: boolean) {
    if (shown === (tray !== undefined) || (yield* Ref.get(state.quitting))) return;
    if (!shown) {
      yield* destroyTray;
      // With the icon gone there is no way back to a hidden window, so show it.
      const main = yield* electronWindow.main;
      if (Option.isSome(main) && !main.value.isVisible()) yield* electronWindow.reveal(main.value);
      return yield* logInfo("system tray host is gone; closing the window quits");
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

  const showTray = Effect.gen(function* () {
    if (busAddress === undefined) return yield* setTrayShown(true);
    const gate = yield* Semaphore.make(1);
    let host: StatusNotifierHost | undefined;
    // Serialized so a burst of bus signals cannot create two icons.
    const sync = gate
      .withPermits(1)(
        Effect.suspend(() =>
          host === undefined
            ? Effect.void
            : Effect.promise(host.registered).pipe(
                Effect.timeoutOption("3 seconds"),
                Effect.map(Option.getOrElse(() => false)),
                Effect.flatMap(setTrayShown),
              ),
        ),
      )
      .pipe(Effect.catchCause((cause) => logWarning("could not update the tray icon", { cause })));
    const connected = yield* Effect.promise((signal) =>
      connectStatusNotifierHost(busAddress, signal, () => void runPromise(sync)).catch(
        () => undefined,
      ),
    ).pipe(Effect.timeoutOption("3 seconds"), Effect.map(Option.getOrUndefined));
    if (connected === undefined) {
      return yield* logInfo("no system tray host found; closing the window quits");
    }
    host = connected;
    yield* Effect.addFinalizer(() => Effect.sync(connected.close));
    yield* sync;
    if (tray === undefined) yield* logInfo("no system tray host found; closing the window quits");
  });
  // The bus probe can take a moment; startup does not wait for it.
  yield* Effect.forkScoped(
    showTray.pipe(
      Effect.catchCause((cause) =>
        logWarning("could not show the tray icon; closing the window quits", { cause }),
      ),
    ),
  );
}).pipe(Effect.withSpan("desktop.tray.start"));
