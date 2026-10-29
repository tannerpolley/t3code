import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { NOTEBOOK_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import "~/index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type NotebookSnapshot,
  type NotebookEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render, act } from "../../../test/render";

vi.mock(import("~/state/notebooks"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { AVAILABLE_CONNECTION_STATE } = await import("@t3tools/client-runtime/connection");
  const connection = Atom.make(
    AsyncResult.success({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
      generation: 1,
    }),
  ).pipe(Atom.keepAlive);
  const event = Atom.make(AsyncResult.initial<NotebookEvent>()).pipe(Atom.keepAlive);
  const permission = Atom.make(true).pipe(Atom.keepAlive);
  const command = () => ({
    run: vi.fn(async () => AsyncResult.success(undefined)),
    permissionAtom: () => permission,
  });
  return {
    notebooks: {
      connectionStateAtom: () => connection,
      open: command(),
      execute: command(),
      save: command(),
      reload: command(),
      interrupt: command(),
      restart: command(),
      close: command(),
      events: Object.assign(vi.fn(), { event, permission }),
    },
  } as never;
});
vi.mock(
  import("~/state/use-atom-command"),
  () => ({ useAtomCommand: (command: { run: unknown }) => command.run }) as never,
);
// Source highlighting is independent of notebook execution and owns its own worker tests.
vi.mock(import("./ReadOnlySourcePreview"), () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
import { notebooks } from "~/state/notebooks";
import RunnableNotebookPreview from "./RunnableNotebookPreview";
import NotebookCloseDialog from "./NotebookCloseDialog";
import { allowNotebookClose } from "./notebookCloseAdapter";

type FakeCommand = { run: ReturnType<typeof vi.fn> };
function setup() {
  const initial: NotebookSnapshot = {
    handle: "handle",
    epoch: "epoch",
    sequence: 0,
    revision: 0,
    savedRevision: 0,
    diskHash: "disk",
    idleDeadline: null,
    availability: "available",
    environment: "unverified",
    executions: {},
    generation: 0,
    kernel: "stopped",
    runId: null,
    outcome: "none",
    truncated: false,
    document: {
      nbformat: 4,
      metadata: { language_info: { name: "python" } },
      cells: [
        { id: "a", cell_type: "code", source: "print(42)", execution_count: null, outputs: [] },
        { id: "md", cell_type: "markdown", source: "# Result", outputs: [] },
      ],
    },
  };
  const registry = AtomRegistry.make();
  const connection = notebooks.connectionStateAtom(
    EnvironmentId.make("test-notebook"),
  ) as Atom.Writable<AsyncResult.AsyncResult<typeof AVAILABLE_CONNECTION_STATE>>;
  registry.set(
    connection,
    AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase: "connected", generation: 1 }),
  );
  const events = notebooks.events as unknown as ReturnType<typeof vi.fn> & {
    event: Atom.Writable<AsyncResult.AsyncResult<NotebookEvent>>;
    permission: Atom.Writable<boolean>;
  };
  registry.set(events.event, AsyncResult.success({ type: "snapshot", snapshot: initial }));
  registry.set(events.permission, true);
  for (const key of ["open", "save", "reload", "execute", "restart", "interrupt", "close"] as const)
    (notebooks[key] as unknown as FakeCommand).run
      .mockReset()
      .mockResolvedValue(AsyncResult.success(undefined));
  (notebooks.open as unknown as FakeCommand).run.mockResolvedValue(AsyncResult.success(initial));
  const ref = {
    environmentId: EnvironmentId.make("test-notebook"),
    threadId: ThreadId.make("test-thread"),
  };
  const props = {
    ...ref,
    threadRef: ref,
    projectId: ProjectId.make("project"),
    relativePath: "test.ipynb",
    onPendingChange: vi.fn(),
    fallback: <p>Static notebook fallback</p>,
  };
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const session = yield* SubscriptionRef.make(
          Option.some({
            client: {
              [NOTEBOOK_METHODS.subscribe]: () =>
                AtomRegistry.toStream(registry, events.event).pipe(
                  Stream.filter(AsyncResult.isSuccess),
                  Stream.map((value) => value.value),
                ),
            },
          } as unknown as RpcSession),
        );
        const supervisor = {
          session,
          target: new PrimaryConnectionTarget({
            environmentId: ref.environmentId,
            label: "Notebook",
            httpBaseUrl: "http://localhost",
            wsBaseUrl: "ws://localhost",
          }),
        } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        return {
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"];
      }),
    ),
  );
  const actualEvents = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "test:notebook",
    tag: NOTEBOOK_METHODS.subscribe,
    idleTtlMs: 0,
  });
  events.mockReset().mockImplementation(actualEvents);
  const ui = (
    <RegistryContext.Provider value={registry}>
      <div className="flex h-[700px] flex-col">
        <RunnableNotebookPreview {...props} />
        <NotebookCloseDialog />
      </div>
    </RegistryContext.Provider>
  );
  return {
    initial,
    registry,
    events,
    connection,
    props,
    ref,
    ui,
    [Symbol.dispose]: () => registry.dispose(),
  };
}
it("opens without execution, routes explicit run, disables permissions, recovers snapshots and retains a dirty draft on close", async () => {
  using h = setup();
  await using screen = await render(h.ui);
  await expect.element(screen.getByRole("button", { name: "Run all", exact: true })).toBeEnabled();
  await page.screenshot({ path: "../../../../../.t3/issue-212-notebook-live.png" });
  const execute = (notebooks.execute as unknown as FakeCommand).run;
  expect(execute).not.toHaveBeenCalled();
  expect((notebooks.restart as unknown as FakeCommand).run).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Run cell 1", exact: true }).click();
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: h.ref.environmentId,
      input: expect.objectContaining({
        projectId: h.props.projectId,
        handle: "handle",
        cellIds: ["a"],
        revision: 0,
      }),
    }),
  );
  await act(() =>
    h.registry.set(
      h.connection,
      AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase: "backoff", generation: 1 }),
    ),
  );
  await expect.element(screen.getByRole("button", { name: "Run all", exact: true })).toBeDisabled();
  await act(() =>
    h.registry.set(
      h.connection,
      AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase: "connected", generation: 2 }),
    ),
  );
  await expect.element(screen.getByRole("button", { name: "Run all", exact: true })).toBeDisabled();
  await act(() =>
    h.registry.set(h.events.event, AsyncResult.success({ type: "snapshot", snapshot: h.initial })),
  );
  await expect.element(screen.getByRole("button", { name: "Run all", exact: true })).toBeEnabled();
  await act(() => h.registry.set(h.events.permission, false));
  await expect.element(screen.getByRole("button", { name: "Run all", exact: true })).toBeDisabled();
  const { handle: _handle, executions: _executions, document: _document, ...metadata } = h.initial;
  await act(() =>
    h.registry.set(
      h.events.event,
      AsyncResult.success({
        ...metadata,
        type: "changed",
        sequence: 1,
        revision: 1,
        cellId: "a",
        patches: [
          { type: "append", cellId: "a", output: { output_type: "stream", text: "Live delta" } },
        ],
      }),
    ),
  );
  await expect.element(screen.getByText("Live delta", { exact: true })).toBeVisible();
  const dirty = {
    ...h.initial,
    sequence: 2,
    revision: 2,
    kernel: "unknown" as const,
    outcome: "unknown" as const,
    document: {
      ...h.initial.document,
      cells: [
        {
          id: "a",
          cell_type: "code",
          source: "print(42)",
          execution_count: 7,
          outputs: [{ output_type: "stream", text: "Recovered output" }],
        },
      ],
    },
  };
  (notebooks.open as unknown as FakeCommand).run.mockResolvedValue(AsyncResult.success(dirty));
  await act(() =>
    h.registry.set(h.events.event, AsyncResult.success({ type: "snapshot", snapshot: dirty })),
  );
  await expect.element(screen.getByText("Recovered output", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Run all", exact: true })).toBeDisabled();
  expect(h.props.onPendingChange).toHaveBeenCalledWith("test.ipynb", true);
  (notebooks.open as unknown as FakeCommand).run.mockResolvedValue(AsyncResult.initial());
  // The close guard survives switching away and losing the connection.
  await screen.rerender(
    <RegistryContext.Provider value={h.registry}>
      <div className="flex h-[700px] flex-col">
        <div />
        <NotebookCloseDialog />
      </div>
    </RegistryContext.Provider>,
  );
  const closing = allowNotebookClose(h.ref, [
    { kind: "file", relativePath: "test.ipynb" } as never,
  ]);
  await expect
    .element(page.getByRole("button", { name: "Retain draft", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Retain draft", exact: true }).click();
  expect(await closing).toBe(true);
  expect((notebooks.save as unknown as FakeCommand).run).not.toHaveBeenCalled();
});
it("keeps unconfigured sessions static and isolates live HTML output", async () => {
  using h = setup();
  const snapshot = {
    ...h.initial,
    availability: "unavailable" as const,
    document: {
      ...h.initial.document,
      cells: [
        {
          id: "a",
          cell_type: "code",
          source: "print(42)",
          outputs: [
            {
              output_type: "display_data",
              data: {
                "text/html":
                  '<p>Safe result</p><script>parent.__notebookUnsafe = true</script><img src="https://example.com/leak" onerror="alert(1)">',
              },
            },
          ],
        },
      ],
    },
  };
  (notebooks.open as unknown as FakeCommand).run.mockResolvedValue(AsyncResult.success(snapshot));
  h.registry.set(h.events.event, AsyncResult.success({ type: "snapshot", snapshot }));
  await using screen = await render(h.ui);
  await expect.element(screen.getByRole("button", { name: "Run all", exact: true })).toBeDisabled();
  await vi.waitFor(() => {
    const frame = screen.container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame!.srcdoc).toContain("Safe result");
    expect(frame!.srcdoc).not.toContain("example.com");
    expect(frame!.srcdoc).not.toContain("<script>");
    expect(frame!.srcdoc).toContain("default-src 'none'");
  });
  await page.screenshot({ path: "../../../../../.t3/issue-212-notebook-static.png" });
});
it("keeps a conflicted draft and closes only after server reload acknowledges discard", async () => {
  using h = setup();
  const dirty = { ...h.initial, sequence: 1, revision: 1 };
  (notebooks.open as unknown as FakeCommand).run.mockResolvedValue(AsyncResult.success(dirty));
  (notebooks.save as unknown as FakeCommand).run.mockResolvedValue(AsyncResult.initial());
  h.registry.set(h.events.event, AsyncResult.success({ type: "snapshot", snapshot: dirty }));
  await using screen = await render(h.ui);
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(h.props.onPendingChange).toHaveBeenLastCalledWith("test.ipynb", true);
  const reloaded = { ...dirty, sequence: 2, revision: 2, savedRevision: 1 };
  (notebooks.reload as unknown as FakeCommand).run.mockResolvedValue(AsyncResult.success(reloaded));
  const closing = allowNotebookClose(h.ref, [
    { kind: "file", relativePath: "test.ipynb" } as never,
  ]);
  await expect.element(page.getByRole("button", { name: "Discard", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  expect(await closing).toBe(true);
  expect((notebooks.reload as unknown as FakeCommand).run).toHaveBeenCalledWith({
    environmentId: h.ref.environmentId,
    input: {
      projectId: h.props.projectId,
      threadId: h.ref.threadId,
      handle: "handle",
      revision: 1,
      diskHash: "disk",
    },
  });
});
