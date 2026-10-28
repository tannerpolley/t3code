import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { randomUUID } from "~/lib/utils";
import { useAtomValue, RegistryContext } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  NotebookSnapshot,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { notebooks } from "~/state/notebooks";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";
import { confirmNotebookClose } from "./NotebookCloseDialog";
import NotebookPreview, { NotebookCellSurface, type OutputView } from "./NotebookPreview";
import { notebookPreviewCell } from "./extendedDocumentPreview";
import { applyNotebookEvent } from "./notebookLiveState";
import { registerNotebookClose } from "./notebookCloseAdapter";
import { useStableCallback } from "~/hooks/useStableCallback";

function createNotebookStore(initial: NotebookSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  let scheduled = false;
  return {
    read: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next: NotebookSnapshot) => {
      if (next.epoch === snapshot.epoch && next.sequence < snapshot.sequence) return;
      snapshot = next;
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          for (const listener of listeners) listener();
        }, 32);
      }
    },
  };
}
type Store = ReturnType<typeof createNotebookStore>;
type Props = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  relativePath: string;
  threadRef: ScopedThreadRef;
  fallback: ReactNode;
  onPendingChange: (path: string, pending: boolean) => void;
};
export default function RunnableNotebookPreview(props: Props) {
  const openCommand = useAtomCommand(notebooks.open, { reportFailure: false });
  const open = useStableCallback(openCommand);
  const [opened, setOpened] = useState<NotebookSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Open a server-owned document without starting a kernel; ignore responses after navigation.
  useEffect(() => {
    let active = true;
    void open({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, relativePath: props.relativePath },
    }).then((result) => {
      if (!active) return;
      if (AsyncResult.isSuccess(result)) setOpened(result.value);
      else setError(true);
    });
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit retry must reopen the server resource even when its identity is unchanged.
  }, [props.environmentId, props.projectId, props.relativePath, attempt, open]);
  if (opened)
    return (
      <NotebookSession
        key={`${opened.epoch}:${opened.handle}`}
        {...props}
        initial={opened}
        onReconnect={() => {
          setOpened(null);
          setError(false);
          setAttempt(attempt + 1);
        }}
      />
    );
  return (
    <>
      <div role="status" className="p-4 text-sm text-muted-foreground">
        {error
          ? "Notebook session unavailable. Opening never runs code. The retained draft limit is 16 notebooks."
          : "Opening notebook…"}
        {error ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(false);
              setAttempt(attempt + 1);
            }}
          >
            Reconnect
          </Button>
        ) : null}
      </div>
      {error ? props.fallback : null}
    </>
  );
}

