import { describe, expect, it } from "vite-plus/test";

import { summarizeT3ToolCalls, type T3ToolSummaryCall } from "./t3ToolSummary.ts";

function completed(input: unknown, output?: unknown): T3ToolSummaryCall {
  return { input, output, outcome: "completed" };
}

describe("summarizeT3ToolCalls", () => {
  it("summarizes the number of questions asked with the shared T3 tool", () => {
    expect(
      summarizeT3ToolCalls("question-ask", [
        completed({ questions: [{ id: "one" }, { id: "two" }] }, {}),
        completed({ questions: [{ id: "three" }] }, {}),
      ]).label,
    ).toBe("Asked 3 questions");
  });
});
