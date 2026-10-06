import { describe, expect, it } from "vite-plus/test";

import { addLocalServerHideRule, parseLocalServerHideRule } from "./localServerHideRules";

describe("parseLocalServerHideRule", () => {
  it("reads ports, ranges in either order, and process names", () => {
    expect(parseLocalServerHideRule(" 5173 ")).toEqual({ kind: "ports", from: 5173, to: 5173 });
    expect(parseLocalServerHideRule("24304 - 24282")).toEqual({
      kind: "ports",
      from: 24_282,
      to: 24_304,
    });
    expect(parseLocalServerHideRule("serena")).toEqual({ kind: "process", processName: "serena" });
    expect(parseLocalServerHideRule("70000")).toBeNull();
    expect(parseLocalServerHideRule("  ")).toBeNull();
  });

  it("does not add a rule twice", () => {
    const rules = addLocalServerHideRule([], { kind: "process", processName: "serena" });
    expect(addLocalServerHideRule(rules, { kind: "process", processName: "SERENA" })).toBe(rules);
  });
});
