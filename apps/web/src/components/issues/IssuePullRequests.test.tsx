import { expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { IssuePullRequests } from "./IssuePullRequests";

it("shows an older server's count without an empty link or popover", () => {
  const html = renderToStaticMarkup(<IssuePullRequests count={3} />);
  expect(html).toContain(">3</span>");
  expect(html).not.toContain("<a");
  expect(html).not.toContain("<button");
  expect(renderToStaticMarkup(<IssuePullRequests count={0} />)).toBe("");
});
