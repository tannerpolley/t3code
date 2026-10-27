import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { forkTriggerDisplayModelName } from "./ForkModelNames";

it("can show the full model name while upstream owns shortened names", () => {
  const model = { slug: "claude-opus-5-5", name: "Claude Opus 5.5" };
  expect(forkTriggerDisplayModelName(model, ProviderDriverKind.make("claudeAgent"), false)).toBe(
    "Claude Opus 5.5",
  );
  expect(forkTriggerDisplayModelName(model, ProviderDriverKind.make("claudeAgent"), true)).toBe(
    "Opus 5.5",
  );
});
