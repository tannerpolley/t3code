import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { showMainWindow as showMainWindowEffect } from "../../app/DesktopTray.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const showMainWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_MAIN_WINDOW_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: () => showMainWindowEffect,
});

export const getInterfaceZoom = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INTERFACE_ZOOM_GET_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Number,
  handler: Effect.fn("desktop.ipc.interfaceZoom.get")(function* () {
    return yield* (yield* DesktopWindow.DesktopWindow).mainZoomFactor;
  }),
});

export const setInterfaceZoom = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INTERFACE_ZOOM_SET_CHANNEL,
  payload: Schema.Finite,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.interfaceZoom.set")(function* (factor) {
    yield* (yield* DesktopWindow.DesktopWindow).setMainZoomFactor(factor);
  }),
});

export const stepInterfaceZoom = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INTERFACE_ZOOM_STEP_CHANNEL,
  payload: Schema.Literals(["in", "out", "reset"]),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.interfaceZoom.step")(function* (direction) {
    yield* (yield* DesktopWindow.DesktopWindow).zoomMain(direction);
  }),
});
