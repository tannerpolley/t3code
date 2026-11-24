import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { LocalServerHideRule } from "@t3tools/contracts";

// The server's port scanner owns matching; these helpers only edit the environment's rule list.

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

export function describeLocalServerHideRule(
  rule: LocalServerHideRule,
  resolve: MessageResolver = m,
): string {
  if (rule.kind === "process")
    return resolve(msg("Process {processName}", { processName: rule.processName }));
  return rule.from === rule.to
    ? resolve(msg("Port {from}", { from: rule.from }))
    : resolve(msg("Ports {from}–{to}", { from: rule.from, to: rule.to }));
}
