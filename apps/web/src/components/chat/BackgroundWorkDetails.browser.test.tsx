import "~/index.css";
import { EnvironmentId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
vi.mock(import("./CommandOutputPanel"), () => ({
  useCommandOutputStreaming: () => true,
  CommandOutputPanel: (props: { itemId: string; threadId: string }) => (
    <div data-testid="command-output" data-item-id={props.itemId} data-thread-id={props.threadId}>
      Command output stream
    </div>
  ),
}));

import { render } from "../../../test/render";
import { backgroundWorkNowItem } from "./ThreadActivityBanners";
import { ThreadNow } from "./ThreadNow";

it("opens full command details for short labels and keeps pending tasks current", async () => {
  const onOpenThread = vi.fn();
  const command = "python3 audit.py -j 6\n> scratch/audit.log 2>&1";
  const commandItem = (status: "running" | "completed") => ({
    id: TurnItemId.make("bash-1"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-09T00:00:00Z"),
    type: "command_execution" as const,
    input: command,
    output: "Command running in background with ID: native-task",
  });
  const view = (
    description?: string,
    status: "running" | "completed" = "completed",
    explicitItem = true,
    includeAgent = false,
  ) => (
    <ThreadNow
      attention={null}
      syncPhase={null}
      goal={null}
      work={backgroundWorkNowItem({
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("thread"),
        tasks: [
          {
            taskId: "native-task",
            sourceThreadId: ThreadId.make("source-thread"),
            itemId: explicitItem ? TurnItemId.make("bash-1") : undefined,
            kind: "command",
            description,
            command,
            awaited: true,
          },
          ...(includeAgent
            ? [
                {
                  taskId: "agent",
                  kind: "subagent" as const,
                  childThreadId: ThreadId.make("child"),
                  description: "Worker detail",
                },
              ]
            : []),
        ],
        turnItems: [
          commandItem(status),
          {
            ...commandItem("running"),
            id: TurnItemId.make("native-match"),
            nativeItemRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "native-task",
              strength: "strong",
            },
            ordinal: 2,
          },
        ],
        stopDisabled: false,
        stopping: false,
        onStop: async () => undefined,
        onOpenThread,
      })}
    />
  );
  await using screen = await render(view("Audit"));
  await screen.getByRole("button", { name: "Details", exact: true }).click();
  await vi.waitFor(() => expect(page.getByRole("dialog").element().textContent).toContain(command));
  await expect.element(page.getByText("Command output stream")).not.toBeInTheDocument();

  await screen.rerender(view(command));
  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();
  await screen.rerender(view());
  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();

  await screen.rerender(view("Check remaining modules", "running"));
  await expect
    .element(page.getByRole("heading", { name: "Check remaining modules" }))
    .toBeVisible();
  await page
    .getByRole("button", { name: "Show output for Check remaining modules", exact: true })
    .click();
  await expect.element(page.getByText("Command output stream")).toBeVisible();
  await expect
    .element(page.getByTestId("command-output"))
    .toHaveAttribute("data-item-id", "bash-1");
  await expect
    .element(page.getByTestId("command-output"))
    .toHaveAttribute("data-thread-id", "source-thread");
  await screen.rerender(view("Native fallback", "completed", false));
  await expect.element(page.getByText("Command output stream")).toBeVisible();
  await expect
    .element(page.getByTestId("command-output"))
    .toHaveAttribute("data-item-id", "native-match");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await screen.rerender(view("Native fallback", "completed", false, true));
  await screen.getByRole("button", { name: "Details", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Worker detail", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Open thread", exact: true }).click();
  expect(onOpenThread).toHaveBeenCalledWith(ThreadId.make("child"));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
