import type { KeybindingCommand } from "@t3tools/contracts";

const DIRECTION_BY_COMMAND = {
  "interface.zoomIn": "in",
  "interface.zoomOut": "out",
  "interface.zoomReset": "reset",
} as const;

/**
 * Runs an `interface.zoom*` command through the desktop shell. Returns false
 * when the command is not one of these or there is no desktop shell (web keeps
 * the browser's own zoom), so the caller leaves the key event alone.
 */
export function runInterfaceZoomCommand(
  command: KeybindingCommand | null,
  zoom = typeof window === "undefined" ? undefined : window.desktopBridge?.interfaceZoom,
): boolean {
  if (command === null || !(command in DIRECTION_BY_COMMAND) || !zoom) return false;
  void zoom
    .step(DIRECTION_BY_COMMAND[command as keyof typeof DIRECTION_BY_COMMAND])
    .catch(() => undefined);
  return true;
}
