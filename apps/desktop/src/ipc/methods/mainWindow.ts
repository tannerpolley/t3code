import * as Schema from "effect/Schema";

import { showMainWindow as showMainWindowEffect } from "../../app/DesktopTray.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const showMainWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_MAIN_WINDOW_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: () => showMainWindowEffect,
});
