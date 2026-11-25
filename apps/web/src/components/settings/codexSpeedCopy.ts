import type { CodexDefaultSpeed } from "@t3tools/contracts";
import { msg } from "gt-react";

export const CODEX_SPEED_LABELS = {
  normal: msg("Normal", { $context: "model speed tier" }),
  fast: msg("Fast", { $context: "response speed" }),
  ultrafast: msg("Ultra fast", { $context: "response speed" }),
} satisfies Record<CodexDefaultSpeed, string>;
