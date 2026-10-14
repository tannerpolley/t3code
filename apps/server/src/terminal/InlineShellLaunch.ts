import type { InlineShellLanguage } from "@t3tools/contracts";
import type { ShellCandidate } from "./Manager.ts";

export function inlineShellCandidates(
  input: { command: string; language: InlineShellLanguage },
  defaults: readonly ShellCandidate[],
): readonly ShellCandidate[] {
  const shell = input.language === "shell" ? (defaults[0]?.shell ?? "sh") : input.language;
  const cmd = /(?:^|[/\\])cmd(?:\.exe)?$/i.test(shell);
  const powershell = /(?:^|[/\\])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell);
  return [
    {
      shell,
      args: powershell
        ? ["-NoLogo", "-NoProfile", "-Command", input.command]
        : cmd
          ? ["/d", "/s", "/c", input.command]
          : ["-c", input.command],
    },
  ];
}
