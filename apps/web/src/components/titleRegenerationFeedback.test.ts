import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { titleRegenerationToast } from "./threadTitleRegenerationToast";

describe("titleRegenerationToast", () => {
  it("stays quiet when every title changed", () => {
    expect(
      titleRegenerationToast([
        AsyncResult.success({ status: "renamed" }),
        AsyncResult.success(null),
      ]),
    ).toBeNull();
  });

  it("reports a single kept or failed title", () => {
    expect(titleRegenerationToast([AsyncResult.success({ status: "unchanged" })])?.title).toBe(
      "Title kept",
    );
    expect(titleRegenerationToast([AsyncResult.success({ status: "failed" })])?.type).toBe("error");
  });

  it("summarizes a bulk Regenerate in one toast", () => {
    expect(
      titleRegenerationToast([
        AsyncResult.success({ status: "renamed" }),
        AsyncResult.success({ status: "unchanged" }),
        AsyncResult.success({ status: "failed", message: "Provider unavailable" }),
      ]),
    ).toMatchObject({
      type: "error",
      title: "Failed to regenerate 1 of 3 thread titles",
      description: "Provider unavailable",
    });
    expect(
      titleRegenerationToast([
        AsyncResult.success({ status: "renamed" }),
        AsyncResult.success({ status: "unchanged" }),
        AsyncResult.success({ status: "unchanged" }),
      ])?.title,
    ).toBe("Kept 2 of 3 titles");
  });
});
