import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

/**
 * A complete inline `$…$` span: no space just inside either dollar, no escaped closing
 * dollar, and no digit right after it. "$2/x$" qualifies; "$5 and $10" does not.
 */
export const DOLLAR_MATH_SPAN = /\$(?=\S)[^$]*[^\s$\\]\$(?!\d)/u;

const DOLLAR_MATH_SPAN_START = new RegExp(`^${DOLLAR_MATH_SPAN.source}`, "u");

// `$name` or a plugin's `$plugin:name` skill reference, followed by a boundary. Plugin-scoped
// references are never math even when the skill list isn't loaded (`$x:y$` still is).
const SKILL_REFERENCE = /^\$([\p{L}\p{N}_-]+(?::[\p{L}\p{N}_-]+)?)(?=$|[\s.,!?;:)\]'"])/u;

function isSkillReference(text: string, knownSkills: ReadonlySet<string>): boolean {
  const name = SKILL_REFERENCE.exec(text)?.[1];
  if (name === undefined) return false;
  return name.includes(":") || knownSkills.has(name.toLowerCase());
}

/**
 * Prepares chat markdown for remark-math: `\( \)` and `\[ \]` formulas become placeholders that
 * `remarkProviderMath` turns into math nodes. Single dollars outside complete Pandoc math
 * spans and dollars that open skill references are escaped. Code stays untouched.
 */
