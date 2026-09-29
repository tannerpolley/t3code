import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SHELL_RUN_OUTPUT,
  feedShellRunOutput,
  formatShellRunMessage,
  normalizeShellCommand,
  parseShellRunMessage,
  shellRunOutputTail,
  type ShellRunOutput,
} from "./shellRun";

const START = "\u001b]7777;t3-run-start\u0007";
const end = (code: number) => `\u001b]7777;t3-run-end;${code}\u0007`;

function feedAll(chunks: ReadonlyArray<string>): ShellRunOutput {
  return chunks.reduce(feedShellRunOutput, EMPTY_SHELL_RUN_OUTPUT);
}

describe("normalizeShellCommand", () => {
  it("runs a plain multi-line block as a script", () => {
    expect(normalizeShellCommand("cd app\nnpm test\n")).toBe("cd app\nnpm test");
  });

  it("keeps only prompted lines and their continuations from a transcript", () => {
    expect(normalizeShellCommand("$ ls \\\n  -la\ntotal 0\n$ echo hi\nhi\n")).toBe(
      "ls \\\n  -la\necho hi",
    );
  });
});

describe("feedShellRunOutput", () => {
  it("keeps only what the command printed and reads its exit code", () => {
    const output = feedAll([
      ` sh -c "$T3CODE_RUN_WRAPPER"\r\n\u001b[2m$ make\u001b[0m\r\n${START}`,
      "\u001b[31mbuild failed\u001b[0m\r\n",
      `${end(2)}\u001b]0;user@host\u0007$ `,
    ]);
    expect(output).toMatchObject({ done: true, exitCode: 2, text: "build failed\r\n" });
  });

  it("finds markers and escape sequences split across chunks", () => {
    const whole = `prompt ${START}one\r\n\u001b[1mtwo\u001b[0m\r\n${end(0)}`;
    const chunks = whole.match(/[\s\S]{1,3}/g) ?? [];
    expect(feedAll(chunks)).toMatchObject({ done: true, exitCode: 0, text: "one\r\ntwo\r\n" });
  });

  it("finishes when scrollback no longer holds the start marker", () => {
    const output = feedAll(["...tail of a long run\r\n\u001b]7777;t3-run-e", "nd;1\u0007$ "]);
    expect(output).toMatchObject({ done: true, exitCode: 1 });
  });

  it("is not finished until the end marker arrives", () => {
    const output = feedAll([START, "working\r\n\u001b]7777;t3-run-e"]);
    expect(output).toMatchObject({ done: false, exitCode: null, text: "working\r\n" });
  });
});

describe("shellRunOutputTail", () => {
  it("shows the last lines as a terminal would and counts the rest", () => {
    const output = feedAll([START, "a\r\nb\r\n10%\r50%\r100%\r\nc\r\n", end(0)]);
    expect(shellRunOutputTail(output, 2)).toEqual({ lines: ["100%", "c"], hiddenLines: 2 });
  });

  it("counts lines dropped from a long run", () => {
    const line = `${"x".repeat(99)}\n`;
    const output = feedAll([START, line.repeat(1000), end(0)]);
    const tail = shellRunOutputTail(output, 10);
    expect(tail.lines).toHaveLength(10);
    expect(tail.hiddenLines).toBe(990);
  });
});

describe("shell run messages", () => {
  it("round-trips a command, exit code and output", () => {
    const text = formatShellRunMessage({
      command: "echo '```'\nfalse",
      exitCode: 1,
      output: { text: "```\r\n", droppedLines: 0 },
    });
    expect(parseShellRunMessage(text)).toEqual({
      command: "echo '```'\nfalse",
      exitCode: 1,
      output: "```",
      truncated: false,
    });
  });

  it("keeps only the tail of long output and says so", () => {
    const text = formatShellRunMessage({
      command: "yes | head -n 100000",
      exitCode: 0,
      output: { text: "y\n".repeat(20_000), droppedLines: 0 },
    });
    const parsed = parseShellRunMessage(text);
    expect(parsed?.truncated).toBe(true);
    expect(parsed?.output.length).toBeLessThanOrEqual(16 * 1024);
  });

  it("recognizes a run that printed nothing, and nothing else", () => {
    const text = formatShellRunMessage({
      command: "true",
      exitCode: 0,
      output: { text: "", droppedLines: 0 },
    });
    expect(parseShellRunMessage(text)).toEqual({
      command: "true",
      exitCode: 0,
      output: "",
      truncated: false,
    });
    expect(parseShellRunMessage(`Please look at this:\n\n${text}`)).toBeNull();
  });
});
