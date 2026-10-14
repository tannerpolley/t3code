import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { afterEach, expect, vi } from "vite-plus/test";

import type * as Electron from "electron";

const fake = vi.hoisted(() => {
  const busListeners = new Map<string, Array<(...args: Array<unknown>) => void>>();
  return {
    hostRegistered: true,
    busAddresses: [] as Array<unknown>,
    trays: [] as Array<{ destroyed: boolean }>,
    trayCreated: Promise.withResolvers<void>(),
    busListeners,
    emit: (event: string, ...args: Array<unknown>) => {
      for (const listener of busListeners.get(event) ?? []) listener(...args);
    },
  };
});

vi.mock("electron", () => ({
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  Menu: { buildFromTemplate: (template: unknown) => template },
  Tray: class {
    destroyed = false;
    constructor() {
      fake.trays.push(this);
      fake.trayCreated.resolve();
    }
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {
      this.destroyed = true;
    }
  },
}));

vi.mock("dbus-next", () => ({
  MessageType: { SIGNAL: 4 },
  Message: function (fields: object) {
    return fields;
  },
  sessionBus: (options: { busAddress: string }) => {
    fake.busAddresses.push(options.busAddress);
    return {
      on: (event: string, listener: (...args: Array<unknown>) => void) => {
        fake.busListeners.set(event, [...(fake.busListeners.get(event) ?? []), listener]);
      },
      call: async (message: { member: string }) => {
        if (message.member !== "Get") return null;
        if (!fake.hostRegistered) throw new Error("org.freedesktop.DBus.Error.ServiceUnknown");
        return { body: [{ value: true }] };
      },
      disconnect: () => undefined,
    };
  },
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopTray from "./DesktopTray.ts";

/** A main window whose close button can be pressed; reports whether the close was held. */
function makeMainWindow() {
  const listeners = new Map<string, (event: { preventDefault: () => void }) => void>();
  const hidden = Promise.withResolvers<void>();
  const window = {
    on: (name: string, listener: (event: { preventDefault: () => void }) => void) => {
      listeners.set(name, listener);
    },
    hide: () => hidden.resolve(),
    close: () => undefined,
    isVisible: () => false,
    isDestroyed: () => false,
  } as unknown as Electron.BrowserWindow;
  const pressClose = () => {
    let held = false;
    listeners.get("close")?.({ preventDefault: () => (held = true) });
    return held;
  };
  return { window, pressClose, hidden: hidden.promise };
}

/** Starts the tray against fakes, then opens `window` as the main window. */
function startTray(
  window: Electron.BrowserWindow,
  hooks: { readonly revealed?: () => void; readonly logged?: (message: string) => void },
) {
  const appListeners = new Map<string, (...args: Array<unknown>) => void>();
  const logger = Logger.make(({ message }) => {
    hooks.logged?.(String(Array.isArray(message) ? message[0] : message));
  });
  const services = Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform: "linux",
      displayName: "T3 Code",
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.succeed(ElectronApp.ElectronApp, {
      on: (name: string, listener: (...args: Array<unknown>) => void) =>
        Effect.sync(() => void appListeners.set(name, listener)),
      quit: Effect.void,
    } as unknown as ElectronApp.ElectronApp["Service"]),
    Layer.succeed(ElectronWindow.ElectronWindow, {
      main: Effect.succeed(Option.some(window)),
      reveal: () => Effect.sync(() => hooks.revealed?.()),
    } as unknown as ElectronWindow.ElectronWindow["Service"]),
    Layer.succeed(DesktopWindow.DesktopWindow, {
      activate: Effect.void,
    } as unknown as DesktopWindow.DesktopWindow["Service"]),
    Layer.succeed(DesktopClientSettings.DesktopClientSettings, {
      get: Effect.succeed(Option.none()),
      set: () => Effect.void,
    }),
    Layer.succeed(DesktopAssets.DesktopAssets, {
      iconPaths: Effect.succeed({
        ico: Option.none(),
        icns: Option.none(),
        png: Option.some("/icon.png"),
      }),
      resolveResourcePath: () => Effect.succeed(Option.none()),
    }),
    DesktopState.layer,
    Logger.layer([logger], { mergeWithExisting: false }),
  );
  return DesktopTray.start.pipe(
    Effect.provide(services),
    Effect.andThen(Effect.sync(() => appListeners.get("browser-window-created")?.({}, window))),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  fake.hostRegistered = true;
  fake.busAddresses.length = 0;
  fake.trays.length = 0;
  fake.busListeners.clear();
  fake.trayCreated = Promise.withResolvers<void>();
});

describe("DesktopTray", () => {
  it.effect("stops hiding and shows the window when the tray host goes away", () =>
    Effect.gen(function* () {
      vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
      const main = makeMainWindow();
      const revealed = Promise.withResolvers<void>();
      yield* startTray(main.window, { revealed: revealed.resolve });
      yield* Effect.promise(() => fake.trayCreated.promise);

      assert.isTrue(main.pressClose());
      yield* Effect.promise(() => main.hidden);

      fake.hostRegistered = false;
      fake.emit("message", {
        type: 4,
        member: "NameOwnerChanged",
        body: ["org.kde.StatusNotifierWatcher", ":1.42", ""],
      });
      yield* Effect.promise(() => revealed.promise);
      assert.isTrue(fake.trays[0]?.destroyed);
      assert.isFalse(main.pressClose());
    }).pipe(Effect.scoped),
  );

  it.effect("never connects to a session bus that is not a plain socket", () =>
    Effect.gen(function* () {
      vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unixexec:path=/bin/sh,argv1=-c");
      const main = makeMainWindow();
      // The first decision logged must be the fallback, before any bus is opened.
      const firstLog = Promise.withResolvers<string>();
      yield* startTray(main.window, { logged: firstLog.resolve });

      expect(yield* Effect.promise(() => firstLog.promise)).toContain("closing the window quits");
      assert.isFalse(main.pressClose());
      assert.deepEqual(fake.busAddresses, []);
    }).pipe(Effect.scoped),
  );

  it.each([
    ["unix:path=/run/user/1000/bus", true],
    ["unix:abstract=/tmp/dbus-x,guid=0123", true],
    ["unixexec:path=/bin/sh", false],
    ["unix:path=/run/user/1000/bus;unixexec:path=/bin/sh", false],
    ["tcp:host=localhost,port=4000", false],
  ] as const)("accepts only a socket bus address: %s", (address, accepted) => {
    expect(DesktopTray.isSocketBusAddress(address)).toBe(accepted);
  });
});

const keepRunning = {
  platform: "linux",
  quitting: false,
  trayShown: true,
  keepRunningInBackground: true,
} as const;

describe("mainWindowCloseAction", () => {
  it.each([
    ["hides on Linux while the tray is shown", keepRunning, "hide"],
    ["hides on Windows while the tray is shown", { ...keepRunning, platform: "win32" }, "hide"],
    ["closes when the setting is off", { ...keepRunning, keepRunningInBackground: false }, "close"],
    [
      "closes without a tray, so the app is never unreachable",
      { ...keepRunning, trayShown: false },
      "close",
    ],
    [
      "closes during a quit, so it never blocks quitting",
      { ...keepRunning, quitting: true },
      "close",
    ],
    ["leaves macOS unchanged", { ...keepRunning, platform: "darwin" }, "close"],
  ] as const)("%s", (_name, input, expected) => {
    expect(DesktopTray.mainWindowCloseAction(input)).toBe(expected);
  });
});
