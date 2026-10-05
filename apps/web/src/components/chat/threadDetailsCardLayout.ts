import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";

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

/**
 * The card pins to the top right while a readable chat lane fits beside it.
 * The chat canvas decides whether chat moves over to make room.
 */
export function resolveThreadDetailsCardLayout({
  container,
  lane,
  frame,
  overlapsDetailsCard = false,
}: {
  container: { width: number; height: number };
  lane: { padding: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
}) {
  const gap = 12;
  // Keep in sync with --thread-details-panel-width, which sizes the popover.
  const width = 280;
  const x = container.width - width - gap;
  if (x - DETAILS_CARD_CLEARANCE - lane.padding < DOCKED_CARD_MIN_CHAT_WIDTH) return null;
  // Resizing consumes the height above the player. Dragging first tries to
  // clear the full card and folds it only when there is no readable placement.
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(container.height - gap * 2, frame.y - gap * 2)
      : container.height - gap * 2;
  if (height < 160) return null;
  return {
    x,
    width,
    y: gap,
    height,
  } as const;
}
