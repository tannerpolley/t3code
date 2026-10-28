import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { UserInputQuestion } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(UserInputQuestion);

describe("UserInputQuestion", () => {
  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      id: "sandbox_mode",
      isSecret: true,
      header: "Sandbox",
      question: "Which mode should be used?",
      options: [
        { label: "workspace-write", description: "Allow edits in workspace only" },
        { label: "danger-full-access", description: "Allow unrestricted access" },
      ],
    });
    expect(parsed.id).toBe("sandbox_mode");
    expect(parsed.options).toHaveLength(2);
    expect(parsed).not.toHaveProperty("isSecret");
  });
});
