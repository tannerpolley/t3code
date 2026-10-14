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
        ...(record.error === null ? [] : [`Error: ${record.error}`]),
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

const byteLength = (text: string) => new TextEncoder().encode(text).length;
const headBytes = (text: string, limit: number) => {
  const bytes = new TextEncoder().encode(text);
  let end = Math.min(limit, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
};
const tailBytes = (text: string, limit: number) => {
  const bytes = new TextEncoder().encode(text);
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
};

/** Newest first; omitted records stay pending for a later turn. The cap includes formatting. */
export function selectInlineShellContext(
  records: readonly InlineShellRunRecord[],
  totalCount = records.length,
) {
  const ids: string[] = [];
  const parts: string[] = [];
  let remaining = INLINE_SHELL_OUTPUT_BYTES - 128;
  for (const record of records) {
    if (record.status === "running" || remaining < 512) break;
    const command = headBytes(record.command, Math.min(2_048, Math.floor(remaining / 3)));
    const bounded = {
      ...record,
      command: command === record.command ? command : `${command} [command truncated]`,
      output: "",
    };
    const overhead = byteLength(inlineShellContext([bounded]));
    if (overhead >= remaining) break;
    bounded.output = tailBytes(record.output, Math.max(0, Math.floor((remaining - overhead) / 2)));
    let part = inlineShellContext([bounded]);
    while (byteLength(part) > remaining && bounded.output.length > 0) {
      bounded.output = tailBytes(bounded.output, Math.floor(byteLength(bounded.output) / 2));
      part = inlineShellContext([bounded]);
    }
    if (byteLength(part) > remaining) break;
    parts.push(part);
    ids.push(record.runId);
    remaining -= byteLength(part) + 2;
  }
  const omitted = totalCount - ids.length;
  if (omitted > 0) parts.push(`${omitted} older runs did not fit and will be shared on a later turn.`);
  return { text: parts.join("\n\n"), ids };
}

export function latestInlineShellRecord(
  current: InlineShellRunRecord | null,
  next: InlineShellRunRecord | null,
) {
  if (next === null) return current;
  if (current === null || next.sequence > current.sequence) return next;
  if (
    next.sequence < current.sequence ||
    (current.status !== "running" && next.status === "running")
  )
    return current;
  return next;
}
