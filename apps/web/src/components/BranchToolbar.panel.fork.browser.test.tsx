import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render as renderUi } from "../../test/render";

const state = vi.hoisted(() => ({
  worktreePath: "/tmp/worktree" as string | null,
  showContextMenu: vi.fn(),
  writeTextToClipboard: vi.fn(),
}));

vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ contextMenu: { show: state.showContextMenu } })) as never,
}));
vi.mock(import("../hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock(import("./BranchToolbarBranchSelector"), async (original) => ({
  ...(await original()),
  BranchToolbarBranchSelector: (() => null) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: (() => ({ workspaceRoot: "/tmp/project" })) as never,
  useThreadShellsForProjectRefs: () => [],
}));

import { BranchToolbar } from "./BranchToolbar";

function render(
  props: Partial<ComponentProps<typeof BranchToolbar>>,
  { worktreePath = "/tmp/worktree" }: { worktreePath?: string | null } = {},
) {
  state.worktreePath = worktreePath;
  state.showContextMenu.mockReset().mockResolvedValue("copy-path");
  state.writeTextToClipboard.mockReset().mockResolvedValue(true);
  return renderUi(
    <BranchToolbar
      layout="panel"
      panelSection="workspace"
      environmentId={EnvironmentId.make("local")}
      threadId={ThreadId.make("thread")}
      projectId={ProjectId.make("project")}
      worktreePath={state.worktreePath}
      isServerThread
      showGitControls
      envMode="local"
      envLocked={false}
      startFromOrigin={false}
      onStartFromOriginChange={vi.fn()}
      onEnvModeChange={vi.fn()}
      {...props}
    />,
  );
}

it("keeps machine choices usable when the combined row's workspace is locked", async () => {
  const onEnvironmentChange = vi.fn();
  await using screen = await render({
    onEnvironmentChange,
    availableEnvironments: ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id,
      isPrimary: id === "local",
      machine: "server",
    })),
  });
  const trigger = screen.container.querySelector("button")!;
  await expect.element(page.getByRole("button", { name: "Run context" })).toBeVisible();
  expect(screen.container.querySelectorAll("button")).toHaveLength(1);

  // A ctrl-click is a macOS secondary click; it must not open the menu.
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true }));
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();

  await userEvent.click(trigger);
  await expect
    .element(page.getByRole("menuitemradio", { name: "New worktree" }))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.click(page.getByRole("menuitemradio", { name: "remote" }));
  expect(onEnvironmentChange).toHaveBeenCalledWith("remote");
});
