import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NotebookError, ProjectId, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
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
import { parseNotebook } from "./notebookDocument.ts";

const caller = { scopes: ["filesystem:read", "terminal:operate"] satisfies AuthEnvironmentScope[] };
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
const setup = Effect.gen(function* () {
  const messages = yield* Queue.unbounded<JupyterTransport.Message, NotebookError>();
  const requests = yield* Queue.unbounded<{ id: string; code: string }>();
  const controls: string[] = [];
  const transport = JupyterTransport.JupyterTransport.of({
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
      Layer.provide(Layer.succeed(JupyterTransport.JupyterTransport, transport)),
      Layer.provide(
        Layer.succeed(NotebookService.NotebookConfiguration, {
          endpoint: Effect.fn("Fake.endpoint")(() =>
            Effect.succeed({ url: "http://127.0.0.1:1", token: "test", kernelName: "python3" }),
          ),
        }),
      ),
      Layer.provide(Layer.succeedContext(context)),
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
  return { service, opened, handle, requests, controls, send, finished, root, fs, messages };
});
const layer = Layer.mergeAll(NodeServices.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect("slow observers receive an explicit resync instead of retaining every delta", () =>
  Effect.gen(function* () {
    const { service, opened, handle, requests, send, finished } = yield* setup;
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
    const { service, opened, handle, requests, messages, finished } = yield* setup;
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
      const { service, opened, handle, requests, send, finished } = yield* setup;
      const input = { ...handle, revision: opened.revision, cellIds: ["a", "b"], requestId: "run" };
      const runId = yield* service.execute(input, caller);
      expect(yield* service.execute(input, caller)).toBe(runId);
      const first = yield* Queue.take(requests);
      yield* send("unrelated", "stream", { name: "stdout", text: "ignore" });
      yield* send(first.id, "execute_reply", { status: "ok" });
      yield* send(first.id, "status", { execution_state: "idle" });
      const second = yield* Queue.take(requests);
      yield* send(first.id, "stream", { name: "stdout", text: "late" });
      yield* send(second.id, "status", { execution_state: "idle" });
      yield* send(second.id, "execute_reply", { status: "ok" });
      yield* finished(runId);
      const result = yield* service.snapshot(handle, caller);
      expect(result.outcome).toBe("ok");
      expect((result.document.cells as Array<{ outputs: unknown[] }>)[0]?.outputs).toEqual([
        { output_type: "stream", name: "stdout", text: "late" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "interrupt cancels undispatched cells; restart and shutdown fence stale generations",
  () =>
    Effect.gen(function* () {
      const { service, opened, handle, requests, controls, send, finished } = yield* setup;
      const runId = yield* service.execute(
        { ...handle, revision: opened.revision, cellIds: ["a", "b"], requestId: "run" },
        caller,
      );
      const first = yield* Queue.take(requests);
      const generation = (yield* service.snapshot(handle, caller)).generation;
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
      yield* service.shutdown({ ...handle, generation: generation + 1 }, caller);
      expect(controls).toEqual(["interrupt", "restart", "shutdown"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "enforces read and execution grants, handle ownership, and canonical path containment",
  () =>
    Effect.gen(function* () {
      const { service, opened, handle, root, fs } = yield* setup;
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
