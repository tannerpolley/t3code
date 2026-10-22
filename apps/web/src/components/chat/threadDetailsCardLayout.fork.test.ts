import { describe, expect, it } from "vite-plus/test";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";

const lane = { padding: 48, minChatWidth: 640 };
const resolve = (width: number, height: number, previewY: number | null = null) =>
  resolveThreadDetailsCardLayout({
    container: { width, height },
    lane,
    frame: previewY === null ? null : { x: width - 332, y: previewY, width: 320, height: 240 },
  });

describe("workspace card", () => {
  it("docks beside a narrower chat lane, as when a right panel is open, until it would cover chat", () => {
    // 280 card + 12 gap + 32 clearance + 48 padding + 400 chat.
    expect(resolve(772, 900)).toMatchObject({ x: 480 });
    expect(resolve(771, 900)).toBeNull();
  });
});
