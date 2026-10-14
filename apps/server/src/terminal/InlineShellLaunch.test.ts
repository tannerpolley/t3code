import { expect, it } from "vite-plus/test";
import { inlineShellCandidates } from "./InlineShellLaunch.ts";

it("passes a command as a single shell argument, including Windows default shells", () => {
  const command = 'printf "one; two"';
  expect(inlineShellCandidates({ command, language: "bash" }, [])).toEqual([
    { shell: "bash", args: ["-c", command] },
  ]);
  expect(inlineShellCandidates({ command, language: "pwsh" }, [])).toEqual([
    { shell: "pwsh", args: ["-NoLogo", "-NoProfile", "-Command", command] },
  ]);
  expect(
    inlineShellCandidates({ command, language: "shell" }, [
      { shell: "C:\\Windows\\System32\\cmd.exe" },
    ]),
  ).toEqual([{ shell: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c", command] }]);
});
