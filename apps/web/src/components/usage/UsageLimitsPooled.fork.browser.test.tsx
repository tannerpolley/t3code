import { act, render } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

// Real pointer clicks need the dialog's stacking styles to land above Base UI's modal overlay.
import "~/index.css";

const consume = vi.hoisted(() => vi.fn());
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => consume }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../settings/RedactedSensitiveText", () => ({ RedactedSensitiveText: () => null }));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const presentations = (
  resetsAt: string | undefined,
  availableCount: number,
  creditId = "credit-a",
): LimitPresentations =>
  new Map([
    [
      EnvironmentId.make("env-a"),
      {
        entry: { target: { label: "Test" } },
        serverConfig: {
          usageLimitSources: [],
          providers: [
            {
              instanceId: ProviderInstanceId.make("alpha"),
              driver: ProviderDriverKind.make("codex"),
              displayName: "Alpha",
              enabled: true,
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "authenticated", email: "alpha@example.com" },
              checkedAt: "2026-09-03T11:00:00Z",
              models: [],
              slashCommands: [],
              skills: [],
              usageLimits: {
                checkedAt: "2026-09-03T11:00:00Z",
                resetCredits: { availableCount, nextCreditId: creditId },
                windows: [
                  {
                    id: "five_hour",
                    kind: "session",
                    label: "Session",
                    usedPercent: resetsAt ? 40 : 0,
                    windowDurationMins: 300,
                    ...(resetsAt ? { resetsAt } : {}),
                  },
                ],
              },
            } satisfies ServerProvider,
          ],
        },
      },
    ],
  ]);

function setup() {
  consume.mockReset();
}
const initial = () => (
  <UsageLimitsPooled presentations={presentations("2026-09-03T14:00:00Z", 1)} now={0} />
);

async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === label || node.getAttribute("aria-label")?.startsWith(label),
  );
  expect(button).toBeDefined();
  await userEvent.click(button!);
}

async function clickInPopover(label: string) {
  const popup = document.querySelector('[data-slot="popover-popup"]');
  const button = popup
    ? Array.from(popup.querySelectorAll("button")).find((node) => node.textContent === label)
    : undefined;
  expect(button).toBeDefined();
  await userEvent.click(button!);
}

it.each([
  {
    label: "success",
    result: { _tag: "Success", value: { outcome: "reset" } },
    text: "Reset applied. Your windows have cleared.",
  },
  {
    label: "failure",
    result: { _tag: "Failure", cause: { error: new Error("Codex rejected the credit.") } },
    text: "Codex rejected the credit.",
  },
])("keeps pending feedback outside the closed popup until $label", async ({ result, text }) => {
  setup();
  await using _screen = await render(initial());
  let answer!: (result: unknown) => void;
  consume.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await click("Alpha:");
  await clickInPopover("Use reset");
  expect(consume).not.toHaveBeenCalled();
  await click("Cancel");
  expect(consume).not.toHaveBeenCalled();
  await click("Alpha:");
  await clickInPopover("Use reset");
  await click("Use credit");
  expect(consume).toHaveBeenCalledOnce();
  // Both popups unmount once their exit animations finish.
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeNull();
  await expect.poll(() => document.querySelector('[data-slot="popover-popup"]')).toBeNull();
  const status = document.querySelector('[role="status"]');
  expect(status?.textContent).toBe("Alpha Using reset credit…");
  await click("Alpha:");
  const using = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === "Using…",
  );
  expect(using?.disabled).toBe(true);
  await act(async () => answer(result));
  expect(status?.textContent).toBe(`Alpha ${text}`);
});

it("confirms the displayed credit even if auto-use refreshes the account while the dialog is open", async () => {
  setup();
  consume.mockResolvedValue({ _tag: "Success", value: { outcome: "alreadyRedeemed" } });
  await using screen = await render(initial());
  await click("Alpha:");
  await clickInPopover("Use reset");
  await screen.rerender(
    <UsageLimitsPooled
      presentations={presentations("2026-09-03T14:00:00Z", 1, "credit-b")}
      now={0}
    />,
  );
  await click("Use credit");
  expect(consume).toHaveBeenCalledWith({
    environmentId: "env-a",
    input: { instanceId: "alpha", creditId: "credit-a" },
  });
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[role="status"]')?.textContent).toContain(
      "That credit was already redeemed.",
    ),
  );
});
