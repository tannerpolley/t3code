import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveShortcutCommand } from "../keybindings";
import { runInterfaceZoomCommand } from "./interfaceZoomCommand";

const ctrl = (key: string, code: string, shiftKey = false) => ({
  key,
  code,
  ctrlKey: true,
  metaKey: false,
  shiftKey,
  altKey: false,
});
const resolve = (event: ReturnType<typeof ctrl>, previewFocus: boolean) =>
  resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, {
    platform: "Linux",
    context: { previewFocus },
  });

describe("interface zoom shortcuts", () => {
  it("zoom the app outside the preview and the preview inside it", () => {
    expect(resolve(ctrl("-", "Minus"), false)).toBe("interface.zoomOut");
    expect(resolve(ctrl("-", "Minus"), true)).toBe("preview.zoomOut");
    expect(resolve(ctrl("0", "Digit0"), false)).toBe("interface.zoomReset");
    expect(resolve(ctrl("0", "Digit0"), true)).toBe("preview.resetZoom");
    expect(resolve(ctrl("=", "Equal"), false)).toBe("interface.zoomIn");
    expect(resolve(ctrl("=", "Equal"), true)).toBe("preview.zoomIn");
  });

  it("zooms in on Ctrl+Shift+= as well, matched by physical key", () => {
    expect(resolve(ctrl("+", "Equal", true), false)).toBe("interface.zoomIn");
  });

  it("steps the desktop zoom, and does nothing without a desktop shell", () => {
    const zoom = { get: vi.fn(), set: vi.fn(), step: vi.fn(() => Promise.resolve()) };
    expect(runInterfaceZoomCommand("interface.zoomIn", zoom)).toBe(true);
    expect(runInterfaceZoomCommand("interface.zoomReset", zoom)).toBe(true);
    expect(zoom.step.mock.calls).toEqual([["in"], ["reset"]]);
    expect(runInterfaceZoomCommand("preview.zoomIn", zoom)).toBe(false);
    expect(runInterfaceZoomCommand("interface.zoomIn", undefined)).toBe(false);
  });
});
