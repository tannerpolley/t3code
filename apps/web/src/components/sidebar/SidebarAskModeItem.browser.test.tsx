import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarAskModeItem } from "./SidebarAskModeItem";

const state = vi.hoisted(() => ({ updateSettings: (_patch: unknown) => {} }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { dontAskMode: boolean }) => unknown) =>
    select({ dontAskMode: false }),
  usePrimarySettingsAvailable: () => true,
  useUpdatePrimarySettings: () => state.updateSettings,
}));

function setup() {
  const updateSettings = vi.fn();
  state.updateSettings = updateSettings;
  return updateSettings;
}

const ui = (
  <SidebarProvider>
    <SidebarAskModeItem />
  </SidebarProvider>
);

describe("SidebarAskModeItem", () => {
  it("does not keep focus after a click, so a later Space cannot flip it again", async () => {
    const updateSettings = setup();
    await using screen = await render(ui);
    const toggle = screen.getByRole("button", { name: /Ask mode/ });

    await userEvent.click(toggle);
    await userEvent.keyboard(" ");

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveFocus();
  });

  it("still toggles from the keyboard", async () => {
    const updateSettings = setup();
    await using screen = await render(ui);

    await userEvent.tab();
    await expect.element(screen.getByRole("button", { name: /Ask mode/ })).toHaveFocus();
    await userEvent.keyboard(" ");

    expect(updateSettings).toHaveBeenCalledWith({ dontAskMode: true });
  });
});
