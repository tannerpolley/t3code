import { describe, expect, it } from "vite-plus/test";

import { buildBranchNamePrompt, buildThreadTitlePrompt } from "./textGenerationPrompts.ts";

describe("buildBranchNamePrompt", () => {
  it("includes attachment metadata when attachments are provided", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the layout from screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-123",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 12345,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("screenshot.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("12345 bytes");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("regenerates from recent thread contents and identifies the current title", () => {
    const result = buildThreadTitlePrompt({
      message: `USER:\nInvestigate reconnect regressions\n\nASSISTANT:\nThe remaining issue is stale session state`,
      previousTitle: "Investigate reconnect regressions",
    });

    expect(result.prompt).toContain("what the thread is responsible for right now");
    expect(result.prompt).toContain('The current title is "Investigate reconnect regressions".');
    expect(result.prompt).toContain("Thread contents:");
    expect(result.prompt).toContain("The remaining issue is stale session state");
  });
});