function NotebookSession(props: Props & { initial: NotebookSnapshot; onReconnect: () => void }) {
  const [store] = useState(() => createNotebookStore(props.initial));
  const snapshot = useSyncExternalStore(store.subscribe, store.read);
  const [leaseId] = useState(() => randomUUID());
  const [connection, setConnection] = useState("Connecting");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const open = useAtomCommand(notebooks.open, { reportFailure: false });
  const registry = useContext(RegistryContext);
  const save = useAtomCommand(notebooks.save, { reportFailure: false });
  const reload = useAtomCommand(notebooks.reload, { reportFailure: false });
  const execute = useAtomCommand(notebooks.execute, { reportFailure: false });
  const interrupt = useAtomCommand(notebooks.interrupt, { reportFailure: false });
  const restart = useAtomCommand(notebooks.restart, { reportFailure: false });
  const closeCommand = useAtomCommand(notebooks.close, { reportFailure: false });
  const close = useStableCallback(closeCommand);
  const canSave = useAtomValue(notebooks.save.permissionAtom(props.environmentId));
  const canRun = useAtomValue(notebooks.execute.permissionAtom(props.environmentId));
  const canInterrupt = useAtomValue(notebooks.interrupt.permissionAtom(props.environmentId));
  const canRestart = useAtomValue(notebooks.restart.permissionAtom(props.environmentId));
  const input = { projectId: props.projectId, handle: snapshot.handle };
  const events = notebooks.events({
    environmentId: props.environmentId,
    input: { ...input, leaseId },
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Consume destination RPC events, resubscribing for an atomic snapshot after a gap or reconnect.
  useEffect(
    () =>
      registry.subscribe(
        events,
        (result) => {
          if (AsyncResult.isSuccess(result) && !result.waiting) {
            const next = applyNotebookEvent(store.read(), result.value);
            if (next) {
              store.update(next);
              setConnection("Connected");
            } else {
              setConnection("Reconnecting");
              registry.refresh(events);
            }
          } else setConnection("Disconnected. Reconnect to recover current state");
        },
        { immediate: true },
      ),
    [registry, events, store],
  );
  const dirty = snapshot.revision !== snapshot.savedRevision;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Adapt the authoritative dirty revision to the outer file tab pending marker, without registering a file writer.
  useEffect(() => {
    props.onPendingChange(props.relativePath, dirty);
  }, [props, dirty]);
  const persist = async (discard = false) => {
    setPending(true);
    const current = store.read();
    const result = await (discard ? reload : save)({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        handle: current.handle,
        revision: current.revision,
        diskHash: current.diskHash,
      },
    });
    setPending(false);
    if (AsyncResult.isSuccess(result)) {
      store.update(result.value);
      setError(null);
      return store.read().revision === store.read().savedRevision;
    }
    setError(
      "Save or reload failed: the file may have changed on disk, the revision changed, or access was lost. Retain the draft or reconnect before retrying.",
    );
    return false;
  };
  const requestClose = useStableCallback(async () => {
    const result = await open({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, relativePath: props.relativePath },
    });
    const online = AsyncResult.isSuccess(result);
    if (AsyncResult.isSuccess(result)) store.update(result.value);
    const writable = registry.get(notebooks.save.permissionAtom(props.environmentId));
    const discardable = registry.get(notebooks.reload.permissionAtom(props.environmentId));
    if (store.read().revision === store.read().savedRevision) return true;
    const allowed = await confirmNotebookClose({
      persist,
      canSave: online && writable && store.read().outcome !== "running",
      canDiscard:
        online &&
        discardable &&
        store.read().outcome !== "running" &&
        store.read().kernel !== "unknown",
    });
    return allowed;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the draft close adapter across inactive tabs; successful explicit close removes it.
  useEffect(() => {
    registerNotebookClose(props.threadRef, props.relativePath, requestClose, () => {
      props.onPendingChange(props.relativePath, false);
      void close({
        environmentId: props.environmentId,
        input: { projectId: props.projectId, handle: store.read().handle, leaseId },
      });
    });
  }, [props, requestClose, close, store, leaseId]);
  const run = useStableCallback(async (cellIds: string[]) => {
    setPending(true);
    const result = await execute({
      environmentId: props.environmentId,
      input: { ...input, revision: store.read().revision, requestId: randomUUID(), cellIds },
    });
    setPending(false);
    if (!AsyncResult.isSuccess(result))
      setError(
        "Execution could not start. Check the configured project environment or reconnect; no automatic retry will run code.",
      );
  });
  const cells = snapshot.document.cells as Record<string, unknown>[];
  const runnable =
    connection === "Connected" &&
    snapshot.availability === "available" &&
    snapshot.kernel !== "unknown" &&
    snapshot.outcome !== "running" &&
    !pending &&
    canRun;
  const language = String(
    (snapshot.document.metadata as { language_info?: { name?: string } })?.language_info?.name ??
      "text",
  )
    .replaceAll(/[^a-z\d+#-]/gi, "")
    .slice(0, 40);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 p-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!runnable}
          onClick={() =>
            void run(
              cells
                .filter((c) => c.cell_type === "code" && String(c.source).trim())
                .map((c) => String(c.id)),
            )
          }
        >
          Run all
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canInterrupt || pending || !snapshot.runId || connection !== "Connected"}
          onClick={async () => {
            const result = await interrupt({
              environmentId: props.environmentId,
              input: { ...input, generation: snapshot.generation, runId: snapshot.runId! },
            });
            if (!AsyncResult.isSuccess(result))
              setError("Interrupt failed. Reconnect to recover kernel status.");
          }}
        >
          Interrupt
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            !canRestart ||
            pending ||
            snapshot.availability !== "available" ||
            connection !== "Connected" ||
            snapshot.kernel === "stopped"
          }
          onClick={async () => {
            setPending(true);
            const result = await restart({
              environmentId: props.environmentId,
              input: { ...input, generation: snapshot.generation },
            });
            setPending(false);
            if (!AsyncResult.isSuccess(result))
              setError("Restart failed. Reconnect to recover kernel status.");
          }}
        >
          Restart
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            !canSave ||
            !dirty ||
            pending ||
            snapshot.outcome === "running" ||
            connection !== "Connected"
          }
          onClick={() => void persist()}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            props.onReconnect();
          }}
        >
          Reconnect
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {connection} · Kernel {snapshot.kernel} · Environment {snapshot.environment} ·{" "}
          {snapshot.outcome} · {dirty ? "Unsaved draft" : "Saved"}
          {snapshot.idleDeadline
            ? ` · Idle shutdown ${new Date(snapshot.idleDeadline).toLocaleTimeString()}`
            : ""}
        </span>
      </div>
      {error ? (
        <p role="alert" className="p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <LiveNotebookBody
        store={store}
        language={language}
        runnable={runnable}
        onRun={run}
        notice={
          snapshot.availability === "unavailable"
            ? "Saved outputs only. Execution unavailable; configure the project Jupyter environment on the destination server. No kernel starts on opening or reconnecting."
            : snapshot.truncated
              ? "Output limit reached. Drafts are process-local and may be lost if the server restarts."
              : "Drafts are process-local (up to 16 notebooks) and may be lost if the server restarts. Execution starts only when you choose Run."
        }
      />
    </>
  );
}
function LiveNotebookBody({
  store,
  language,
  runnable,
  onRun,
  notice,
}: {
  store: Store;
  language: string;
  runnable: boolean;
  onRun: (ids: string[]) => Promise<void>;
  notice: string;
}) {
  const identity = useSyncExternalStore(store.subscribe, () =>
    JSON.stringify(
      (store.read().document.cells as Record<string, unknown>[]).map((cell) => cell.id),
    ),
  );
  const ids = JSON.parse(identity) as string[];
  const preview = {
    type: "notebook" as const,
    language,
    cells: ids.map(() => ({ kind: "raw" as const, source: "", outputs: [] })),
  };
  return (
    <NotebookPreview
      notebook={preview}
      notice={notice}
      renderCell={(index, outputView) => (
        <LiveCell
          key={ids[index]}
          store={store}
          id={ids[index]!}
          index={index}
          language={language}
          outputView={outputView}
          runnable={runnable}
          onRun={onRun}
        />
      )}
    />
  );
}

