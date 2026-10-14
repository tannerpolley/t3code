import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ThreadId,
  type InlineShellLanguage,
  type InlineShellRunRecord,
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
import { latestInlineShellRecord } from "@t3tools/shared/inlineShell";
import { resolveInlineShellRun } from "@t3tools/client-runtime/state/inlineShell";
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
} | null>(null);

export function InlineShellRunProvider({
  environmentId,
  threadId,
  children,
  className,
}: {
  className?: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
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
  const retained = useEnvironmentQuery(
    terminalEnvironment.watchInlineRun({
      environmentId: context.environmentId,
      input: { threadId: context.threadId, blockId },
    }),
  );
  const saved = latestInlineShellRecord(localRecord, retained.data ?? null);
  const output = useEnvironmentQuery(
    saved?.status === "running"
      ? terminalEnvironment.observeInline({
          environmentId: context.environmentId,
          input: { threadId: context.threadId, terminalId: saved.terminalId },
        })
      : null,
  );
  const record = resolveInlineShellRun(saved, output.data, output.error);
  const running = record !== null && inlineShellCanWrite(record.status);
  const scrollRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const text = running ? (output.data?.output ?? record.output) : (record?.output ?? "");
  const displayText = useMemo(() => inlineShellDisplayOutput(text), [text]);
  const hideInput = secret ?? inlineShellIsPasswordPrompt(displayText);
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
          const target = event.target;
          const selectedInput =
            target instanceof HTMLInputElement && target.selectionStart !== target.selectionEnd;
          if (
            event.ctrlKey &&
            event.key.toLowerCase() === "c" &&
            running &&
            !selectedInput &&
            !window.getSelection()?.toString()
          ) {
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
          {displayText || "No output yet."}
        </pre>
        {record.error ? <p role="alert">{record.error}</p> : null}
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
          <div className="mt-2 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Input
                size="compact"
                font="mono"
                type={hideInput ? "password" : "text"}
                aria-label="Process input"
                value={input}
                disabled={!canWrite}
                autoComplete={hideInput ? "new-password" : "off"}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    void send(`${input}\r`);
                  }
                }}
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
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canWrite}
              onClick={() => void send(`${input}\r`)}
            >
              Send
            </Button>
          </div>
        ) : null}
      </div>
    );
  return children(action, panel);
}
