/**
 * Running an assistant's shell code block in a hidden terminal session of its thread, and the
 * message that hands the result back to the agent.
 *
 * The session is a normal thread terminal (so "open in terminal" shows the whole run), with the
 * block in `T3CODE_RUN_SCRIPT` and this file's wrapper in `T3CODE_RUN_WRAPPER`; the typed line
 * only expands the wrapper, which works in bash, zsh and fish alike. The wrapper brackets the
 * command's output with two private OSC sequences, which terminals ignore, so the inline panel and
 * the agent see only what the command printed, and the end marker carries its exit status.
 */

const SHELL_LANGUAGES = new Set(["bash", "sh", "zsh", "shell", "console", "terminal"]);

/** Terminal env values are capped at this length by the terminal RPC contract. */
export const SHELL_RUN_MAX_COMMAND_CHARS = 8_192;

export function isShellRunLanguage(language: string): boolean {
  return SHELL_LANGUAGES.has(language.toLowerCase());
}

const PROMPT = /^\s*\$ /;

/**
 * The script a code block runs. With `$ ` prompts present (a `console` transcript), only the
 * prompted lines and their `\` continuations run, the rest being sample output; without any, the
 * whole block runs as a script.
 */
export function normalizeShellCommand(code: string): string {
  const lines = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (!lines.some((line) => PROMPT.test(line))) return lines.join("\n").trim();
  const commands: string[] = [];
  let continued = false;
  for (const line of lines) {
    if (PROMPT.test(line)) commands.push(line.replace(PROMPT, ""));
    else if (continued) commands.push(line);
    else continue;
    continued = line.endsWith("\\");
  }
  return commands.join("\n").trim();
}

const START_MARKER = "\u001b]7777;t3-run-start\u0007";
// eslint-disable-next-line no-control-regex -- terminal escape sequences
const END_MARKER = /\u001b\]7777;t3-run-end;(\d+)\u0007/;

/**
 * Runs `$T3CODE_RUN_SCRIPT` with bash (sh without it). The INT trap keeps the wrapper alive
 * through Ctrl+C, so a stopped command still reports its status; commands get default handling.
 */
// ponytail: POSIX hosts only; the run button is hidden for Windows environments.
export const SHELL_RUN_WRAPPER = [
  "trap : INT",
  `printf '\\033[2m$ %s\\033[0m\\n' "$T3CODE_RUN_SCRIPT"`,
  `printf '\\033]7777;t3-run-start\\007'`,
  'if command -v bash >/dev/null 2>&1; then bash -c "$T3CODE_RUN_SCRIPT"; else sh -c "$T3CODE_RUN_SCRIPT"; fi',
  `printf '\\033]7777;t3-run-end;%s\\007' "$?"`,
].join("\n");

/** Typed into the session's shell. A leading space keeps it out of history where configured. */
export const SHELL_RUN_TYPED_LINE = ' sh -c "$T3CODE_RUN_WRAPPER"\r';

/** Output kept per run; older lines are counted, not kept. */
const MAX_KEPT_OUTPUT_CHARS = 64 * 1024;

export interface ShellRunOutput {
  readonly started: boolean;
  /** Raw tail that may be the start of a marker or escape sequence split across chunks. */
  readonly carry: string;
  /** What the command printed, escape sequences removed; carriage returns kept. */
  readonly text: string;
  readonly droppedLines: number;
  readonly exitCode: number | null;
  readonly done: boolean;
}

export const EMPTY_SHELL_RUN_OUTPUT: ShellRunOutput = {
  started: false,
  carry: "",
  text: "",
  droppedLines: 0,
  exitCode: null,
  done: false,
};

