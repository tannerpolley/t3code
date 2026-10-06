import type { DiscoveredLocalServer, LocalServerHideRule } from "@t3tools/contracts";

export function isLocalServerHidden(
  server: Pick<DiscoveredLocalServer, "port" | "processName">,
  rules: ReadonlyArray<LocalServerHideRule>,
): boolean {
  const processName = server.processName?.toLowerCase();
  return rules.some((rule) =>
    rule.kind === "process"
      ? rule.processName.toLowerCase() === processName
      : server.port >= Math.min(rule.from, rule.to) && server.port <= Math.max(rule.from, rule.to),
  );
}

/** Settings input: "5173" or "24282-24304" hides ports; anything else is a process name. */
export function parseLocalServerHideRule(input: string): LocalServerHideRule | null {
  const text = input.trim();
  if (text.length === 0) return null;
  const range = /^(\d+)\s*(?:[-–]\s*(\d+))?$/.exec(text);
  if (!range) return { kind: "process", processName: text };
  const from = Number(range[1]);
  const to = Number(range[2] ?? range[1]);
  if (![from, to].every((port) => port > 0 && port < 65_536)) return null;
  return { kind: "ports", from: Math.min(from, to), to: Math.max(from, to) };
}

export function describeLocalServerHideRule(rule: LocalServerHideRule): string {
  if (rule.kind === "process") return `Process ${rule.processName}`;
  return rule.from === rule.to ? `Port ${rule.from}` : `Ports ${rule.from}–${rule.to}`;
}

export function addLocalServerHideRule(
  rules: ReadonlyArray<LocalServerHideRule>,
  rule: LocalServerHideRule,
): ReadonlyArray<LocalServerHideRule> {
  const key = describeLocalServerHideRule(rule).toLowerCase();
  return rules.some((existing) => describeLocalServerHideRule(existing).toLowerCase() === key)
    ? rules
    : [...rules, rule];
}
