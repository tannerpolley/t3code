import { expect, it } from "@effect/vitest";

import { renderHtmlMath } from "./htmlMath.ts";

it("turns t3-math tags into MathML and leaves everything else as written", () => {
  const page = '<p>$x$ costs $5 and \\(y\\)</p><script>const s = "\\\\[z\\\\]";</script>';
  expect(renderHtmlMath(page)).toBe(page);

  const cases = [
    ["<t3-math>x^2</t3-math>", false, "x^2"],
    ["<t3-math display>x^2</t3-math>", true, "x^2"],
    ["<t3-math>$a &lt; b$</t3-math>", false, "a &lt; b"],
    ["<t3-math>\\(a\\)</t3-math>", false, "a"],
    ["<t3-math> $$\\sum_i a_i$$ </t3-math>", true, "\\sum_i a_i"],
    ["<T3-MATH>\\[c\\]</T3-MATH>", true, "c"],
  ] as const;
  for (const [tag, display, annotation] of cases) {
    const rendered = renderHtmlMath(`<p>${tag}</p>`);
    expect(rendered, tag).toMatch(/^<p><span class="katex"><math /);
    expect(rendered.includes('display="block"'), tag).toBe(display);
    expect(rendered, tag).toContain(
      `<annotation encoding="application/x-tex">${annotation}</annotation>`,
    );
  }
});
