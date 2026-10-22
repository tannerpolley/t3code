import { describe, expect, it } from "vite-plus/test";

import { shortModelSelectionEffort } from "./threadExecution.ts";

describe("shortModelSelectionEffort", () => {
  it("shortens catalog labels and preserves provider extras", () => {
    expect(shortModelSelectionEffort("Low")).toBe("Low");
    expect(shortModelSelectionEffort("Medium")).toBe("Med");
    expect(shortModelSelectionEffort("High")).toBe("High");
    expect(shortModelSelectionEffort("Extra High")).toBe("XHigh");
    expect(shortModelSelectionEffort("xhigh")).toBe("XHigh");
    expect(shortModelSelectionEffort("Maximum")).toBe("Max");
    expect(shortModelSelectionEffort("Ultra")).toBe("Ultra");
    expect(shortModelSelectionEffort(null)).toBeNull();
  });
});
