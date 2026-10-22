import type { PluggableList } from "unified";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { expect, it } from "vite-plus/test";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdownPipeline.ts";

type Node = {
  type: string;
  url?: string;
  value?: string;
  tagName?: string;
  properties?: { href?: string };
  children?: Node[];
};

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
        "vercel.app/x, web.dev/learn, github.io/foo, t3.codes/x and example.io/page",
      ].join("\n"),
    ),
  ).toEqual([
    "https://example.com/a -> https://example.com/a",
    "www.example.org -> http://www.example.org",
    "github.com/owner/repo -> https://github.com/owner/repo",
    "docs.python.org/3/ -> https://docs.python.org/3/",
    "example.com/page -> https://example.com/page",
    "en.wikipedia.org/wiki/Foo_(bar) -> https://en.wikipedia.org/wiki/Foo_(bar)",
    "vercel.app/x -> https://vercel.app/x",
    "web.dev/learn -> https://web.dev/learn",
    "github.io/foo -> https://github.io/foo",
    "t3.codes/x -> https://t3.codes/x",
    "example.io/page -> https://example.io/page",
  ]);
});

it("links a pathless address only on a classic TLD", () => {
  expect(
    links(
      "Use self.app, this.io, Dockerfile.dev, design.ai, 1.2.co, example.io?q=1#top and t3.codes. Visit example.com.",
      CHAT_MARKDOWN_REMARK_PLUGINS,
    ),
  ).toEqual(["example.com -> https://example.com"]);
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

it("leaves text inside raw HTML anchors and code alone", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const render = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName
        ? `<${node.tagName}${node.properties?.href ? ` ${node.properties.href}` : ""}>${(node.children ?? []).map(render).join("")}</${node.tagName}>`
        : (node.children ?? []).map(render).join("");
  const html = (markdown: string) => render(processor.runSync(processor.parse(markdown)) as Node);

  expect(html('<a href="https://other.dev">example.com</a> then example.com')).toBe(
    "<p><a https://other.dev>example.com</a> then <a https://example.com>example.com</a></p>",
  );
  expect(html("<code>example.com</code> and <kbd>a.com/x</kbd>")).toBe(
    "<p><code>example.com</code> and <kbd>a.com/x</kbd></p>",
  );
});

it("trims a run of unmatched closing parentheses in linear time", () => {
  // Quadratic trimming took minutes here, past the project test timeout.
  expect(links(`example.com/${")".repeat(100_000)}`)).toEqual([
    "example.com/ -> https://example.com/",
  ]);
});
