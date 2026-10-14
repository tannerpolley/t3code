import { describe, expect, it } from "vite-plus/test";
import { INLINE_SHELL_OUTPUT_BYTES } from "@t3tools/contracts";
import {
  inlineShellOutputTail,
  inlineShellCanWrite,
  inlineShellDisplayOutput,
  inlineShellIsPasswordPrompt,
} from "@t3tools/shared/inlineShell";
import { applyInlineShellOutput, emptyInlineShellOutput } from "./inlineShell.ts";

const base = { threadId: "thread", terminalId: "inline-test" };
describe("inline shell output", () => {
  it("retains the latest 200 lines, including a final newline, and caps UTF-8 without splitting characters", () => {
    const lines = Array.from({ length: 300 }, (_, n) => `line ${n}`).join("\n") + "\n";
    const tail = inlineShellOutputTail(lines);
    expect(tail.startsWith("line 100\n")).toBe(true);
    expect(tail.endsWith("line 299\n")).toBe(true);
    const unicode = inlineShellOutputTail("😀".repeat(10_000));
    expect(new TextEncoder().encode(unicode).length).toBeLessThanOrEqual(INLINE_SHELL_OUTPUT_BYTES);
    expect(unicode.includes("�")).toBe(false);
  });
  it("replaces output on reconnect, ignores duplicate events, and stops input after exit", () => {
    let state = applyInlineShellOutput(emptyInlineShellOutput, {
      ...base,
      type: "output",
      data: "before",
      sequence: 1,
    });
    state = applyInlineShellOutput(state, {
      ...base,
      type: "snapshot",
      snapshot: {
        ...base,
        cwd: "/tmp",
        worktreePath: null,
        status: "running",
        pid: 42,
        history: "retained",
        exitCode: null,
        exitSignal: null,
        label: "shell",
        updatedAt: "2026-10-13T00:00:00Z",
        sequence: 5,
      },
    });
    state = applyInlineShellOutput(state, {
      ...base,
      type: "output",
      data: "duplicate",
      sequence: 5,
    });
    expect(state.output).toBe("retained");
    state = applyInlineShellOutput(state, { ...base, type: "output", data: " tail", sequence: 6 });
    state = applyInlineShellOutput(state, {
      ...base,
      type: "exited",
      exitCode: 7,
      exitSignal: null,
      sequence: 7,
    });
    expect(state).toMatchObject({ output: "retained tail", status: "exited" });
    expect(inlineShellCanWrite("running")).toBe(true);
    for (const status of ["completed", "interrupted", "error"] as const)
      expect(inlineShellCanWrite(status)).toBe(false);
  });
  it("strips color sequences split across stream chunks without discarding their text", () => {
    let state = applyInlineShellOutput(emptyInlineShellOutput, {
      ...base,
      type: "output",
      data: "\x1b[3",
      sequence: 1,
    });
    state = applyInlineShellOutput(state, {
      ...base,
      type: "output",
      data: "1mhello\x1b[0m\r\n",
      sequence: 2,
    });
    expect(inlineShellDisplayOutput(state.output)).toBe("hello\n");
  });
});

it("recognizes inexpensive password prompts and leaves ordinary input visible", () => {
  expect(inlineShellIsPasswordPrompt("ready\nPassword: ")).toBe(true);
  expect(inlineShellIsPasswordPrompt("Enter passphrase for key: ")).toBe(true);
  expect(inlineShellIsPasswordPrompt("\x1b[31mPassword:\x1b[0m ")).toBe(true);
  expect(inlineShellIsPasswordPrompt("Password: done\nName: ")).toBe(false);
});
