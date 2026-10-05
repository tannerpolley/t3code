import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

/**
 * Shows a tab an agent is using: in the right panel, or in the floating mini player when the
 * user turned "Agent browser opens in the side panel" off.
 */
export const presentAgentBrowser = (
  threadRef: ScopedThreadRef,
  tabId: string,
  inPanel: boolean,
) => {
  if (inPanel) {
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
    return;
  }
  usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(tabId));
};

/**
 * Hides a tab an agent opened with `open: false` wherever it is showing. The tab keeps running and
 * keeps its panel surface; another tab or surface on screen is left alone.
 */
export const hideAgentBrowser = (threadRef: ScopedThreadRef, tabId: string) => {
  const miniPlayer = usePreviewMiniPlayerStore.getState();
  if (selectThreadPreviewMiniPlayerTabId(miniPlayer.byThreadKey, threadRef) === tabId) {
    miniPlayer.close(threadRef);
  }
  const rightPanel = useRightPanelStore.getState();
  if (selectActiveRightPanelSurface(rightPanel.byThreadKey, threadRef)?.id === `browser:${tabId}`) {
    rightPanel.close(threadRef);
  }
};
