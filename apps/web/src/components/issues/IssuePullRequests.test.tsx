import { GTProvider, initializeGT } from "gt-react";
import { expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { IssuePullRequests } from "./IssuePullRequests";

it("shows an older server's count without an empty link or popover", () => {
  initializeGT({ defaultLocale: "en", loadTranslations: async () => ({}) });
  const render = (count: number) =>
    renderToStaticMarkup(
      <GTProvider locale="en" translations={{ en: {} }}>
        <IssuePullRequests count={count} />
      </GTProvider>,
    );
  const html = render(3);
  expect(html).toContain(">3</span>");
  expect(html).toContain('aria-label="3 linked pull requests"');
  expect(html).not.toContain("<a");
  expect(html).not.toContain("<button");
  expect(render(0)).toBe("");
});
