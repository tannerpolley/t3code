import { CHAT_MARKDOWN_REHYPE_PLUGINS } from "@t3tools/shared/markdownPipeline";
import type { Root } from "mdast";
import Markdown from "react-markdown";
import type { Plugin } from "unified";
import { expect, it } from "vite-plus/test";

import {
  CHAT_MATH_REHYPE_PLUGINS,
  CHAT_MATH_REMARK_PLUGINS,
  normalizeProviderMathDelimiters,
} from "./markdown-math";

type RenderedNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: RenderedNode[];
};

it("uses Pandoc single-dollar boundaries while preserving formulas and code", () => {
  const shell = 'for i in $(seq 1 18); do echo "tick $i"; sleep 5; done';
  const cases = [
    [shell, [["text", shell]]],
    ["costs $5 and $10", [["text", "costs $5 and $10"]]],
    ["$HOME and $PATH", [["text", "$HOME and $PATH"]]],
    ["$ x$", [["text", "$ x$"]]],
    ["$x $", [["text", "$x $"]]],
    ["$x$2", [["text", "$x$2"]]],
    ["\\$x^2$", [["text", "$x^2$"]]],
    ["$x^2\\$", [["text", "$x^2$"]]],
    ["$\\$", [["text", "$$"]]],
    [
      "\\\\$x$",
      [
        ["text", "\\"],
        ["inlineMath", "x"],
      ],
    ],
    ["\\$5 and \\$10", [["text", "$5 and $10"]]],
    [
      "$x$ then $y$",
      [
        ["inlineMath", "x"],
        ["text", " then "],
        ["inlineMath", "y"],
      ],
    ],
    [
      "$x$ costs $5",
      [
        ["inlineMath", "x"],
        ["text", " costs $5"],
      ],
    ],
    [
      "$x +\ny$ costs $5",
      [
        ["inlineMath", "x +\ny"],
        ["text", " costs $5"],
      ],
    ],
    ["$x^2$", [["inlineMath", "x^2"]]],
    ["$1 + 1$", [["inlineMath", "1 + 1"]]],
    ["$x +\ny$", [["inlineMath", "x +\ny"]]],
    ["$$\\text{\\$5}$$", [["inlineMath", "\\text{\\$5}"]]],
    ["$$E=mc^2$$", [["inlineMath", "E=mc^2"]]],
    ["$$\nE=mc^2\n$$", [["math", "E=mc^2"]]],
    ["`echo $HOME`", [["inlineCode", "echo $HOME"]]],
    ["`$x^2$ $$E=mc^2$$`", [["inlineCode", "$x^2$ $$E=mc^2$$"]]],
    ["```sh\n" + shell + "\n$x^2$\n```", [["code", shell + "\n$x^2$"]]],
    ["~~~tex\n$$E=mc^2$$\n~~~", [["code", "$$E=mc^2$$"]]],
    ["```math\nx^2\n```", [["code", "x^2"]]],
    ["```math-display\nE=mc^2\n```", [["code", "E=mc^2"]]],
  ] as const;

  for (const [source, expected] of cases) {
    const mathFence = /^```math(?:-display)?\n/u.test(source);
    const parsed: [string, string][] = [];
    const renderedCode: string[] = [];
    let renderedMath = 0;
    const capture: Plugin<[], Root> = () => (tree) => {
      const visit = (node: Root | Root["children"][number]) => {
        if ("value" in node) parsed.push([node.type, node.value]);
        if ("children" in node) node.children.forEach(visit);
      };
      visit(tree);
    };
    const captureRendered: Plugin<[], RenderedNode> = () => (tree) => {
      const visit = (node: RenderedNode) => {
        if (node.type === "element") {
          if (node.tagName === "code") {
            renderedCode.push(node.children?.map((child) => child.value ?? "").join("") ?? "");
          }
          if (
            Array.isArray(node.properties?.className) &&
            node.properties.className.includes("katex")
          ) {
            renderedMath++;
          }
        }
        node.children?.forEach(visit);
      };
      visit(tree);
    };
    // Inspect the library's remark pipeline without mounting or rendering app components.
    Markdown({
      children: normalizeProviderMathDelimiters(source),
      remarkPlugins: [...CHAT_MATH_REMARK_PLUGINS, capture],
      rehypePlugins: [
        ...CHAT_MARKDOWN_REHYPE_PLUGINS,
        ...CHAT_MATH_REHYPE_PLUGINS,
        captureRendered,
      ],
    });
    expect(parsed, source).toEqual(expected);
    expect(renderedMath, source).toBe(
      mathFence ? 1 : expected.filter(([type]) => type === "inlineMath" || type === "math").length,
    );
    expect(renderedCode, source).toEqual(
      mathFence
        ? []
        : expected.flatMap(([type, value]) =>
            type === "code" ? [value + "\n"] : type === "inlineCode" ? [value] : [],
          ),
    );
  }
});