const ESCAPE_SEQUENCE =
  // OSC/DCS/APC/PM strings, CSI sequences, charset selections, then any other two-byte escape.
  // eslint-disable-next-line no-control-regex -- terminal escape sequences
  /\u001b(?:[\]P_^][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[()#][0-9A-Za-z]|[@-OQ-Z\\=>])/g;
const COMPLETE_ESCAPE_AT_START = new RegExp(`^(?:${ESCAPE_SEQUENCE.source})`);

function stripEscapes(text: string): string {
  // eslint-disable-next-line no-control-regex -- stray control characters
  return text.replace(ESCAPE_SEQUENCE, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function appendCapped(
  output: ShellRunOutput,
  text: string,
): Pick<ShellRunOutput, "text" | "droppedLines"> {
  const joined = output.text + text;
  if (joined.length <= MAX_KEPT_OUTPUT_CHARS)
    return { text: joined, droppedLines: output.droppedLines };
  const newline = joined.indexOf("\n", joined.length - MAX_KEPT_OUTPUT_CHARS);
  const cut = newline === -1 ? joined.length - MAX_KEPT_OUTPUT_CHARS : newline + 1;
  const removed = joined.slice(0, cut);
  return {
    text: joined.slice(cut),
    droppedLines: output.droppedLines + removed.split("\n").length - 1,
  };
}

/** Folds one chunk of raw terminal output into a run's output. */
export function feedShellRunOutput(output: ShellRunOutput, chunk: string): ShellRunOutput {
  if (output.done) return output;
  let buffer = output.carry + chunk;
  let started = output.started;
  if (!started) {
    const start = buffer.indexOf(START_MARKER);
    if (start === -1) {
      // Scrollback can outgrow the start marker; the end still finishes the run.
      const end = END_MARKER.exec(buffer);
      if (end) return { ...output, carry: "", exitCode: Number(end[1]), done: true };
      // Long enough to hold a split start or end marker.
      return { ...output, carry: buffer.slice(-32) };
    }
    started = true;
    buffer = buffer.slice(start + START_MARKER.length);
  }
  const end = END_MARKER.exec(buffer);
  if (end) {
    return {
      ...output,
      ...appendCapped(output, stripEscapes(buffer.slice(0, end.index))),
      started,
      carry: "",
      exitCode: Number(end[1]),
      done: true,
    };
  }
  const lastEscape = buffer.lastIndexOf("\u001b");
  // A sequence still open after 4 KB is malformed; stop holding output back for it.
  const incomplete =
    lastEscape !== -1 &&
    buffer.length - lastEscape < 4096 &&
    !COMPLETE_ESCAPE_AT_START.test(buffer.slice(lastEscape))
      ? lastEscape
      : -1;
  const body = incomplete === -1 ? buffer : buffer.slice(0, incomplete);
  return {
    ...output,
    ...appendCapped(output, stripEscapes(body)),
    started,
    carry: incomplete === -1 ? "" : buffer.slice(incomplete),
  };
}

/** Printed lines as a terminal shows them: CRLF ends a line, a bare CR rewrites it. */
function shellRunLines(text: string): string[] {
  const lines = text.split("\n").map((line) => {
    const withoutEnd = line.endsWith("\r") ? line.slice(0, -1) : line;
    return withoutEnd.slice(withoutEnd.lastIndexOf("\r") + 1);
  });
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The last `maxLines` lines of a run's output, and how many earlier lines are not shown. */
export function shellRunOutputTail(
  output: Pick<ShellRunOutput, "text" | "droppedLines">,
  maxLines: number,
): { readonly lines: ReadonlyArray<string>; readonly hiddenLines: number } {
  const lines = shellRunLines(output.text);
  const shown = lines.slice(-maxLines);
  return { lines: shown, hiddenLines: output.droppedLines + lines.length - shown.length };
}

// ---------------------------------------------------------------------------
// The message that wakes the agent. `parseShellRunMessage` is the one place a sent
// message is recognized as a run result, so the timeline can render it compactly.
// ---------------------------------------------------------------------------

/** Output sent to the agent; older output is cut. */
export const SHELL_RUN_MESSAGE_OUTPUT_CHARS = 16 * 1024;
const HEADER = "I ran this command in the terminal";
const TRUNCATED_NOTE = " (only the last 16 KB; earlier output was cut)";
const NO_OUTPUT = "It printed nothing.";

function fenceFor(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function formatShellRunMessage(input: {
  readonly command: string;
  readonly exitCode: number;
  readonly output: Pick<ShellRunOutput, "text" | "droppedLines">;
}): string {
  const printed = shellRunLines(input.output.text).join("\n");
  const kept = printed.slice(-SHELL_RUN_MESSAGE_OUTPUT_CHARS);
  const truncated = input.output.droppedLines > 0 || kept.length < printed.length;
  const commandFence = fenceFor(input.command);
  const outputFence = fenceFor(kept);
  const outputSection =
    kept.length === 0 && !truncated
      ? NO_OUTPUT
      : `Output${truncated ? TRUNCATED_NOTE : ""}:\n\n${outputFence}\n${kept}\n${outputFence}`;
  return `${HEADER} (exit code ${input.exitCode}):\n\n${commandFence}sh\n${input.command}\n${commandFence}\n\n${outputSection}`;
}

const MESSAGE_PATTERN = new RegExp(
  `^${HEADER} \\(exit code (\\d+)\\):\\n\\n(\`{3,})sh\\n([\\s\\S]*?)\\n\\2\\n\\n` +
    `(?:${NO_OUTPUT.replace(".", "\\.")}|Output(${TRUNCATED_NOTE.replace(/[().;]/g, "\\$&")})?:\\n\\n(\`{3,})\\n([\\s\\S]*?)\\n\\5)$`,
);

export interface ShellRunMessage {
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
  readonly truncated: boolean;
}

export function parseShellRunMessage(text: string): ShellRunMessage | null {
  const match = MESSAGE_PATTERN.exec(text);
  if (!match) return null;
  return {
    exitCode: Number(match[1]),
    command: match[3] ?? "",
    truncated: match[4] !== undefined,
    output: match[6] ?? "",
  };
}
