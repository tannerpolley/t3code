import { describe, expect, it } from "vite-plus/test";
import {
  appendBackgroundTaskOutput,
  BACKGROUND_TASK_OUTPUT_BUFFER_CHARS,
} from "./orchestration.ts";

describe("background task output buffer", () => {
  it("appends incremental output, replaces on reset, and bounds a long-running viewer", () => {
    expect(appendBackgroundTaskOutput("old", { text: " new", reset: false })).toBe("old new");
    expect(appendBackgroundTaskOutput("old", { text: "restarted", reset: true })).toBe("restarted");
    const tail = appendBackgroundTaskOutput("x".repeat(BACKGROUND_TASK_OUTPUT_BUFFER_CHARS), {
      text: "end",
      reset: false,
    });
    expect(tail.length).toBe(BACKGROUND_TASK_OUTPUT_BUFFER_CHARS);
    expect(tail.endsWith("end")).toBe(true);
  });
});
