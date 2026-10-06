import { describe, expect, it } from "vite-plus/test";

import {
  addLocalServerHideRule,
  isLocalServerHidden,
  parseLocalServerHideRule,
} from "./localServerHideRules";

const serena = { port: 24_290, processName: "serena" };
const preview = { port: 8770, processName: "deno" };

describe("isLocalServerHidden", () => {
  it("hides a single entry by its port only", () => {
    const rules = [{ kind: "ports", from: 8770, to: 8770 }] as const;
    expect(isLocalServerHidden(preview, rules)).toBe(true);
    expect(isLocalServerHidden({ ...preview, port: 8771 }, rules)).toBe(false);
  });

  it("hides a process family regardless of case, and only that process", () => {
    const rules = [{ kind: "process", processName: "Serena" }] as const;
    expect(isLocalServerHidden(serena, rules)).toBe(true);
    expect(isLocalServerHidden(preview, rules)).toBe(false);
    expect(isLocalServerHidden({ port: 3000, processName: null }, rules)).toBe(false);
  });

  it("hides an inclusive port range", () => {
    const rules = [{ kind: "ports", from: 24_282, to: 24_304 }] as const;
    expect(isLocalServerHidden({ ...serena, port: 24_282 }, rules)).toBe(true);
    expect(isLocalServerHidden({ ...serena, port: 24_304 }, rules)).toBe(true);
    expect(isLocalServerHidden({ ...serena, port: 24_305 }, rules)).toBe(false);
    expect(isLocalServerHidden(preview, [])).toBe(false);
  });
});

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
