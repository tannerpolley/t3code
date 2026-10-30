import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  turnItemHasDetail,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "./itemDetail.ts";

function toolItem(output: unknown): Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> {
  return {
    id: TurnItemId.make("images"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    type: "dynamic_tool",
    toolName: "screenshots",
    input: {},
    output,
  };
}

describe("tool image output parsing", () => {
  it.each(["array", "content"] as const)(
    "keeps markers for images beyond the served positions in %s output",
    (shape) => {
      // Detail responses retain image metadata after the server strips image bytes.
      const image = { type: "image", mimeType: "image/png" };
      const blocks = Array.from({ length: 8 }, () => ({ ...image }));
      const wrap = (content: unknown[]) => (shape === "array" ? content : { content });
      const withinLimit = toolItem(wrap(blocks));
      expect(turnItemOutputText(withinLimit)).toBeNull();
      expect(turnItemOutputImages(withinLimit)).toHaveLength(8);

      const overflow = toolItem(
        wrap([
          ...blocks,
          { type: "text", text: "Two additional screenshots:" },
          { ...image, sizeBytes: 100 },
          { type: "image", source: { type: "base64", media_type: "image/jpeg" } },
        ]),
      );
      expect(turnItemOutputImages(overflow)).toHaveLength(8);
      expect(turnItemOutputText(overflow)).toBe("Two additional screenshots:\n[image]\n[image]");
    },
  );
});

it("renders retained tool metadata and the age marker without fetching missing output", () => {
  const marker = "[Tool output removed for age]";
  for (const item of [
    toolItem(marker),
    {
      ...toolItem(marker),
      type: "command_execution" as const,
      input: "git status",
      output: marker,
      exitCode: 1,
    },
  ]) {
    expect(turnItemHasDetail(item)).toBe(true);
    expect(turnItemNeedsDetailFetch(item)).toBe(false);
    expect(turnItemOutputText(item)).toBe(marker);
    expect(turnItemOutputImages(item)).toEqual([]);
  }
});
