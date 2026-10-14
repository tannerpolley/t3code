import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ThreadId,
  type InlineShellLanguage,
  type InlineShellRunRecord,
  type OrchestrationV2TurnItem,
  InlineShellLanguage as InlineShellLanguageSchema,
} from "@t3tools/contracts";
import {
  inlineShellCanWrite,
  inlineShellDisplayOutput,
  inlineShellIsPasswordPrompt,
} from "@t3tools/shared/inlineShell";
import * as Schema from "effect/Schema";
import { PlayIcon } from "lucide-react";
import {
  createContext,
  use,
  useMemo,
  useRef,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { randomUUID } from "../../lib/utils";
import { terminalEnvironment } from "../../state/terminal";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const isShellLanguage = Schema.is(InlineShellLanguageSchema);

const InlineShellContext = createContext<{
  environmentId: EnvironmentId;
  threadId: ThreadId;
  records: ReadonlyMap<string, InlineShellRunRecord>;
} | null>(null);

export function InlineShellRunProvider({
  environmentId,
  threadId,
  items,
  children,
  className,
}: {
  className?: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  items: readonly OrchestrationV2TurnItem[];
  children: ReactNode;
}) {
  const value = useMemo(() => {
    const records = new Map<string, InlineShellRunRecord>();
    for (const item of items) {
      if (item.type !== "system_notice" || item.inlineShellRun === undefined) continue;
      const record = item.inlineShellRun;
      const previous = records.get(record.blockId);
      if (previous === undefined || previous.startedAt <= record.startedAt)
        records.set(record.blockId, record);
    }
    return { environmentId, threadId, records };
  }, [environmentId, threadId, items]);
  return (
    <InlineShellContext value={value}>
      <div className={className}>{children}</div>
    </InlineShellContext>
  );
}

export function InlineShellBlock({
  blockId,
  command,
  language,
  onOpenTerminal,
  children,
}: {
  blockId: string;
  command: string;
  language: string;
  onOpenTerminal: (terminalId: string) => void;
  children: (action: ReactNode, output: ReactNode) => ReactNode;
}) {
  const context = use(InlineShellContext);
  if (context === null || !isShellLanguage(language)) return children(null, null);
  return (
    <InlineShellControls
      key={`${context.environmentId}:${context.threadId}:${blockId}`}
      context={context}
      blockId={blockId}
      command={command}
      language={language}
      onOpenTerminal={onOpenTerminal}
    >
      {children}
    </InlineShellControls>
  );
}

function InlineShellControls({
  context,
  blockId,
  command,
  language,
  onOpenTerminal,
  children,
}: {
  context: NonNullable<React.ContextType<typeof InlineShellContext>>;
  blockId: string;
  command: string;
  language: InlineShellLanguage;
  onOpenTerminal: (terminalId: string) => void;
  children: (action: ReactNode, output: ReactNode) => ReactNode;
}) {
  const canRun = useAtomValue(terminalEnvironment.runInline.permissionAtom(context.environmentId));
  const canWrite = useAtomValue(terminalEnvironment.write.permissionAtom(context.environmentId));
  const run = useAtomCommand(terminalEnvironment.runInline, "inline shell run");
  const write = useAtomCommand(terminalEnvironment.write, "inline shell input");
  const [pending, setPending] = useState(false);
  const [localRecord, setLocalRecord] = useState<InlineShellRunRecord | null>(null);
  const [input, setInput] = useState("");
  const [secret, setSecret] = useState<boolean | null>(null);
  const projectedRecord = context.records.get(blockId);
  const retained = useEnvironmentQuery(
    projectedRecord === undefined
      ? terminalEnvironment.inlineRun({
          environmentId: context.environmentId,
          input: { threadId: context.threadId, blockId },
        })
      : null,
  );
  const saved = projectedRecord ?? retained.data;
  const record =
    saved && (!localRecord || saved.startedAt >= localRecord.startedAt) ? saved : localRecord;
  const running = record !== null && inlineShellCanWrite(record.status);
  const output = useEnvironmentQuery(
    running
      ? terminalEnvironment.observeInline({
          environmentId: context.environmentId,
          input: { threadId: context.threadId, terminalId: record.terminalId },
        })
      : null,
  );
  const scrollRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const text = running ? (output.data?.output ?? record.output) : (record?.output ?? "");
  const hideInput = secret ?? inlineShellIsPasswordPrompt(text);
  useLayoutEffect(() => {
    if (scrollRef.current && pinned.current && text.length > 0)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [text]);
  const send = async (data: string) => {
    if (!record || !running || !canWrite) return;
    const result = await write({
      environmentId: context.environmentId,
      input: { threadId: context.threadId, terminalId: record.terminalId, data },
    });
    if (result._tag === "Success") setInput("");
  };
  const action = (
    <Button
      type="button"
      variant="ghost-muted"
      size="icon-xs"
      disabled={!canRun || running || pending}
      aria-label="Run inline"
      onClick={() => {
        if (!canRun || running || pending) return;
        setSecret(null);
        setInput("");
        setPending(true);
        void run({
          environmentId: context.environmentId,
          input: { threadId: context.threadId, runId: randomUUID(), blockId, command, language },
        })
          .then((result) => {
            if (result._tag === "Success") setLocalRecord(result.value);
          })
          .finally(() => setPending(false));
      }}
    >
      <PlayIcon className="size-3" />
    </Button>
  );
  const panel =
    record === null ? null : (
      <div
        className="border-t border-border p-2 text-xs"
        onKeyDown={(event) => {
          if (event.ctrlKey && event.key.toLowerCase() === "c" && running) {
            event.preventDefault();
            event.stopPropagation();
            void send("\u0003");
          }
        }}
      >
        <pre
          ref={scrollRef}
          className="h-48 overflow-auto whitespace-pre-wrap break-all font-mono"
          tabIndex={0}
          aria-label="Inline shell output"
          onScroll={(event) => {
            const element = event.currentTarget;
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 16;
          }}
        >
          {inlineShellDisplayOutput(text) || "No output yet."}
        </pre>
        {output.error ? <p role="alert">{output.error}</p> : null}
        <div className="mt-2 flex items-center gap-2">
          <span>
            {running
              ? "Running"
              : `${record.status} · exit ${record.exitCode ?? "unknown"} · ${(record.durationMs / 1000).toFixed(2)} s`}
          </span>
          {running ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canWrite}
              onClick={() => void send("\u0003")}
            >
              Stop
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTerminal(record.terminalId)}
          >
            Open in terminal
          </Button>
        </div>
        {running ? (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send(`${input}\r`);
            }}
          >
            <div className="min-w-0 flex-1">
              <Input
                size="compact"
                font="mono"
                type={hideInput ? "password" : "text"}
                aria-label="Process input"
                value={input}
                disabled={!canWrite}
                autoComplete="off"
                onChange={(event) => setInput(event.target.value)}
              />
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              aria-pressed={hideInput}
              onClick={() => setSecret(!hideInput)}
            >
              {hideInput ? "Show input" : "Hide input"}
            </Button>
            <Button type="submit" size="xs" variant="outline" disabled={!canWrite}>
              Send
            </Button>
          </form>
        ) : null}
      </div>
    );
  return children(action, panel);
}
