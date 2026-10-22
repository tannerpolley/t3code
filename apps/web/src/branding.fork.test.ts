import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("lets a dev server present with an explicit stage label", async () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_APP_STAGE_LABEL", "Alpha");

    const branding = await import("./branding");

    expect(branding.APP_STAGE_LABEL).toBe("Alpha");
    expect(branding.APP_DISPLAY_NAME).toBe("T3 Code (Alpha)");
  });
});
