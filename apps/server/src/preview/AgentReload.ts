import type { CDPSession, Page } from "playwright-core";

/**
 * Reloads a tab for `preview_navigate`'s `reload`, waiting for the same
 * readiness a navigation does. A hard reload refetches every resource, as
 * Chrome's Shift+Reload does, so an agent sees code it just edited.
 */
export const reloadPage = async (
  page: Page,
  cdp: CDPSession,
  mode: "normal" | "bypassCache",
  readiness: "load" | "domContentLoaded" | "none",
  timeout: number,
) => {
  if (mode === "normal") {
    await page.reload({
      timeout,
      waitUntil:
        readiness === "domContentLoaded"
          ? "domcontentloaded"
          : readiness === "none"
            ? "commit"
            : "load",
    });
    return;
  }
  // Playwright's reload cannot skip the cache, so CDP reloads and Playwright waits.
  const loaded =
    readiness === "none"
      ? undefined
      : readiness === "load"
        ? page.waitForEvent("load", { timeout })
        : page.waitForEvent("domcontentloaded", { timeout });
  await Promise.all([loaded, cdp.send("Page.reload", { ignoreCache: true })]);
};
