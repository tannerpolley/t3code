// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.

// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import { vi } from "vite-plus/test";

import { assert, it } from "@effect/vitest";

import { buildClaudeCapabilitiesProbeQueryOptions } from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

it("reads only user settings when the probe starts in the home directory", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: "/home/user/",
    managedMcpConfig: false,
  });
  assert.deepEqual(options.settingSources, ["user"]);
});
