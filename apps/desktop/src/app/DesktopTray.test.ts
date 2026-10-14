import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, expect, vi } from "vite-plus/test";

import type * as Electron from "electron";

/** How the fake session bus answers one host check. */
type BusReply = "present" | "absent" | "slow" | "error" | Promise<unknown>;

const fake = vi.hoisted(() => ({
  replies: [] as Array<BusReply>,
  busAddresses: [] as Array<string>,
  disconnects: 0,
  trays: [] as Array<{ destroyed: boolean }>,
  trayCreated: Promise.withResolvers<void>(),
}));

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
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  },
}));

vi.mock("dbus-next", () => ({
  Message: function (fields: object) {
    return fields;
  },
  // A fresh fake connection per check, answering with the next queued reply.
  sessionBus: (options: { busAddress: string }) => {
    fake.busAddresses.push(options.busAddress);
    const reply = fake.replies.shift() ?? "present";
    const errorListeners: Array<(error: unknown) => void> = [];
    return {
      on: (event: string, listener: (error: unknown) => void) => {
        if (event === "error") errorListeners.push(listener);
      },
      call: () => {
        if (reply === "present") return Promise.resolve({ body: [{ value: true }] });
        if (reply === "absent") {
          return Promise.reject(new Error("org.freedesktop.DBus.Error.ServiceUnknown"));
        }
        if (reply === "error") {
          queueMicrotask(() => {
            for (const listener of errorListeners) listener(new Error("ECONNRESET"));
          });
        }
        return reply === "slow" || reply === "error" ? new Promise(() => {}) : reply;
      },
      disconnect: () => {
        fake.disconnects += 1;
      },
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

/** The tray against fakes, with one main window whose close button can be pressed. */
function makeHarness() {
  const appListeners = new Map<string, (...args: Array<unknown>) => void>();
  const closeListeners: Array<(event: { preventDefault: () => void }) => unknown> = [];
  const hide = vi.fn();
  const quit = vi.fn();
  const logs: Array<string> = [];
  const window = {
    on: (name: string, listener: (event: { preventDefault: () => void }) => unknown) => {
      if (name === "close") closeListeners.push(listener);
    },
    hide,
    isDestroyed: () => false,
  } as unknown as Electron.BrowserWindow;
  const layer = Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform: "linux",
      displayName: "T3 Code",
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.succeed(ElectronApp.ElectronApp, {
      on: (name: string, listener: (...args: Array<unknown>) => void) =>
        Effect.sync(() => void appListeners.set(name, listener)),
      quit: Effect.sync(quit),
    } as unknown as ElectronApp.ElectronApp["Service"]),
    Layer.succeed(ElectronWindow.ElectronWindow, {
      main: Effect.succeed(Option.some(window)),
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
    Logger.layer(
      [
        Logger.make(({ message }) =>
          logs.push(String(Array.isArray(message) ? message[0] : message)),
        ),
      ],
      { mergeWithExisting: false },
    ),
  );
  /** Starts the tray, waits for its icon, and opens the main window. */
  const startWithTray = Effect.gen(function* () {
    yield* DesktopTray.start;
    yield* Effect.promise(() => fake.trayCreated.promise);
    appListeners.get("browser-window-created")?.({}, window);
  });
  /** Presses close: whether the close was held open, and the decision that follows. */
  const pressClose = () => {
    let held = false;
    const decision = closeListeners[0]?.({ preventDefault: () => (held = true) });
    return { held, decision: Promise.resolve(decision) };
  };
  return { layer, appListeners, window, startWithTray, pressClose, hide, quit, logs };
}

afterEach(() => {
  vi.unstubAllEnvs();
  fake.replies.length = 0;
  fake.busAddresses.length = 0;
  fake.disconnects = 0;
  fake.trays.length = 0;
  fake.trayCreated = Promise.withResolvers<void>();
});

describe("DesktopTray", () => {
  it.effect("hides the window on close while the tray host is still there", () => {
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
    const tray = makeHarness();
    return Effect.gen(function* () {
      yield* tray.startWithTray;
      const close = tray.pressClose();
      assert.isTrue(close.held);
      yield* Effect.promise(() => close.decision);
      expect(tray.hide).toHaveBeenCalledOnce();
      expect(tray.quit).not.toHaveBeenCalled();
      // Startup and close each opened a connection and closed it again.
      assert.equal(fake.busAddresses.length, 2);
      assert.equal(fake.disconnects, 2);
    }).pipe(Effect.provide(tray.layer), Effect.scoped);
  });

  it.effect.each(["absent", "slow", "error"] as const)(
    "quits on close when the tray host check finds nothing: %s",
    (reply) => {
      vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
      const tray = makeHarness();
      return Effect.gen(function* () {
        yield* tray.startWithTray;
        fake.replies.push(reply);
        const close = tray.pressClose();
        assert.isTrue(close.held);
        if (reply === "slow") yield* TestClock.adjust("1 second");
        yield* Effect.promise(() => close.decision);
        expect(tray.quit).toHaveBeenCalledOnce();
        expect(tray.hide).not.toHaveBeenCalled();
        assert.isTrue(fake.trays[0]?.destroyed);
      }).pipe(Effect.provide(tray.layer), Effect.scoped);
    },
  );

  it.effect("leaves a quit that starts during the close check alone", () => {
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
    const tray = makeHarness();
    return Effect.gen(function* () {
      yield* tray.startWithTray;
      const reply = Promise.withResolvers<unknown>();
      fake.replies.push(reply.promise);
      const close = tray.pressClose();
      assert.isTrue(close.held);
      const state = yield* DesktopState.DesktopState;
      yield* Ref.set(state.quitting, true);
      reply.resolve({ body: [{ value: true }] });
      yield* Effect.promise(() => close.decision);
      expect(tray.hide).not.toHaveBeenCalled();
      expect(tray.quit).not.toHaveBeenCalled();
    }).pipe(Effect.provide(tray.layer), Effect.scoped);
  });

  it.effect("never connects to a session bus that is not a plain socket", () => {
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unixexec:path=/bin/sh,argv1=-c");
    const tray = makeHarness();
    return Effect.gen(function* () {
      yield* DesktopTray.start;
      // The fallback is decided and logged before anything could open a bus.
      expect(tray.logs[0]).toContain("closing the window quits");
      tray.appListeners.get("browser-window-created")?.({}, tray.window);
      assert.isFalse(tray.pressClose().held);
      assert.deepEqual(fake.busAddresses, []);
    }).pipe(Effect.provide(tray.layer), Effect.scoped);
  });

  it("opens no connection when the check timed out while dbus-next was loading", async () => {
    const before = fake.busAddresses.length;
    const aborted = AbortSignal.abort();
    expect(
      await DesktopTray.isStatusNotifierHostRegistered("unix:path=/run/user/1000/bus", aborted),
    ).toBe(false);
    expect(fake.busAddresses.length).toBe(before);
  });

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
