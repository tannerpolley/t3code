import * as Schema from "effect/Schema";
import { NotebookToolkit } from "../mcp/toolkits/notebook/tools.ts";
import * as NotebookHandlers from "../mcp/toolkits/notebook/handlers.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  EnvironmentId,
  ProviderInstanceId,
  NotebookSnapshot,
  NotebookKernelList,
} from "@t3tools/contracts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
// @effect-diagnostics nodeBuiltinImport:off
// The save regression compares the service hash with the actual committed bytes.
import { vi } from "vite-plus/test";
vi.mock("effect/Queue", { spy: true });
import * as Context from "effect/Context";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NotebookError, ProjectId, ThreadId, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as NotebookService from "./NotebookService.ts";
import * as JupyterTransport from "./JupyterTransport.ts";
import { applyNotebookEvent } from "../../../web/src/components/files/notebookLiveState.ts";
import { parseNotebook } from "./notebookDocument.ts";

const decodeSnapshot = Schema.decodeUnknownSync(NotebookSnapshot);
const decodeKernels = Schema.decodeUnknownSync(NotebookKernelList);
const decodeRun = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }));

const caller = {
  scopes: [
    "filesystem:read",
    "filesystem:write",
    "terminal:operate",
  ] satisfies AuthEnvironmentScope[],
};
const fixture = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { custom: [1, { nested: true }] },
  unknown: "retain",
  cells: ["a", "b"].map((id) => ({
    id,
    cell_type: "code",
    source: ["print(42)\n"],
    metadata: { arbitrary: true },
    execution_count: null,
    outputs: [],
  })),
};
const setup = Effect.fn("Test.setup")(function* (
  overrides: Partial<JupyterTransport.JupyterTransport["Service"]> = {},
  options: {
    readonly worktrees?: readonly string[];
    readonly fileSystem?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem;
  } = {},
) {
  const messages = yield* Queue.unbounded<JupyterTransport.Message, NotebookError>();
  const requests = yield* Queue.unbounded<{ id: string; code: string }>();
  const controls: string[] = [];
  const transport = JupyterTransport.JupyterTransport.of({
    listSpecs: () => Effect.succeed(["python3"]),
    probe: Effect.fn("Fake.probe")(() => Effect.void),
    verify: Effect.fn("Fake.verify")(() => Effect.void),
    create: Effect.fn("Fake.create")(() => Effect.succeed("owned")),
    connect: Effect.fn("Fake.connect")(() =>
      Effect.succeed({
        messages: Stream.fromQueue(messages),
        execute: Effect.fn("Fake.execute")((id: string, code: string) =>
          Queue.offer(requests, { id, code }).pipe(Effect.asVoid),
        ),
        close: Effect.void,
      }),
    ),
    control: Effect.fn("Fake.control")((_endpoint, _id, action) =>
      Effect.sync(() => {
        controls.push(action);
      }),
    ),
    ...overrides,
  });
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const root = yield* fs.makeTempDirectoryScoped();
  const projectId = ProjectId.make(root);
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Notebook', ${root}, '[]', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z')`;
  yield* fs.writeFileString(`${root}/test.ipynb`, JSON.stringify(fixture));
  const context = yield* Effect.context<FileSystem.FileSystem | ProjectStore.ProjectStoreV2>();
  const serviceContext = yield* Layer.build(
    NotebookService.layer.pipe(
      Layer.provide(
        Layer.succeed(GitVcsDriver.GitVcsDriver, {
          listWorktreePaths: () => Effect.succeed(options.worktrees ?? []),
        } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
      ),
      Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
      Layer.provide(Layer.succeed(JupyterTransport.JupyterTransport, transport)),
      Layer.provide(
        Layer.succeed(NotebookService.NotebookConfiguration, {
          owned: Effect.fn("Fake.owned")(() => Effect.void),
          released: Effect.fn("Fake.released")(() => Effect.void),
          endpoint: Effect.fn("Fake.endpoint")(() =>
            Effect.succeed({
              url: "http://127.0.0.1:1",
              token: "test",
              kernelName: "python3",
              profileHash: "test-profile",
            }),
          ),
        }),
      ),
      Layer.provide(
        Layer.succeedContext(
          Context.add(context, FileSystem.FileSystem, options.fileSystem?.(fs) ?? fs),
        ),
      ),
    ),
  );
  const service = yield* NotebookService.NotebookService.pipe(Effect.provide(serviceContext));
  const opened = yield* service.open({ projectId, relativePath: "test.ipynb" }, caller);
  const handle = { projectId, handle: opened.handle };
  const send = (
    id: string,
    type: string,
    content: Record<string, unknown> = {},
    channel = type === "execute_reply" ? "shell" : "iopub",
  ) =>
    Queue.offer(messages, {
      header: { msg_type: type },
      parent_header: { msg_id: id },
      channel,
      content,
    });
  const finished = (runId: string) =>
    service.subscribe(handle, caller).pipe(
      Stream.mapEffect(() => service.snapshot(handle, caller)),
      Stream.filter((s) => s.runId === runId && s.outcome !== "running"),
      Stream.runHead,
    );
  return { service, opened, handle, requests, controls, send, finished, root, fs, messages, sql };
});
const layer = Layer.mergeAll(NodeServices.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect.each([true, false])(
  "preserves an aborted cell reply and stops remaining cells, reply first: %s",
  (replyFirst) =>
    Effect.gen(function* () {
      const { service, opened, handle, requests, send, finished } = yield* setup();
      const ready = yield* Deferred.make<void>();
      const terminal = yield* Deferred.make<void>();
      let replyStatus: string | undefined;
      const observer = yield* service.subscribe(handle, caller).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "snapshot") yield* Deferred.succeed(ready, undefined);
            if (event.type === "changed") {
              for (const patch of event.patches)
                if (patch.type === "execution") replyStatus = patch.execution.replyStatus;
              if (event.outcome === "aborted" || event.outcome === "error")
                yield* Deferred.succeed(terminal, undefined);
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      const runId = yield* service.execute(
        { ...handle, revision: opened.revision, cellIds: ["a", "b"], requestId: "aborted" },
        caller,
      );
      const request = yield* Queue.take(requests);
      if (replyFirst) yield* send(request.id, "execute_reply", { status: "aborted" });
      yield* send(request.id, "status", { execution_state: "idle" });
      if (!replyFirst) yield* send(request.id, "execute_reply", { status: "aborted" });
      yield* Deferred.await(terminal);
      yield* finished(runId);
      const result = yield* service.snapshot(handle, caller);
      expect(result.outcome).toBe("aborted");
      expect(result.executions.a?.replyStatus).toBe("aborted");
      expect(replyStatus).toBe("aborted");
      expect(result.executions.b).toBeUndefined();
      expect(yield* Queue.size(requests)).toBe(0);
      expect((result.document.cells as Array<{ outputs: unknown[] }>)[0]?.outputs).toEqual([]);
      yield* Fiber.interrupt(observer);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("project aliases share the canonical notebook owner and revalidate each project", () =>
  Effect.gen(function* () {
    const { service, opened, handle, sql, root, requests, send, finished } = yield* setup();
    const alias = ProjectId.make("alias");
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${alias}, 'Alias', ${root}, '[]', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z')`;
    const other = yield* service.open({ projectId: alias, relativePath: "test.ipynb" }, caller);
    expect(other.handle).toBe(opened.handle);
    const runId = yield* service.execute(
      { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "alias" },
      caller,
    );
    const request = yield* Queue.take(requests);
    expect(
      yield* service
        .execute(
          {
            projectId: alias,
            handle: other.handle,
            revision: other.revision,
            cellIds: ["b"],
            requestId: "conflict",
          },
          caller,
        )
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "busy" });
    yield* send(request.id, "execute_reply", { status: "ok" });
    yield* send(request.id, "status", { execution_state: "idle" });
    yield* finished(runId);
    yield* sql`UPDATE projection_projects SET workspace_root = '/missing' WHERE project_id = ${alias}`;
    expect(
      yield* service.snapshot({ projectId: alias, handle: other.handle }, caller).pipe(Effect.flip),
    ).toMatchObject({ reason: "invalid-path" });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each(["shutdown", "finalizer"] as const)(
  "retains an acquired kernel for %s when connect and its first cleanup fail",
  (cleanup) =>
    Effect.gen(function* () {
      const deleted: string[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { service, opened, handle } = yield* setup({
            connect: Effect.fn("Fault.connect")(() =>
              Effect.fail(new NotebookError({ reason: "disconnected" })),
            ),
            control: Effect.fn("Fault.control")((_endpoint, id) =>
              Effect.gen(function* () {
                deleted.push(id);
                if (deleted.length === 1)
                  return yield* new NotebookError({ reason: "kernel-failure" });
              }),
            ),
          });
          yield* service
            .execute(
              { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "fault" },
              caller,
            )
            .pipe(Effect.flip);
          if (cleanup === "shutdown") {
            const current = yield* service.snapshot(handle, caller);
            yield* service.shutdown({ ...handle, generation: current.generation }, caller);
          }
        }),
      );
      expect(deleted).toEqual(["owned", "owned"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a blocked acquisition in B does not block A interrupt", () =>
  Effect.gen(function* () {
    const blocked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    let creates = 0;
    const { service, opened, handle, requests, fs, root } = yield* setup({
      create: Effect.fn("Blocked.create")(() =>
        Effect.gen(function* () {
          creates++;
          if (creates === 2) {
            yield* Deferred.succeed(blocked, undefined);
            yield* Deferred.await(release);
          }
          return "owned";
        }),
      ),
      control: Effect.fn("Blocked.control")((_endpoint, _id, action) =>
        action === "interrupt"
          ? Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ),
    });
    const runId = yield* service.execute(
      { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "A" },
      caller,
    );
    yield* Queue.take(requests);
    yield* fs.writeFileString(`${root}/B.ipynb`, JSON.stringify(fixture));
    const b = yield* service.open({ projectId: handle.projectId, relativePath: "B.ipynb" }, caller);
    const acquiring = yield* service
      .execute(
        { ...handle, handle: b.handle, revision: b.revision, cellIds: ["a"], requestId: "B" },
        caller,
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(blocked);
    const interrupt = yield* service
      .interrupt({ ...handle, generation: 1, runId }, caller)
      .pipe(Effect.forkScoped);
    yield* Deferred.await(interrupted);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(acquiring);
    yield* Fiber.join(interrupt);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("execution deltas reset counts and carry provenance even when dispatch fails", () =>
  Effect.gen(function* () {
    const { service, handle, fs, root } = yield* setup({
      connect: Effect.fn("FailDispatch.connect")(() =>
        Effect.succeed({
          messages: Stream.never,
          execute: Effect.fn("FailDispatch.execute")(() =>
            Effect.fail(new NotebookError({ reason: "disconnected" })),
          ),
          close: Effect.void,
        }),
      ),
    });
    const old = {
      ...fixture,
      cells: fixture.cells.map((cell) => ({ ...cell, execution_count: 7 as number | null })),
    };
    yield* fs.writeFileString(`${root}/counts.ipynb`, JSON.stringify(old));
    const initial = yield* service.open(
      { projectId: handle.projectId, relativePath: "counts.ipynb" },
      caller,
    );
    const target = { ...handle, handle: initial.handle };
    const ready = yield* Deferred.make<void>();
    const terminal = yield* Deferred.make<void>();
    let count: number | null = 7;
    let execution: unknown;
    const observer = yield* service.subscribe(target, caller).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "snapshot") yield* Deferred.succeed(ready, undefined);
          if (event.type !== "changed") return;
          for (const patch of event.patches) {
            if (patch.type === "execution") {
              count = patch.count;
              execution = patch.execution;
            }
            if (patch.type === "count") count = patch.count;
          }
          if (event.outcome === "unknown") yield* Deferred.succeed(terminal, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    yield* service.execute(
      { ...target, revision: initial.revision, cellIds: ["a"], requestId: "failed-dispatch" },
      caller,
    );
    yield* Deferred.await(terminal);
    const final = yield* service.snapshot(target, caller);
    expect(count).toBeNull();
    expect(count).toBe(
      (final.document.cells as Array<{ execution_count: number | null }>)[0]?.execution_count,
    );
    expect(execution).toEqual(final.executions.a);
    expect(execution).toMatchObject({ sourceRevision: initial.revision, generation: 1 });
    yield* Fiber.interrupt(observer);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("slow observers receive an explicit resync instead of retaining every delta", () =>
  Effect.gen(function* () {
    const { service, opened, handle, requests, send, finished } = yield* setup();
    const ready = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const resync = yield* Deferred.make<void>();
    const observer = yield* service.subscribe(handle, caller).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "snapshot") {
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(release);
          }
          if (event.type === "resync-required") yield* Deferred.succeed(resync, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    const runId = yield* service.execute(
      { ...handle, revision: opened.revision, cellIds: ["a", "b"], requestId: "slow" },
      caller,
    );
    const first = yield* Queue.take(requests);
    for (let i = 0; i < 40; i++) yield* send(first.id, "stream", { name: "stdout", text: "x" });
    yield* send(first.id, "execute_reply", { status: "ok" });
    yield* send(first.id, "status", { execution_state: "idle" });
    const second = yield* Queue.take(requests);
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(resync);
    yield* send(second.id, "execute_reply", { status: "ok" });
    yield* send(second.id, "status", { execution_state: "idle" });
    yield* finished(runId);
    expect((yield* service.snapshot(handle, caller)).outcome).toBe("ok");
    yield* Fiber.interrupt(observer);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("disconnect marks an uncertain outcome and never resends an accepted request", () =>
  Effect.gen(function* () {
    const { service, opened, handle, requests, messages, finished } = yield* setup();
    const input = {
      ...handle,
      revision: opened.revision,
      cellIds: ["a", "b"],
      requestId: "uncertain",
    };
    const runId = yield* service.execute(input, caller);
    yield* Queue.take(requests);
    Queue.failCauseUnsafe(messages, Cause.fail(new NotebookError({ reason: "disconnected" })));
    yield* finished(runId);
    expect((yield* service.snapshot(handle, caller)).outcome).toBe("unknown");
    expect(yield* service.execute(input, caller)).toBe(runId);
    expect(yield* Queue.size(requests)).toBe(0);
    expect(
      yield* service.execute({ ...input, requestId: "new" }, caller).pipe(Effect.flip),
    ).toMatchObject({ reason: "disconnected" });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it("preserves unknown notebook JSON and source representation, assigning only missing IDs", () => {
  const parsed = parseNotebook(JSON.stringify(fixture));
  expect(parsed.document).toEqual(fixture);
  const old = structuredClone(fixture);
  Reflect.deleteProperty(old.cells[0]!, "id");
  const upgraded = parseNotebook(JSON.stringify(old));
  expect(upgraded.changed).toBe(true);
  expect(upgraded.document.cells[0]?.id).toBeTruthy();
  expect(() =>
    parseNotebook(JSON.stringify({ ...fixture, cells: [fixture.cells[0], fixture.cells[0]] })),
  ).toThrow();
});

it.effect(
  "correlates requests, waits for reply and idle in both orders, deduplicates, and retains late output",
  () =>
    Effect.gen(function* () {
      const { service, opened, handle, requests, send, finished } = yield* setup();
      const input = { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "run" };
      let client = opened;
      const ready = yield* Deferred.make<void>();
      const late = yield* Deferred.make<void>();
      yield* service.subscribe(handle, caller).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            client = applyNotebookEvent(client, event)!;
            if (event.type === "snapshot") yield* Deferred.succeed(ready, undefined);
            if (
              event.type === "changed" &&
              event.cellId === "a" &&
              event.patches.some((p) => p.type === "append" || p.type === "stream")
            )
              yield* Deferred.succeed(late, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      const runId = yield* service.execute(input, caller);
      expect(yield* service.execute(input, caller)).toBe(runId);
      const first = yield* Queue.take(requests);
      yield* send("unrelated", "stream", { name: "stdout", text: "ignore" });
      yield* send(first.id, "execute_reply", { status: "ok" });
      yield* send(first.id, "status", { execution_state: "idle" });
      yield* finished(runId);
      const next = yield* service.snapshot(handle, caller);
      const runB = yield* service.execute(
        { ...handle, revision: next.revision, cellIds: ["b"], requestId: "run-b" },
        caller,
      );
      const second = yield* Queue.take(requests);
      yield* send(first.id, "stream", { name: "stdout", text: "late" });
      yield* Deferred.await(late);
      expect(client.runId).toBe(runB);
      expect(client.executions.a?.runId).toBe(runId);
      yield* service.interrupt(
        { ...handle, generation: client.generation, runId: client.runId! },
        caller,
      );
      yield* send(second.id, "status", { execution_state: "idle" });
      yield* send(second.id, "execute_reply", { status: "ok" });
      yield* finished(runB);
      const result = yield* service.snapshot(handle, caller);
      expect(result.outcome).toBe("aborted");
      expect((result.document.cells as Array<{ outputs: unknown[] }>)[0]?.outputs).toEqual([
        { output_type: "stream", name: "stdout", text: "late" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "interrupt cancels undispatched cells; restart and shutdown fence stale generations",
  () =>
    Effect.gen(function* () {
      const { service, opened, handle, requests, controls, send, finished } = yield* setup();
      const runId = yield* service.execute(
        { ...handle, revision: opened.revision, cellIds: ["a", "b"], requestId: "run" },
        caller,
      );
      const first = yield* Queue.take(requests);
      const generation = (yield* service.snapshot(handle, caller)).generation;
      yield* send(first.id, "display_data", {
        data: { "text/plain": "generation-one" },
        metadata: {},
        transient: { display_id: "shared" },
      });
      yield* service.interrupt({ ...handle, generation, runId }, caller);
      yield* send(first.id, "execute_reply", { status: "error" });
      yield* send(first.id, "status", { execution_state: "idle" });
      yield* finished(runId);
      expect(yield* Queue.size(requests)).toBe(0);
      expect((yield* service.snapshot(handle, caller)).outcome).toBe("aborted");
      yield* service.restart({ ...handle, generation }, caller);
      expect(
        yield* service.shutdown({ ...handle, generation }, caller).pipe(Effect.flip),
      ).toMatchObject({ reason: "stale-generation" });
      const secondSnapshot = yield* service.snapshot(handle, caller);
      const runB = yield* service.execute(
        {
          ...handle,
          revision: secondSnapshot.revision,
          cellIds: ["b"],
          requestId: "after-restart",
        },
        caller,
      );
      const b = yield* Queue.take(requests);
      yield* send(b.id, "display_data", {
        data: { "text/plain": "generation-two" },
        metadata: {},
        transient: { display_id: "shared" },
      });
      yield* send(b.id, "update_display_data", {
        data: { "text/plain": "updated-two" },
        metadata: {},
        transient: { display_id: "shared" },
      });
      yield* send(b.id, "execute_reply", { status: "ok" });
      yield* send(b.id, "status", { execution_state: "idle" });
      yield* finished(runB);
      expect(
        (
          (yield* service.snapshot(handle, caller)).document.cells as Array<{ outputs: unknown[] }>
        )[0]?.outputs,
      ).toEqual([
        { output_type: "display_data", data: { "text/plain": "generation-one" }, metadata: {} },
      ]);
      yield* service.shutdown({ ...handle, generation: generation + 1 }, caller);
      const thirdSnapshot = yield* service.snapshot(handle, caller);
      const runC = yield* service.execute(
        {
          ...handle,
          revision: thirdSnapshot.revision,
          cellIds: ["b"],
          requestId: "after-shutdown",
        },
        caller,
      );
      const c = yield* Queue.take(requests);
      yield* send(c.id, "display_data", {
        data: { "text/plain": "generation-three" },
        metadata: {},
        transient: { display_id: "shared" },
      });
      yield* send(c.id, "update_display_data", {
        data: { "text/plain": "updated-three" },
        metadata: {},
        transient: { display_id: "shared" },
      });
      yield* send(c.id, "execute_reply", { status: "ok" });
      yield* send(c.id, "status", { execution_state: "idle" });
      yield* finished(runC);
      const final = yield* service.snapshot(handle, caller);
      expect((final.document.cells as Array<{ outputs: unknown[] }>)[0]?.outputs).toEqual([
        { output_type: "display_data", data: { "text/plain": "generation-one" }, metadata: {} },
      ]);
      expect(final.executions.a?.generation).toBe(1);
      expect(controls).toEqual(["interrupt", "restart", "shutdown"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "enforces read and execution grants, handle ownership, and canonical path containment",
  () =>
    Effect.gen(function* () {
      const { service, opened, handle, root, fs } = yield* setup();
      expect(yield* service.snapshot(handle, { scopes: [] }).pipe(Effect.flip)).toMatchObject({
        reason: "permission-denied",
      });
      expect(
        yield* service
          .execute(
            { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "no" },
            { scopes: ["filesystem:read"] },
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "permission-denied" });
      expect(
        yield* service
          .snapshot({ ...handle, projectId: ProjectId.make("other") }, caller)
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "not-found" });
      const outside = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${outside}/escape.ipynb`, JSON.stringify(fixture));
      yield* fs.symlink(`${outside}/escape.ipynb`, `${root}/escape.ipynb`);
      expect(
        yield* service
          .open({ projectId: handle.projectId, relativePath: "escape.ipynb" }, caller)
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-path" });
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "serializes edits and saves, preserves conflicts and unknown JSON, and rejects path replacement",
  () =>
    Effect.gen(function* () {
      const { service, opened, handle, fs, root } = yield* setup();
      const edited = yield* service.edit(
        { ...handle, revision: opened.revision, document: { ...opened.document, extra: "draft" } },
        caller,
      );
      const results = yield* Effect.forEach(
        [1, 2],
        () =>
          service
            .save({ ...handle, revision: edited.revision, diskHash: opened.diskHash }, caller)
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
      const saved = yield* service.snapshot(handle, caller);
      expect(saved.savedRevision).toBe(saved.revision);
      expect(JSON.parse(yield* fs.readFileString(`${root}/test.ipynb`))).toMatchObject({
        unknown: "retain",
        extra: "draft",
        metadata: fixture.metadata,
      });
      yield* fs.writeFileString(
        `${root}/test.ipynb`,
        JSON.stringify({ ...fixture, external: true }),
      );
      expect(
        yield* service
          .save({ ...handle, revision: saved.revision, diskHash: saved.diskHash }, caller)
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "save-conflict" });
      expect((yield* service.snapshot(handle, caller)).document.extra).toBe("draft");
      expect(
        yield* service
          .edit(
            {
              ...handle,
              revision: saved.revision,
              document: {
                ...fixture,
                cells: Array.from({ length: 501 }, (_, i) => ({
                  ...fixture.cells[0],
                  id: String(i),
                })),
              },
            },
            caller,
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-document" });
      const reloadInput = { ...handle, revision: saved.revision, diskHash: saved.diskHash };
      expect(
        yield* service.reload(reloadInput, { scopes: ["filesystem:read"] }).pipe(Effect.flip),
      ).toMatchObject({ reason: "permission-denied" });
      expect(
        yield* service.reload({ ...reloadInput, revision: -1 }, caller).pipe(Effect.flip),
      ).toMatchObject({ reason: "stale-revision" });
      const reloaded = yield* service.reload(reloadInput, caller);
      expect(reloaded.document.extra).toBeUndefined();
      expect(reloaded.document.external).toBe(true);
      expect(reloaded.savedRevision).toBe(reloaded.revision);
      expect(reloaded.executions).toEqual({});
      expect(yield* fs.readFileString(`${root}/test.ipynb`)).toBe(
        JSON.stringify({ ...fixture, external: true }),
      );
      const older = JSON.stringify({
        ...fixture,
        nbformat_minor: 4,
        cells: fixture.cells.map(({ id: _id, ...cell }) => cell),
      });
      yield* fs.writeFileString(`${root}/test.ipynb`, older);
      const normalized = yield* service.reload(
        { ...handle, revision: reloaded.revision, diskHash: reloaded.diskHash },
        caller,
      );
      expect(normalized.revision).toBe(normalized.savedRevision + 1);
      expect(yield* fs.readFileString(`${root}/test.ipynb`)).toBe(older);
      const outside = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${outside}/other.ipynb`, JSON.stringify(fixture));
      yield* fs.remove(`${root}/test.ipynb`);
      yield* fs.symlink(`${outside}/other.ipynb`, `${root}/test.ipynb`);
      expect(
        yield* service
          .save({ ...handle, revision: saved.revision, diskHash: saved.diskHash }, caller)
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-path" });
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("viewer leases, disconnect grace and headless runs respect active execution", () =>
  Effect.gen(function* () {
    const { service, opened, handle, requests, send, finished, controls } = yield* setup();
    yield* service.acquire({ ...handle, leaseId: "A" }, caller);
    yield* service.acquire({ ...handle, leaseId: "B" }, caller);
    const runId = yield* service.execute(
      { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "lifecycle" },
      caller,
    );
    const request = yield* Queue.take(requests);
    yield* service.close({ ...handle, leaseId: "A" }, caller);
    yield* TestClock.adjust("20 minutes");
    expect(controls).toEqual([]);
    yield* send(request.id, "execute_reply", { status: "ok" });
    yield* send(request.id, "status", { execution_state: "idle" });
    yield* finished(runId);
    yield* TestClock.adjust(1);
    expect((yield* service.snapshot(handle, caller)).kernel).toBe("stopped");
    const current = yield* service.snapshot(handle, caller);
    const runB = yield* service.execute(
      { ...handle, revision: current.revision, cellIds: ["b"], requestId: "headless" },
      caller,
    );
    const b = yield* Queue.take(requests);
    yield* service.close({ ...handle, leaseId: "B" }, caller);
    yield* send(b.id, "execute_reply", { status: "ok" });
    yield* send(b.id, "status", { execution_state: "idle" });
    yield* finished(runB);
    yield* TestClock.adjust("59 seconds");
    expect(controls).toEqual(["shutdown"]);
    yield* TestClock.adjust("1 second");
    expect(controls).toEqual(["shutdown", "shutdown"]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "opening never creates a kernel, environment failure never dispatches code, and create never clobbers",
  () =>
    Effect.gen(function* () {
      let created = 0;
      const { service, handle, opened, requests, controls, fs, root } = yield* setup({
        create: Effect.fn("Verify.create")(() =>
          Effect.sync(() => {
            created++;
            return "owned";
          }),
        ),
        verify: Effect.fn("Verify.mismatch")(() =>
          Effect.fail(new NotebookError({ reason: "unavailable" })),
        ),
      });
      expect(created).toBe(0);
      expect(opened.environment).toBe("unverified");
      expect(
        yield* service
          .execute(
            { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "mismatch" },
            caller,
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "unavailable" });
      expect(yield* Queue.size(requests)).toBe(0);
      const unknown = yield* service.snapshot(handle, caller);
      expect(unknown.outcome).toBe("unknown");
      yield* service.shutdown({ ...handle, generation: unknown.generation }, caller);
      expect(controls).toEqual(["shutdown"]);
      const createdNotebook = yield* service.create(
        { projectId: handle.projectId, relativePath: "new.ipynb", document: fixture },
        caller,
      );
      expect(createdNotebook.savedRevision).toBe(0);
      expect(
        yield* service
          .create(
            {
              projectId: handle.projectId,
              relativePath: "new.ipynb",
              document: { ...fixture, changed: true },
            },
            caller,
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "save-conflict" });
      expect(JSON.parse(yield* fs.readFileString(`${root}/new.ipynb`))).not.toHaveProperty(
        "changed",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "a reconnect replaces the same viewer lease and explicit close releases its live subscription",
  () =>
    Effect.gen(function* () {
      const { service, opened, handle, requests, send, finished, controls } = yield* setup();
      const lease = { ...handle, leaseId: "viewer" };
      const readyA = yield* Deferred.make<void>();
      const readyB = yield* Deferred.make<void>();
      const observe = (ready: Deferred.Deferred<void>) =>
        service.subscribe(lease, caller).pipe(
          Stream.tap((event) =>
            event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const a = yield* observe(readyA);
      yield* Deferred.await(readyA);
      const b = yield* observe(readyB);
      yield* Deferred.await(readyB);
      yield* Fiber.interrupt(a);
      const runId = yield* service.execute(
        { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "reconnect" },
        caller,
      );
      const request = yield* Queue.take(requests);
      yield* send(request.id, "execute_reply", { status: "ok" });
      yield* send(request.id, "status", { execution_state: "idle" });
      yield* finished(runId);
      yield* TestClock.adjust("60 seconds");
      expect(controls).toEqual([]);
      yield* service.close(lease, caller);
      yield* TestClock.adjust(0);
      expect(controls).toEqual(["shutdown"]);
      yield* Fiber.interrupt(b);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "concurrent first opens share a canonical owner and its Busy guard across project aliases",
  () =>
    Effect.gen(function* () {
      const arrived = yield* Queue.unbounded<void>();
      const release = yield* Deferred.make<void>();
      let block = false;
      const { service, handle, fs, root, sql, requests } = yield* setup({
        listSpecs: () => Effect.succeed(["python3"]),
        probe: Effect.fn("Concurrent.probe")(() =>
          block
            ? Queue.offer(arrived, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
      });
      const alias = ProjectId.make("concurrent-alias");
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${alias}, 'Alias', ${root}, '[]', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z')`;
      yield* fs.writeFileString(`${root}/concurrent.ipynb`, JSON.stringify(fixture));
      block = true;
      const first = yield* service
        .open({ projectId: handle.projectId, relativePath: "concurrent.ipynb" }, caller)
        .pipe(Effect.forkScoped);
      const second = yield* service
        .open({ projectId: alias, relativePath: "concurrent.ipynb" }, caller)
        .pipe(Effect.forkScoped);
      yield* Queue.take(arrived);
      yield* Queue.take(arrived);
      yield* Deferred.succeed(release, undefined);
      const a = yield* Fiber.join(first);
      const b = yield* Fiber.join(second);
      expect(a.handle).toBe(b.handle);
      const target = { ...handle, handle: a.handle };
      yield* service.execute(
        { ...target, revision: a.revision, cellIds: ["a"], requestId: "first-owner" },
        caller,
      );
      yield* Queue.take(requests);
      expect(
        yield* service
          .execute(
            {
              projectId: alias,
              handle: b.handle,
              revision: b.revision,
              cellIds: ["a"],
              requestId: "second-owner",
            },
            caller,
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "busy" });
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("concurrent first opens cannot exceed the retained document cap", () =>
  Effect.gen(function* () {
    const arrived = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<void>();
    let block = false;
    const { service, handle, fs, root } = yield* setup({
      listSpecs: () => Effect.succeed(["python3"]),
      probe: Effect.fn("Capacity.probe")(() =>
        block
          ? Queue.offer(arrived, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      ),
    });
    for (let i = 0; i < 14; i++) {
      yield* fs.writeFileString(`${root}/${i}.ipynb`, JSON.stringify(fixture));
      yield* service.open({ projectId: handle.projectId, relativePath: `${i}.ipynb` }, caller);
    }
    yield* fs.writeFileString(`${root}/last-a.ipynb`, JSON.stringify(fixture));
    yield* fs.writeFileString(`${root}/last-b.ipynb`, JSON.stringify(fixture));
    block = true;
    const a = yield* service
      .open({ projectId: handle.projectId, relativePath: "last-a.ipynb" }, caller)
      .pipe(Effect.result, Effect.forkScoped);
    const b = yield* service
      .open({ projectId: handle.projectId, relativePath: "last-b.ipynb" }, caller)
      .pipe(Effect.result, Effect.forkScoped);
    yield* Queue.take(arrived);
    yield* Queue.take(arrived);
    yield* Deferred.succeed(release, undefined);
    const results = [yield* Fiber.join(a), yield* Fiber.join(b)];
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
    expect(results.find((result) => result._tag === "Failure")).toMatchObject({
      failure: { reason: "output-limit" },
    });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "channel loss protects uncertain execution from detach and idle cleanup until explicit recovery",
  () =>
    Effect.gen(function* () {
      const { service, opened, handle, requests, controls, messages, finished } = yield* setup();
      const ready = yield* Deferred.make<void>();
      const observer = yield* service.subscribe({ ...handle, leaseId: "viewer" }, caller).pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      const runId = yield* service.execute(
        { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "unknown-active" },
        caller,
      );
      yield* Queue.take(requests);
      yield* Queue.fail(messages, new NotebookError({ reason: "disconnected" }));
      yield* finished(runId);
      yield* Fiber.interrupt(observer);
      yield* TestClock.adjust("60 minutes");
      expect(controls).toEqual([]);
      const current = yield* service.snapshot(handle, caller);
      expect(current.outcome).toBe("unknown");
      expect(current.idleDeadline).toBeNull();
      yield* service.shutdown({ ...handle, generation: current.generation }, caller);
      expect(controls).toEqual(["shutdown"]);
      expect((yield* service.snapshot(handle, caller)).kernel).toBe("stopped");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "cancelling a committed save during temporary cleanup acknowledges the committed disk hash",
  () =>
    Effect.gen(function* () {
      const cleaning = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { service, opened, handle, fs, root } = yield* setup(
        {},
        {
          fileSystem: (fs) => ({
            ...fs,
            remove: (path, options) =>
              path.includes(".t3-notebook-")
                ? Deferred.succeed(cleaning, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(fs.remove(path, options)),
                  )
                : fs.remove(path, options),
          }),
        },
      );
      const edited = yield* service.edit(
        { ...handle, revision: opened.revision, document: { ...opened.document, committed: true } },
        caller,
      );
      const saving = yield* service
        .save({ ...handle, revision: edited.revision, diskHash: opened.diskHash }, caller)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(cleaning);
      saving.interruptUnsafe();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(saving);
      const disk = yield* fs.readFileString(`${root}/test.ipynb`);
      const current = yield* service.snapshot(handle, caller);
      expect(current.diskHash).toBe(NodeCrypto.createHash("sha256").update(disk).digest("hex"));
      expect(current.savedRevision).toBe(edited.revision);
      yield* service.save(
        { ...handle, revision: current.revision, diskHash: current.diskHash },
        caller,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "subscription snapshot handoff stays ordered while an old cleanup timer is cancelling",
  () =>
    Effect.gen(function* () {
      const deleting = yield* Deferred.make<void>();
      const cancelling = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let controls = 0;
      const { service, opened, handle, requests, messages, send, finished } = yield* setup({
        control: Effect.fn("Timer.control")(() =>
          ++controls === 1
            ? Deferred.succeed(deleting, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Deferred.succeed(cancelling, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                ),
              )
            : Effect.void,
        ),
      });
      const runId = yield* service.execute(
        { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "handoff" },
        caller,
      );
      const request = yield* Queue.take(requests);
      yield* send(request.id, "execute_reply", { status: "ok" });
      yield* send(request.id, "status", { execution_state: "idle" });
      yield* finished(runId);
      const monitorReady = yield* Deferred.make<void>();
      const unknown = yield* Deferred.make<void>();
      const monitor = yield* service.subscribe({ ...handle, leaseId: "monitor" }, caller).pipe(
        Stream.runForEach((event) =>
          event.type === "snapshot"
            ? Deferred.succeed(monitorReady, undefined)
            : event.type === "changed" && event.outcome === "unknown"
              ? Deferred.succeed(unknown, undefined)
              : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(monitorReady);
      yield* service.close({ ...handle, leaseId: "monitor" }, caller);
      const advancing = yield* TestClock.adjust(0).pipe(Effect.forkScoped);
      yield* Deferred.await(deleting);
      const events = yield* Queue.unbounded<import("@t3tools/contracts").NotebookEvent>();
      const subscriber = yield* service.subscribe(handle, caller).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      yield* Deferred.await(cancelling);
      yield* Queue.fail(messages, new NotebookError({ reason: "disconnected" }));
      yield* Deferred.await(unknown);
      yield* Deferred.succeed(release, undefined);
      const initial = yield* Queue.take(events);
      const current = yield* service.snapshot(handle, caller);
      yield* service.shutdown({ ...handle, generation: current.generation }, caller);
      const next = yield* Queue.take(events);
      expect(initial.type).toBe("snapshot");
      expect(next.type).toBe("changed");
      if (initial.type === "snapshot" && next.type === "changed")
        expect(next.sequence).toBeGreaterThan(initial.snapshot.sequence);
      yield* Fiber.interrupt(subscriber);
      yield* Fiber.interrupt(monitor);
      yield* Fiber.join(advancing);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("rejected subscriptions do not retain queues in subsequent output fanout", () =>
  Effect.gen(function* () {
    const { service, handle, opened, requests, send, finished } = yield* setup();
    const full = Array.from({ length: 128 }, (_, i) => `lease-${i}`);
    for (const leaseId of full) yield* service.acquire({ ...handle, leaseId }, caller);
    for (const leaseId of ["", "x".repeat(129), "over-capacity", "", "over-capacity"]) {
      expect(
        yield* service.subscribe({ ...handle, leaseId }, caller).pipe(Stream.runHead, Effect.flip),
      ).toMatchObject({ reason: "output-limit" });
    }
    yield* service.close({ ...handle, leaseId: full[0]! }, caller);
    const offers = vi.mocked(Queue.offerUnsafe);
    offers.mockClear();
    const runId = yield* service.execute(
      { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "no-abandoned-observers" },
      caller,
    );
    const request = yield* Queue.take(requests);
    yield* send(request.id, "execute_reply", { status: "ok" });
    yield* send(request.id, "status", { execution_state: "idle" });
    yield* finished(runId);
    expect(new Set(offers.mock.calls.map(([queue]) => queue)).size).toBeLessThanOrEqual(1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "resolves a project's registered thread worktree and revalidates its binding and containment",
  () =>
    Effect.gen(function* () {
      const worktrees: string[] = [];
      const verified: string[] = [];
      const { service, handle, root, fs, sql, requests } = yield* setup(
        {
          verify: Effect.fn("Fake.verify")((_endpoint, _id, cwd) =>
            Effect.sync(() => {
              verified.push(cwd);
            }),
          ),
        },
        { worktrees },
      );
      const workspace = yield* fs.makeTempDirectoryScoped();
      const alias = `${root}/worktree-alias`;
      yield* fs.symlink(workspace, alias);
      worktrees.push(workspace);
      const threadId = ThreadId.make("worktree-thread");
      const binding = { projectId: handle.projectId, threadId, relativePath: "test.ipynb" };
      yield* fs.writeFileString(`${workspace}/test.ipynb`, JSON.stringify(fixture));
      const payload = JSON.stringify({ worktreePath: alias });
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, ${handle.projectId}, 'Worktree', 'codex', 'full-access', 'default', '2026-10-28', '2026-10-28', ${payload})`;
      const tree = yield* service.open(binding, caller);
      const artifact = yield* service.open({ ...binding, relativePath: "./test.ipynb" }, caller);
      expect(artifact.handle).toBe(tree.handle);
      expect(tree.handle).not.toBe(handle.handle);
      expect(yield* Queue.size(requests)).toBe(0);
      expect(verified).toEqual([]);
      const target = { projectId: handle.projectId, threadId, handle: tree.handle };
      yield* service.execute(
        { ...target, revision: tree.revision, cellIds: ["a"], requestId: "worktree-run" },
        caller,
      );
      yield* Queue.take(requests);
      expect(verified).toEqual([workspace]);
      const current = yield* service.snapshot(target, caller);
      yield* service.shutdown({ ...target, generation: current.generation }, caller);
      expect(
        yield* service
          .open({ ...binding, projectId: ProjectId.make("wrong") }, caller)
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "not-found" });
      yield* fs.symlink(`${root}/test.ipynb`, `${workspace}/escape.ipynb`);
      expect(
        yield* service.open({ ...binding, relativePath: "escape.ipynb" }, caller).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-path" });
      worktrees.length = 0;
      expect(yield* service.snapshot(target, caller).pipe(Effect.flip)).toMatchObject({
        reason: "invalid-path",
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "headless scheduled callers create, edit, run, read, save and recover through the toolkit",
  () =>
    Effect.gen(function* () {
      const { service, root, fs, handle, sql, requests, send } = yield* setup();
      const threadId = ThreadId.make("scheduled-notebook");
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, ${handle.projectId}, 'Scheduled', 'codex', 'full-access', 'default', '2026-10-28', '2026-10-28', '{"worktreePath":null}')`;
      const shell = {
        ...liveThreadShell(threadId),
        projectId: handle.projectId,
        createdBy: "system" as const,
      };
      const dependencies = Layer.mergeAll(
        Layer.succeed(NotebookService.NotebookService, service),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
        }),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "scheduled",
          thread: {
            threadId,
            providerSessionId: "scheduled-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
      );
      const toolkit = yield* NotebookToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(NotebookHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const created = yield* toolkit
        .handle("notebook_create", { relativePath: "headless.ipynb", document: fixture })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((rows) => decodeSnapshot(rows.at(-1)!.result)),
          Effect.provide(dependencies),
        );
      const edited = yield* toolkit
        .handle("notebook_edit_cells", {
          handle: created.handle,
          revision: created.revision,
          operations: [
            { type: "update", cellId: "a", source: "print(84)" },
            { type: "move", cellId: "b", index: 0 },
            {
              type: "insert",
              index: 2,
              cell: { id: "notes", cell_type: "markdown", source: "Result", metadata: {} },
            },
            { type: "delete", cellId: "notes" },
          ],
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((rows) => decodeSnapshot(rows.at(-1)!.result)),
          Effect.provide(dependencies),
        );
      const result = yield* toolkit
        .handle("notebook_run", {
          handle: edited.handle,
          revision: edited.revision,
          cellIds: ["a"],
          requestId: "headless",
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((rows) => decodeRun(rows.at(-1)!.result)),
          Effect.provide(dependencies),
        );
      const request = yield* Queue.take(requests);
      expect(request.code).toBe("print(84)");
      yield* send(request.id, "stream", { name: "stdout", text: "84\n" });
      yield* send(request.id, "execute_reply", { status: "ok" });
      yield* send(request.id, "status", { execution_state: "idle" });
      const target = { projectId: handle.projectId, threadId, handle: edited.handle };
      yield* service.subscribe(target, caller).pipe(
        Stream.mapEffect(() => service.snapshot(target, caller)),
        Stream.filter((snapshot) => snapshot.runId === result.runId && snapshot.outcome === "ok"),
        Stream.runHead,
      );
      const outputs = yield* toolkit
        .handle("notebook_read_outputs", {
          handle: edited.handle,
          cellId: "a",
          cursor: 0,
          byteLimit: 1024,
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((rows) => rows.at(-1)!.result),
          Effect.provide(dependencies),
        );
      expect(outputs).toMatchObject({
        outcome: "ok",
        runId: result.runId,
        outputs: [{ text: "84\n" }],
        truncated: false,
      });
      const current = yield* service.snapshot(target, caller);
      const saved = yield* toolkit
        .handle("notebook_save", {
          handle: edited.handle,
          revision: current.revision,
          diskHash: current.diskHash,
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((rows) => decodeSnapshot(rows.at(-1)!.result)),
          Effect.provide(dependencies),
        );
      const disk = parseNotebook(yield* fs.readFileString(root + "/headless.ipynb")).document;
      expect(disk.metadata).toEqual(fixture.metadata);
      expect(disk.cells.map((cell) => cell.id)).toEqual(["b", "a"]);
      expect(disk.cells[1]?.outputs).toMatchObject([{ text: "84\n" }]);
      expect(saved.savedRevision).toBe(saved.revision);
      const kernels = yield* toolkit.handle("notebook_list_kernels", { cursor: 0, limit: 10 }).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((rows) => decodeKernels(rows.at(-1)!.result)),
        Effect.provide(dependencies),
      );
      expect(kernels).toMatchObject({
        specs: ["python3"],
        kernels: [{ handle: edited.handle, relativePath: "headless.ipynb" }],
      });
      yield* toolkit
        .handle("notebook_restart", { handle: edited.handle, generation: current.generation })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((rows) => rows.at(-1)!.result),
          Effect.provide(dependencies),
        );
      const restarted = yield* service.snapshot(target, caller);
      yield* toolkit
        .handle("notebook_shutdown", { handle: edited.handle, generation: restarted.generation })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((rows) => rows.at(-1)!.result),
          Effect.provide(dependencies),
        );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([
  ["approval-required", "default", true, "normal"],
  ["auto-accept-edits", "default", true, "normal"],
  ["full-access", "plan", true, "normal"],
  ["full-access", "default", false, "normal"],
  ["full-access", "default", true, "read-only-client"],
  ["full-access", "default", true, "missing-capability"],
  ["full-access", "default", true, "wrong-provider"],
] as const)(
  "refuses notebook execution for runtime %s interaction %s live %s",
  ([runtimeMode, interactionMode, live, condition]) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("caller");
      const shell = liveThreadShell(threadId, {
        runtimeMode,
        interactionMode,
        ...(live ? {} : { activeRunId: null }),
      });
      const dependencies = Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
        }),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "auth",
          thread: {
            threadId,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make(
              condition === "wrong-provider" ? "claudeAgent" : "codex",
            ),
          },
          client:
            condition === "read-only-client"
              ? { sessionId: "read-only", label: "Read only", access: "read-only" }
              : undefined,
          issuedAt: 0,
          capabilities: new Set(
            condition === "missing-capability" ? [] : ["orchestration" as const],
          ),
        }),
      );
      const toolkit = yield* NotebookToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(NotebookHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const result = yield* toolkit
        .handle("notebook_run", {
          handle: "unreachable",
          revision: 0,
          all: true,
          requestId: "denied",
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((rows) => rows.at(-1)!.result),
          Effect.provide(dependencies),
        );
      expect(result).toMatchObject({
        code: live && condition !== "wrong-provider" ? "capability_denied" : "parent_not_active",
      });
    }),
);

it.effect("output waits return the changed service sequence", () =>
  Effect.gen(function* () {
    const { service, opened, handle } = yield* setup();
    const waiting = yield* service
      .readOutputs(
        { ...handle, cellId: "a", cursor: 0, byteLimit: 1024, afterSequence: opened.sequence },
        caller,
      )
      .pipe(Effect.forkChild);
    const edited = yield* service.editCells(
      {
        ...handle,
        revision: opened.revision,
        operations: [{ type: "update", cellId: "a", source: "print(85)" }],
      },
      caller,
    );
    const changed = yield* Fiber.join(waiting);
    expect(changed.sequence).toBe(edited.sequence);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "pages merged oversized outputs losslessly through the toolkit, including saved notebooks",
  () =>
    Effect.gen(function* () {
      const { service, handle, opened, sql, requests, send, finished, root, fs } = yield* setup();
      const threadId = ThreadId.make("bounded-output");
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, ${handle.projectId}, 'Bounded', 'codex', 'full-access', 'default', '2026-10-28', '2026-10-28', '{"worktreePath":null}')`;
      const dependencies = Layer.mergeAll(
        Layer.succeed(NotebookService.NotebookService, service),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({ ...liveThreadShell(threadId), projectId: handle.projectId }),
        }),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "bounded-output",
          thread: {
            threadId,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
      );
      const toolkit = yield* NotebookToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(NotebookHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const runId = yield* service.execute(
        { ...handle, revision: opened.revision, cellIds: ["a"], requestId: "merged-output" },
        caller,
      );
      const request = yield* Queue.take(requests);
      const chunk = "x".repeat(600000);
      yield* send(request.id, "stream", { name: "stdout", text: chunk });
      yield* send(request.id, "stream", { name: "stdout", text: chunk });
      yield* send(request.id, "stream", { name: "stderr", text: "tail" });
      yield* send(request.id, "execute_reply", { status: "ok" });
      yield* send(request.id, "status", { execution_state: "idle" });
      yield* finished(runId);
      const current = yield* service.snapshot(handle, caller);
      yield* service.save(
        { ...handle, revision: current.revision, diskHash: current.diskHash },
        caller,
      );
      const saved = parseNotebook(yield* fs.readFileString(root + "/test.ipynb")).document;
      expect(saved.cells[0]?.outputs?.[0]?.text).toBe(chunk + chunk);
      const read = (cursor: number, offset = 0, notebookHandle = opened.handle) =>
        toolkit
          .handle("notebook_read_outputs", {
            handle: notebookHandle,
            cellId: "a",
            cursor,
            offset,
            byteLimit: 1048576,
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map(
              (rows) =>
                rows.at(-1)!.result as {
                  outputs: Record<string, unknown>[];
                  fragment: { json: string; offset: number } | null;
                  nextCursor: number | null;
                  nextOffset: number;
                  sequence: number;
                },
            ),
            Effect.provide(dependencies),
          );
      const first = yield* read(0);
      expect(first).toMatchObject({
        outputs: [],
        fragment: { offset: 0 },
        nextCursor: 0,
        outcome: "ok",
        runId,
        truncated: false,
        execution: { runId },
      });
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(1048576);
      expect(first.nextOffset).toBeGreaterThan(0);
      const second = yield* read(first.nextCursor!, first.nextOffset);
      expect(second).toMatchObject({
        outputs: [],
        fragment: { offset: first.nextOffset },
        nextCursor: 1,
        nextOffset: 0,
        outcome: "ok",
        truncated: false,
      });
      expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(1048576);
      expect(JSON.parse(first.fragment!.json + second.fragment!.json)).toEqual(
        saved.cells[0]?.outputs?.[0],
      );
      const last = yield* read(second.nextCursor!, second.nextOffset);
      expect(last).toMatchObject({
        outputs: [{ name: "stderr", text: "tail" }],
        fragment: null,
        nextCursor: null,
        outcome: "ok",
        truncated: false,
      });
      expect(last.sequence).toBe(first.sequence);
      yield* fs.writeFileString(root + "/saved.ipynb", JSON.stringify(saved));
      const loaded = yield* toolkit.handle("notebook_open", { relativePath: "saved.ipynb" }).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((rows) => decodeSnapshot(rows.at(-1)!.result)),
        Effect.provide(dependencies),
      );
      const savedFirst = yield* read(0, 0, loaded.handle);
      const savedSecond = yield* read(savedFirst.nextCursor!, savedFirst.nextOffset, loaded.handle);
      expect(savedFirst).toMatchObject({ outcome: "none", execution: null, truncated: false });
      expect(Buffer.byteLength(JSON.stringify(savedFirst))).toBeLessThanOrEqual(1048576);
      expect(Buffer.byteLength(JSON.stringify(savedSecond))).toBeLessThanOrEqual(1048576);
      expect(JSON.parse(savedFirst.fragment!.json + savedSecond.fragment!.json)).toEqual(
        saved.cells[0]?.outputs?.[0],
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
