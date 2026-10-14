import {
  INLINE_SHELL_OUTPUT_BYTES,
  INLINE_SHELL_OUTPUT_LINES,
  type InlineShellRunRecord,
  ComposerContextId,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "./composerContextReferences.ts";

/** Cap UTF-8 bytes and lines from the end; never split a Unicode code point. */
export function inlineShellOutputTail(output: string): string {
  const lines = output.split("\n");
  const trailingNewline = lines.at(-1) === "";
  const tail = lines.slice(-(INLINE_SHELL_OUTPUT_LINES + (trailingNewline ? 1 : 0))).join("\n");
  const bytes = new TextEncoder().encode(tail);
  if (bytes.length <= INLINE_SHELL_OUTPUT_BYTES) return tail;
  let start = bytes.length - INLINE_SHELL_OUTPUT_BYTES;
  while ((bytes[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

/** Reuse terminal context chips' provider projection for automatic sharing. */
export function inlineShellContext(records: readonly InlineShellRunRecord[]): string {
  return records
    .filter((record) => record.status !== "running")
    .map((record) => {
      const contextId = ComposerContextId.make(`inline-${record.runId}`);
      const text = [
        `User ran shell command (${record.language}): ${record.command}`,
        `Exit code: ${record.exitCode ?? "unknown"}; status: ${record.status}; duration: ${record.durationMs} ms`,
        "Output tail:",
        record.output,
      ].join("\n");
      return projectComposerContextForProvider({
        text: formatComposerContextReference({
          kind: "terminal",
          contextId,
          label: "Inline shell run",
        }),
        records: [
          {
            version: 1,
            kind: "terminal",
            contextId,
            label: "Inline shell run",
            terminalId: record.terminalId,
            terminalLabel: "Inline shell run",
            lineStart: 0,
            lineEnd: text.split("\n").length - 1,
            text,
          },
        ],
      });
    })
    .join("\n\n");
}

export function inlineShellDisplayOutput(output: string): string {
  // Keep partial sequences in the raw stream buffer until the following chunk arrives.
  return (
    output
      // eslint-disable-next-line no-control-regex -- PTY output contains ANSI control sequences.
      .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
      .replace(/\r/g, "")
  );
}

export function inlineShellIsPasswordPrompt(output: string): boolean {
  return /(?:password|passphrase)[^:\n]*:\s*$/i.test(inlineShellDisplayOutput(output));
}

export function inlineShellCanWrite(status: InlineShellRunRecord["status"]): boolean {
  return status === "running";
}
