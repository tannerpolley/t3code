import katex from "katex";

// The server bundle has no KaTeX CSS or fonts, so formulas become MathML the browser draws itself.
const MATH_TAG = /<t3-math(\s[^>]*)?>([\s\S]*?)<\/t3-math\s*>/gi;
const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};
const DELIMITERS = [
  ["$$", "$$", true],
  ["\\[", "\\]", true],
  ["\\(", "\\)", false],
  ["$", "$", false],
] as const;

/** Replaces `<t3-math>TeX</t3-math>` (block with `display`, `$$…$$` or `\[…\]`) with MathML. */
export const renderHtmlMath = (html: string) =>
  html.replace(MATH_TAG, (_tag, attributes: string | undefined, body: string) => {
    const tex = body
      .replace(/&(?:lt|gt|amp|quot|#39|nbsp);/g, (entity) => ENTITIES[entity]!)
      .trim();
    const [open, close, block] = DELIMITERS.find(
      ([open, close]) =>
        tex.length >= open.length + close.length && tex.startsWith(open) && tex.endsWith(close),
    ) ?? ["", "", false];
    return katex.renderToString(tex.slice(open.length, tex.length - close.length), {
      displayMode: block || /\bdisplay\b/i.test(attributes ?? ""),
      output: "mathml",
      throwOnError: false,
    });
  });
