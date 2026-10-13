import type { IssueSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { issueProjectChips } from "./issueProjects.logic";

const planning = {
  id: "one",
  title: "Planning",
  status: "Todo",
  priority: { name: "High", rank: 0 },
};

describe("issue Project chips", () => {
  it("shows each available field and labels Projects only when there is more than one", () => {
    expect(issueProjectChips([planning]).map((chip) => chip.label)).toEqual([
      "Status: Todo",
      "Priority: High",
    ]);
    const projects: IssueSummary["projects"] = [
      planning,
      { id: "two", title: "Delivery", status: null, priority: { name: "Low", rank: 2 } },
    ];
    const chips = issueProjectChips(projects);
    expect(chips.map((chip) => chip.label)).toEqual([
      "Planning: Status: Todo",
      "Planning: Priority: High",
      "Delivery: Priority: Low",
    ]);
    expect(new Set(chips.map((chip) => chip.key)).size).toBe(chips.length);
  });

  it("omits missing values, including metadata from older servers", () => {
    expect(issueProjectChips()).toEqual([]);
    expect(issueProjectChips([{ ...planning, status: null, priority: null }])).toEqual([]);
  });
});