function LiveCell({
  store,
  id,
  index,
  language,
  outputView,
  runnable,
  onRun,
}: {
  store: Store;
  id: string;
  index: number;
  language: string;
  outputView: OutputView;
  runnable: boolean;
  onRun: (ids: string[]) => Promise<void>;
}) {
  const cell = useSyncExternalStore(store.subscribe, () =>
    (store.read().document.cells as Record<string, unknown>[]).find((c) => c.id === id),
  );
  const execution = useSyncExternalStore(store.subscribe, () => store.read().executions[id]);
  const generation = useSyncExternalStore(store.subscribe, () => store.read().generation);
  const outcome = useSyncExternalStore(store.subscribe, () => store.read().outcome);
  if (!cell) return null;
  let preview;
  try {
    preview = notebookPreviewCell(cell);
  } catch {
    return <p role="alert">Cell output exceeds safe preview limits.</p>;
  }
  const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
  return (
    <NotebookCellSurface
      cell={preview}
      index={index}
      language={language}
      outputView={outputView}
      controls={
        cell.cell_type === "code" ? (
          <div className="flex items-center gap-2 px-3 py-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={!runnable || !source.trim()}
              onClick={() => void onRun([id])}
            >
              Run cell {index + 1}
            </Button>
            <span className="text-xs text-muted-foreground">
              [{String(cell.execution_count ?? " ")}] ·{" "}
              {execution?.replyStatus ??
                (execution
                  ? outcome === "running"
                    ? "running"
                    : "no reply recorded"
                  : "saved output")}
              {execution && execution.generation !== generation ? " · previous kernel" : ""}
              {execution &&
              execution.sourceHash !== bytesToHex(sha256(new TextEncoder().encode(source)))
                ? " · previous source"
                : ""}
            </span>
          </div>
        ) : undefined
      }
    />
  );
}
