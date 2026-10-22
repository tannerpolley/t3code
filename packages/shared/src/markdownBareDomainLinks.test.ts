import type { PluggableList } from "unified";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { expect, it } from "vite-plus/test";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdownPipeline.ts";

type Node = { type: string; url?: string; value?: string; children?: Node[] };

const text = (node: Node): string => node.value ?? (node.children ?? []).map(text).join("");

function links(
  markdown: string,
  plugins: PluggableList = CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
) {
  const processor = unified().use(remarkParse).use(plugins);
  const found: string[] = [];
  const visit = (node: Node) => {
    if (node.type === "link") found.push(`${text(node)} -> ${node.url}`);
    node.children?.forEach(visit);
  };
  visit(processor.runSync(processor.parse(markdown)) as Node);
  return found;
}

it("links every web address form in a user message", () => {
  expect(
    links(
      [
        "Read https://example.com/a and www.example.org.",
        "See github.com/owner/repo, docs.python.org/3/.",
        "(example.com/page) and en.wikipedia.org/wiki/Foo_(bar)!",
        "first line",
        "example.io?q=1#top",
      ].join("\n"),
    ),
  ).toEqual([
    "https://example.com/a -> https://example.com/a",
    "www.example.org -> http://www.example.org",
    "github.com/owner/repo -> https://github.com/owner/repo",
    "docs.python.org/3/ -> https://docs.python.org/3/",
    "example.com/page -> https://example.com/page",
    "en.wikipedia.org/wiki/Foo_(bar) -> https://en.wikipedia.org/wiki/Foo_(bar)",
    "example.io?q=1#top -> https://example.io?q=1#top",
  ]);
  expect(links("Ship it at t3.codes.", CHAT_MARKDOWN_REMARK_PLUGINS)).toEqual([
    "t3.codes -> https://t3.codes",
  ]);
});

it("leaves file names, versions, paths, code and existing links alone", () => {
  expect(
    links(
      [
        "Edit README.md, main.py, install.sh, foo.ts, package.json and Node.js at v1.2.3.",
        "Paths ./foo.com, src/a.com.ts, C:\\x\\b.com and me@example.com stay put.",
        "`example.com` and [docs](https://docs.example.com) and [example.com](https://other.dev)",
        "```",
        "curl example.com/api",
        "```",
      ].join("\n"),
    ),
  ).toEqual([
    "me@example.com -> mailto:me@example.com",
    "docs -> https://docs.example.com",
    "example.com -> https://other.dev",
  ]);
});
