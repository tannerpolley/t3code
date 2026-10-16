import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";

export const THREAD_DETAILS_CARD_GAP = 12;
// Keep in sync with --thread-details-panel-width, which sizes the popover and the find bar.
const THREAD_DETAILS_CARD_WIDTH = 280;

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

// Narrowest chat lane the docked card leaves beside it. Below this the card
// becomes a popover, which covers chat, so it stays well under the 640px lane
// the preview player keeps: an open right panel leaves too little room for that.
const DOCKED_CARD_MIN_CHAT_WIDTH = 400;

export function resolveThreadDetailsCardLayout({
  container,
  lane,
  frame,
  overlapsDetailsCard = false,
  topInset = 0,
}: {
  container: { width: number; height: number };
  lane: { padding: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  topInset?: number;
}) {
  const gap = THREAD_DETAILS_CARD_GAP;
  const width = THREAD_DETAILS_CARD_WIDTH;
  const x = container.width - width - gap;
  if (x - DETAILS_CARD_CLEARANCE - lane.padding < DOCKED_CARD_MIN_CHAT_WIDTH) return null;
  const y = gap + topInset;
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(container.height - y - gap, frame.y - y - gap)
      : container.height - y - gap;
  if (height < 160) return null;
  return {
    x,
    right: gap,
    width,
    y,
    height,
  } as const;
}
