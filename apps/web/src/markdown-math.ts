/**
 * A complete inline `$…$` span: no space just inside either dollar, no escaped closing
 * dollar, and no digit right after it. "$2/x$" qualifies; "$5 and $10" does not.
 */
export const DOLLAR_MATH_SPAN = /\$[^\s$](?:[^$\n]*[^\s$\\])?\$(?!\d)/u;

const DOLLAR_MATH_SPAN_START = new RegExp(`^${DOLLAR_MATH_SPAN.source}`, "u");

// Amounts such as $5, $1,200, $5.00, $5k, $5/mo or $5+ are currency, not the start of math.
// ponytail: `$1 + 1$` also reads as currency; math starting with a digit and a space is rare.
const CURRENCY_START =
  /^\$(?=\d(?:[\p{L}\p{N}_-]*\p{L}|[\d,]*(?:\.\d+)?)(?=$|[\s.,!?;:)\]]|\/\p{L}|\+(?!\S)))/u;

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
 * `remarkProviderMath` turns into math nodes, and dollars that open currency or skill
 * references are escaped. Code spans and fenced code stay literal.
 */
export function normalizeProviderMathDelimiters(
  source: string,
  skillNames: readonly string[] = [],
): string {
  const knownSkills = new Set(skillNames.map((name) => name.toLowerCase()));
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let inlineTicks = 0;
  let nextPairId = 0;
  type ProviderPair = { open: string; close?: string; display: boolean };
  const pairs: ProviderPair[] = [];
  let inlinePair: ProviderPair | null = null;
  let displayPair: ProviderPair | null = null;
  const placeholder = () => `\u{e000}${nextPairId++}\u{e001}`;
  let normalized = source
    .split(/(\n)/)
    .map((part) => {
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
          const rest = part.slice(index);
          if (
            (CURRENCY_START.test(rest) && !DOLLAR_MATH_SPAN_START.test(rest)) ||
            isSkillReference(rest, knownSkills)
          ) {
            line += "\\$";
            index++;
            continue;
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
                className: ["language-math", match[1] === "D" ? "math-display" : "math-inline"],
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