export function normalizeProviderMathDelimiters(
  source: string,
  skillNames: readonly string[] = [],
): string {
  const knownSkills = new Set(skillNames.map((name) => name.toLowerCase()));
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let inlineTicks = 0;
  let sourceOffset = 0;
  let mathSpanEnd = 0;
  let nextPairId = 0;
  type ProviderPair = { open: string; close?: string; display: boolean };
  const pairs: ProviderPair[] = [];
  let inlinePair: ProviderPair | null = null;
  let displayPair: ProviderPair | null = null;
  const placeholder = () => `\u{e000}${nextPairId++}\u{e001}`;
  let normalized = source
    .split(/(\n)/)
    .map((part) => {
      const offset = sourceOffset;
      sourceOffset += part.length;
      if (part === "\n") return part;
      const fenceRun = part.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
      if (fence) {
        if (
          fenceRun?.[0] === fence.marker &&
          fenceRun.length >= fence.length &&
          new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`, "u").test(part)
        ) {
          fence = null;
        }
        return part;
      }
      if (fenceRun) {
        fence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
        return part;
      }

      let line = "";
      for (let index = 0; index < part.length;) {
        if (offset + index < mathSpanEnd) {
          line += part[index++];
          continue;
        }
        if (part[index] === "`") {
          let end = index + 1;
          while (part[end] === "`") end++;
          const runLength = end - index;
          inlineTicks = inlineTicks === 0 ? runLength : inlineTicks === runLength ? 0 : inlineTicks;
          line += part.slice(index, end);
          index = end;
          continue;
        }
        if (inlineTicks === 0) {
          const delimiter = part.slice(index, index + 2);
          if (delimiter === "\\$" || delimiter === "\\\\") {
            line += delimiter;
            index += 2;
            continue;
          }
          if (delimiter === "\\(" && inlinePair === null) {
            inlinePair = { open: placeholder(), display: false };
            pairs.push(inlinePair);
            line += inlinePair.open;
            index += 2;
            continue;
          }
          if (delimiter === "\\)" && inlinePair !== null) {
            inlinePair.close = placeholder();
            line += inlinePair.close;
            inlinePair = null;
            index += 2;
            continue;
          }
          if (delimiter === "\\[" && displayPair === null) {
            displayPair = { open: placeholder(), display: true };
            pairs.push(displayPair);
            line += displayPair.open;
            index += 2;
            continue;
          }
          if (delimiter === "\\]" && displayPair !== null) {
            displayPair.close = placeholder();
            line += displayPair.close;
            displayPair = null;
            index += 2;
            continue;
          }
          if (part[index] === "$") {
            const rest = source.slice(offset + index);
            const dollarRun = /^\${2,}/u.exec(rest)?.[0];
            const span = dollarRun
              ? /^(\${2,})[\s\S]*?\1(?!\$)/u.exec(rest)?.[0]
              : !isSkillReference(rest, knownSkills)
                ? DOLLAR_MATH_SPAN_START.exec(rest)?.[0]
                : undefined;
            if (span) {
              // Keep the closing delimiter (including one on a later line) with its opener.
              mathSpanEnd = offset + index + span.length;
            } else if (dollarRun) {
              line += dollarRun;
              index += dollarRun.length;
              continue;
            } else {
              line += "\\$";
              index++;
              continue;
            }
          }
        }
        line += part[index];
        index++;
      }
      return line;
    })
    .join("");
  for (const pair of pairs) {
    if (!pair.close) {
      normalized = normalized.replace(pair.open, pair.display ? "\\[" : "\\(");
      continue;
    }
    const start = normalized.indexOf(pair.open);
    const end = normalized.indexOf(pair.close, start + pair.open.length);
    if (start < 0 || end < 0) continue;
    const formula = normalized.slice(start + pair.open.length, end);
    // Hex keeps the formula out of markdown's reach (backslash escapes such as \, and
    // emphasis markers); remarkProviderMath decodes it into the math node.
    const encoded = Array.from(new TextEncoder().encode(formula), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    normalized = `${normalized.slice(0, start)}\u{e000}${pair.display ? "D" : "I"}${encoded}\u{e001}${normalized.slice(end + pair.close.length)}`;
  }
  return normalized;
}

// The chat sanitizer keeps only `language-*` classes on code, so a provider display formula
// crosses it under this class and gets the classes rehype-katex reads afterwards.
const PROVIDER_DISPLAY_MATH_CLASS = "language-math-display";

type MathAstNode = {
  type?: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: MathAstNode[];
};

/** Decodes the formulas `normalizeProviderMathDelimiters` encoded into math nodes for KaTeX. */
export function remarkProviderMath() {
  return (tree: MathAstNode) => {
    const visit = (node: MathAstNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          return child;
        }
        const parts: MathAstNode[] = [];
        let cursor = 0;
        for (const match of child.value.matchAll(/\u{e000}([ID])([0-9a-f]*)\u{e001}/gu)) {
          const start = match.index;
          if (start > cursor) parts.push({ type: "text", value: child.value.slice(cursor, start) });
          const value = new TextDecoder().decode(
            Uint8Array.from(match[2]?.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16)),
          );
          parts.push({
            type: "inlineMath",
            value,
            data: {
              hName: "code",
              hProperties: {
                className:
                  match[1] === "D"
                    ? [PROVIDER_DISPLAY_MATH_CLASS]
                    : ["language-math", "math-inline"],
              },
              // remark-math sets this too; without it the formula never reaches KaTeX.
              hChildren: [{ type: "text", value }],
            },
          });
          cursor = start + match[0].length;
        }
        if (cursor === 0) return child;
        if (cursor < child.value.length) {
          parts.push({ type: "text", value: child.value.slice(cursor) });
        }
        return parts;
      });
    };
    visit(tree);
  };
}

type MathHastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MathHastNode[];
};

function rehypeProviderDisplayMath() {
  return (tree: MathHastNode) => {
    const visit = (node: MathHastNode) => {
      const className = node.properties?.className;
      if (
        node.tagName === "code" &&
        Array.isArray(className) &&
        className.includes(PROVIDER_DISPLAY_MATH_CLASS)
      ) {
        node.properties = { ...node.properties, className: ["language-math", "math-display"] };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** Appended to the shared chat markdown remark plugins while the `chatMath` setting is on. */
export const CHAT_MATH_REMARK_PLUGINS: PluggableList = [remarkMath, remarkProviderMath];

/**
 * Appended after the shared chat markdown rehype plugins, so after the sanitizer. KaTeX output
 * is generated from the formula text, not taken from the source.
 */
export const CHAT_MATH_REHYPE_PLUGINS: PluggableList = [rehypeProviderDisplayMath, rehypeKatex];
