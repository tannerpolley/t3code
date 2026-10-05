import { describe, expect, it } from "vite-plus/test";

import { markdownImageUnavailableLabel } from "./markdownImageState";

describe("markdown image failures", () => {
  it("shows the host path and known signing reason, only after failure", () => {
    const path = "/tmp/lineage-mock/lineage-compare.png";
    expect(markdownImageUnavailableLabel({ path })).toBeNull();
    expect(
      markdownImageUnavailableLabel({
        path,
        sourceFailed: true,
        reason: "Media file was not found.",
      }),
    ).toBe(`Image not available: ${path} (Media file was not found.)`);
    expect(markdownImageUnavailableLabel({ path, sourceFailed: true })).toBe(
      `Image not available: ${path}`,
    );
  });

  it("shows a browser decode failure even when signing succeeded", () => {
    const path = "/home/demo/Pictures/shot.png";
    expect(
      markdownImageUnavailableLabel({
        path,
        sourceFailed: false,
        loadFailed: true,
        reason: "Could not load or decode the image.",
      }),
    ).toBe(`Image not available: ${path} (Could not load or decode the image.)`);
    expect(
      markdownImageUnavailableLabel({ path, sourceFailed: false, loadFailed: false }),
    ).toBeNull();
  });
});
