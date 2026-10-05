import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { hideAgentBrowser, presentAgentBrowser } from "./agentBrowserPresentation";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
});

describe("hideAgentBrowser", () => {
  it("hides an agent tab shown in the side panel and keeps its surface", () => {
    useRightPanelStore.getState().open(ref, "diff");
    presentAgentBrowser(ref, "tab-a", true);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.id).toBe(
      "browser:tab-a",
    );

    hideAgentBrowser(ref, "tab-a");

    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    expect(panel.isOpen).toBe(false);
    expect(panel.surfaces.map((surface) => surface.id)).toEqual(["diff", "browser:tab-a"]);
  });

  it("leaves the side panel open on another surface", () => {
    presentAgentBrowser(ref, "tab-a", true);
    useRightPanelStore.getState().open(ref, "diff");

    hideAgentBrowser(ref, "tab-a");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.id).toBe(
      "diff",
    );
  });

  it("closes the mini player only when it floats the same tab", () => {
    presentAgentBrowser(ref, "tab-a", false);
    hideAgentBrowser(ref, "tab-b");
    expect(
      selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, ref),
    ).toBe("tab-a");

    hideAgentBrowser(ref, "tab-a");
    expect(
      selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, ref),
    ).toBeNull();
  });
});
