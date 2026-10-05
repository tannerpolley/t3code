import { describe, expect, it } from "vite-plus/test";

import { titleRegenerationToast } from "./titleRegenerationFeedback";

describe("titleRegenerationToast", () => {
  it("stays quiet when every title changed", () => {
    expect(titleRegenerationToast(["changed", "changed", null])).toBeNull();
  });

  it("reports a single kept or failed title", () => {
    expect(titleRegenerationToast(["unchanged"])?.title).toBe("Title still fits");
    expect(titleRegenerationToast(["failed"])?.type).toBe("error");
  });

  it("summarizes a bulk Regenerate in one toast", () => {
    expect(titleRegenerationToast(["changed", "unchanged", "unchanged", "failed"])).toEqual({
      type: "error",
      title: "Could not regenerate 1 title",
      description: "1 changed, 2 still fit, 1 failed.",
    });
    expect(titleRegenerationToast(["changed", "unchanged", "unchanged"])?.title).toBe(
      "2 titles still fit",
    );
  });
});
